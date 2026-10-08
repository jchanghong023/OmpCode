// omp 子代理侧信道：记录同一 ID 的生命周期、补读 transcript，并把事实投影到父会话。
import {
  ompSubagentSnapshotSchema,
  type OmpSubagentFrame,
  type OmpSubagentSnapshot,
} from "../domain/ompFrames.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpSessionProcess } from "./ports.js";
import { transcriptFromOmpEntries } from "../domain/coldHistory.js";

type Status = "running" | "success" | "failed" | "cancelled";
type RecordState = {
  agent: string;
  status: Status;
  summaryText: string;
  startedAt: number;
  transcriptText?: string;
  parentToolCallId?: string;
  observedProcessEpoch?: number;
};

/**
 * omp 子代理状态词 → 投影状态。
 * 修复（R1③）：live 词白名单收敛（真实核 lifecycle 只发 started，终态为 completed/failed/
 * aborted，executor.ts startedPayload/settledPayload；live 进度快照为 running/pending，
 * rpc-subagents.ts），其余一律收敛到终态——未来 omp 新增终态词（frames schema 已放宽为
 * string）时绝不误标 running 形成永挂运行卡片，本映射是未知词的活防线。durable 终态
 * parked=已完成驻留、可 send_message 唤醒（rpc-project-subagents.buildFinishedSubagentRow）
 * 按 success；interrupted=崩溃中断、无完成事实按 cancelled；其余未知词与通道侧
 * （ompProjectChannel.projectSubagentStatusToLegacy default）一致收敛到 cancelled。
 */
function subagentStatus(status: string): Status {
  if (status === "started" || status === "pending" || status === "running" || status === "active") {
    return "running";
  }
  if (status === "completed" || status === "success" || status === "parked") return "success";
  if (status === "failed" || status === "error") return "failed";
  // aborted/cancelled/interrupted 及一切未知非 live 词：宁收敛到终态，绝不误标 running。
  return "cancelled";
}

export class OmpSubagentBridge {
  private readonly records = new Map<string, RecordState>();
  private readonly transcriptReads = new Set<string>();
  /** 修复（S6-5）：refresh 一次瞬时失败后置位；后续子代理帧触发可用性复评，成功后清除。 */
  private refreshFailed = false;
  /** 可用性复评单飞：帧风暴期间至多一个在途 refresh。 */
  private rechecking: Promise<void> | null = null;
  private observedProcess: OmpSessionProcess | null = null;
  private observedProcessEpoch = 0;

  constructor(
    private readonly projection: ConversationProjection,
    private readonly currentProcess: () => OmpSessionProcess | null,
    private readonly flush: () => void,
  ) {}

  /** 仅当前进程真正观察到的 lifecycle/快照可证明现在状态；历史投影不能提供该证明。 */
  observedSubagentStatus(id: string, process: OmpSessionProcess | null): Status | undefined {
    const record = this.records.get(id);
    if (
      !process ||
      this.currentProcess() !== process ||
      this.observedProcess !== process ||
      record?.observedProcessEpoch !== this.observedProcessEpoch
    )
      return undefined;
    return record.status;
  }

  handle(frame: OmpSubagentFrame): void {
    if (frame.type === "subagent_event") return;
    if (frame.type === "subagent_progress") {
      const { payload } = frame;
      const prior = this.records.get(payload.progress.id);
      // 生命周期终态是权威；晚到的 progress 不能让已结束子代理重新运行。
      const status =
        prior?.status && prior.status !== "running"
          ? prior.status
          : subagentStatus(payload.progress.status ?? "running");
      this.update(payload.progress.id, {
        agent: payload.agent,
        parentToolCallId: payload.parentToolCallId ?? prior?.parentToolCallId,
        status,
        summaryText: payload.assignment ?? payload.task ?? prior?.summaryText ?? payload.agent,
        startedAt: prior?.startedAt ?? Date.now(),
        transcriptText: prior?.transcriptText,
      });
      this.maybeRecheckAvailability();
      return;
    }
    const { payload } = frame;
    const prior = this.records.get(payload.id);
    const status = subagentStatus(payload.status);
    this.update(payload.id, {
      agent: payload.agent,
      parentToolCallId: payload.parentToolCallId ?? prior?.parentToolCallId,
      status,
      summaryText: payload.description ?? prior?.summaryText ?? payload.agent,
      startedAt: prior?.startedAt ?? Date.now(),
      transcriptText: prior?.transcriptText,
    });
    if (status !== "running") void this.readTranscript(payload.id);
    this.maybeRecheckAvailability();
  }

