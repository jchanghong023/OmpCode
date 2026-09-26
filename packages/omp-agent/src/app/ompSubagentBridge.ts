// omp 子代理侧信道：记录同一 ID 的生命周期、补读 transcript，并把事实投影到父会话。
import {
  ompSubagentSnapshotSchema,
  type OmpSubagentFrame,
  type OmpSubagentSnapshot,
} from "../domain/ompFrames.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import type { OmpSessionProcess } from "./ports.js";

type Status = "running" | "success" | "failed" | "cancelled";
type RecordState = {
  agent: string;
  status: Status;
  summaryText: string;
  startedAt: number;
  transcriptText?: string;
};

function subagentStatus(status: string): Status {
  if (status === "completed" || status === "success") return "success";
  if (status === "failed" || status === "error") return "failed";
  if (status === "aborted" || status === "cancelled") return "cancelled";
  return "running";
}

export class OmpSubagentBridge {
  private readonly records = new Map<string, RecordState>();
  private readonly transcriptReads = new Set<string>();

  constructor(
    private readonly projection: ConversationProjection,
    private readonly currentProcess: () => OmpSessionProcess | null,
    private readonly flush: () => void,
  ) {}

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
        status,
        summaryText: payload.assignment ?? payload.task ?? prior?.summaryText ?? payload.agent,
        startedAt: prior?.startedAt ?? Date.now(),
        transcriptText: prior?.transcriptText,
      });
      return;
    }
    const { payload } = frame;
    const prior = this.records.get(payload.id);
    const status = subagentStatus(payload.status);
    this.update(payload.id, {
      agent: payload.agent,
      status,
      summaryText: payload.description ?? prior?.summaryText ?? payload.agent,
      startedAt: prior?.startedAt ?? Date.now(),
      transcriptText: prior?.transcriptText,
    });
    if (status !== "running") void this.readTranscript(payload.id);
  }

  async refresh(process: OmpSessionProcess): Promise<void> {
    const outcome = await process.send({ type: "get_subagents" }).catch(() => null);
    if (this.currentProcess() !== process) return;
    if (!outcome?.success) {
      this.projection.setSubagentAvailability("unavailable");
      this.flush();
      return;
    }
    const data = outcome.data as { subagents?: unknown[] } | undefined;
    for (const raw of data?.subagents ?? []) {
      const parsed = ompSubagentSnapshotSchema.safeParse(raw);
      if (parsed.success) this.applySnapshot(parsed.data);
    }
  }

  private applySnapshot(snapshot: OmpSubagentSnapshot): void {
    const prior = this.records.get(snapshot.id);
    const status = subagentStatus(snapshot.status);
    this.update(snapshot.id, {
      agent: snapshot.agent,
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
    this.records.set(id, record);
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
      const data = outcome.data as
        | { messages?: { role?: string; content?: { type?: string; text?: string }[] }[] }
        | undefined;
      const transcriptText = (data?.messages ?? [])
        .flatMap((message) =>
          (message.content ?? [])
            .filter((part) => part.type === "text" && part.text)
            .map((part) => `${message.role ?? "agent"}: ${part.text}`),
        )
        .join("\n\n")
        .slice(0, 20_000);
      const current = this.records.get(id);
      if (current && transcriptText) this.update(id, { ...current, transcriptText });
    } finally {
      this.transcriptReads.delete(id);
    }
  }
}