  async refresh(process: OmpSessionProcess): Promise<void> {
    // 新核 get_subagents 快照仅含运行中子代理（终态即从注册表删除，
    // oh-my-pi rpc-subagents.ts），无需 status 过滤；终态目录由投影持久行承载。
    const outcome = await process.send({ type: "get_subagents" }).catch(() => null);
    if (this.currentProcess() !== process) return;
    if (!outcome?.success) {
      this.refreshFailed = true;
      this.projection.setSubagentAvailability("unavailable");
      this.flush();
      return;
    }
    // 修复（S6-5）：复评成功把可用性翻回 ready——bootstrapProcess 只在进程启动时评一次
    // 可用性，此处仅在发生过 refresh 失败时介入，不覆盖启动时的订阅可用性判定。
    if (this.refreshFailed) {
      this.refreshFailed = false;
      this.projection.setSubagentAvailability("ready");
    }
    const data = outcome.data as { subagents?: unknown[] } | undefined;
    for (const raw of data?.subagents ?? []) {
      const parsed = ompSubagentSnapshotSchema.safeParse(raw);
      if (parsed.success) this.applySnapshot(parsed.data);
    }
  }

  /**
   * 修复（S6-5）：refresh 一次瞬时失败（get_subagents 失败→unavailable）此前被钉死到下次
   * 进程重启（唯一复评点 bootstrapProcess）。子代理帧（lifecycle/progress）是 omp 子代理面
   * 活跃的事实信号——收到帧说明订阅链路在工作，此时补一次 refresh 复评：成功翻回 ready 并
   * 重拉目录快照；仍失败保持 unavailable，等下一帧再试。单飞避免帧风暴打爆命令通道。
   */
  private maybeRecheckAvailability(): void {
    if (!this.refreshFailed) return;
    const process = this.currentProcess();
    if (!process || this.rechecking) return;
    this.rechecking = this.refresh(process)
      .catch(() => {})
      .finally(() => {
        this.rechecking = null;
      });
  }

  private applySnapshot(snapshot: OmpSubagentSnapshot): void {
    const prior = this.records.get(snapshot.id);
    // 生命周期终态是权威（S6-5 帧触发复评引入更多 refresh）：在途快照可能早于刚落地的
    // 终态帧，晚到快照不得把已结束子代理拉回 running（与 progress 路径同一守卫）。
    const status =
      prior?.status && prior.status !== "running" ? prior.status : subagentStatus(snapshot.status);
    this.update(snapshot.id, {
      agent: snapshot.agent,
      parentToolCallId: snapshot.parentToolCallId ?? prior?.parentToolCallId,
      status,
      summaryText:
        snapshot.description ??
        snapshot.assignment ??
        snapshot.task ??
        prior?.summaryText ??
        snapshot.agent,
      startedAt: prior?.startedAt ?? snapshot.lastUpdate ?? Date.now(),
      transcriptText: prior?.transcriptText,
    });
    if (status !== "running") void this.readTranscript(snapshot.id);
  }

  private update(id: string, record: RecordState): void {
    const process = this.currentProcess();
    if (this.observedProcess !== process) {
      this.observedProcess = process;
      this.observedProcessEpoch += 1;
    }
    this.records.set(id, { ...record, observedProcessEpoch: this.observedProcessEpoch });
    this.projection.upsertSubagent({ id, ...record });
    this.flush();
  }

  private async readTranscript(id: string): Promise<void> {
    const process = this.currentProcess();
    const prior = this.records.get(id);
    if (!process || !prior || prior.transcriptText || this.transcriptReads.has(id)) return;
    this.transcriptReads.add(id);
    try {
      const outcome = await process
        .send({ type: "get_subagent_messages", subagentId: id })
        .catch(() => null);
      if (this.currentProcess() !== process || !outcome?.success) return;
      const data = outcome.data as { messages?: unknown[] } | undefined;
      // 真实 IRC/custom 的 content 可以是字符串；按数组 filter 会在子代理结束时崩溃。
      // 复用冷历史文本转换，统一处理字符串/文本块与 custom.display，不执行原生 renderer。
      const transcriptText = transcriptFromOmpEntries(
        (Array.isArray(data?.messages) ? data.messages : []).map((message) => ({
          type: "message",
          message,
        })),
      );
      const current = this.records.get(id);
      if (current && transcriptText) this.update(id, { ...current, transcriptText });
    } finally {
      this.transcriptReads.delete(id);
    }
  }
}
