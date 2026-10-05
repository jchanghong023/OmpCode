// OMP 项目模式的会话通道：实现 OmpSessionProcess 端口，把会话级命令补上 sessionId
// 后经共享项目进程发送，并接收按 sessionId 路由来的帧。帧分发逻辑与 OmpChildProcess
// 的会话帧分支同构：response 由进程层按「命令 id→sessionId」发送记录路由进入本通道
//（真实 omp 的 response 不带 sessionId 戳），这里用它登记本地命令异步收口 tracker。

import type {
  OmpCommandOutcome,
  OmpSessionProcess,
  OmpStateData,
  OmpSessionProcessHandlers,
} from "../app/ports.js";
import type {
  OmpCommandFrame,
  OmpConfigUpdateFrame,
  OmpSessionEventFrame,
} from "../domain/ompFrames.js";
import { ompStateDataSchema, type OmpSubagentFrame } from "../domain/ompFrames.js";
import { ompProjectSubagentSummarySchema } from "../domain/ompProjectFrames.js";
import { ompProjectCommandsToLegacy } from "../domain/ompCommands.js";
import { parseOmpContextReport, type OmpContextReport } from "../domain/ompContextReport.js";
import { dispatchOmpUiFrame } from "./ompUiFrames.js";
import { PromptResultTracker } from "../domain/promptResultTracker.js";
import { logger } from "./logger.js";
import type { OmpProjectProcess } from "./ompProjectProcess.js";

export class OmpProjectSessionChannel implements OmpSessionProcess {
  /** 端口事实：项目模式（prompt 默认 text、/xxx 走 execute_command 等）。 */
  readonly projectMode = true as const;
  ompSessionFile: string | null = null;
  subagentSubscriptionAvailable: boolean | undefined;
  forkSurface: boolean | undefined;
  private handlers: OmpSessionProcessHandlers;
  private readonly promptResults = new PromptResultTracker();
  private started = false;
  private detached = false;
  private stateData: OmpStateData | null = null;
  private contextRead: Promise<OmpContextReport | null> | null = null;
  private contextOutput: string[] | null = null;
  private contextResult: { id: string; resolve: (local: boolean) => void } | null = null;

  /** 通道是否仍绑定在存活的项目进程上（退出/关闭后为 false）。 */
  get alive(): boolean {
    return !this.detached;
  }

  constructor(
    private readonly process: OmpProjectProcess,
    readonly sessionId: string,
    handlers: OmpSessionProcessHandlers,
  ) {
    this.handlers = handlers;
    this.forkSurface = true;
  }

  /** 引擎重启后重新绑定处理器（帧路由仍按 sessionId 归属本通道）。 */
  refreshHandlers(handlers: OmpSessionProcessHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    if (this.started || this.detached) {
      return;
    }
    this.started = true;
    // 项目模式订阅按会话生效（§14.8）：events 级才能驱动只读详情实时更新。
    const subscription = await this.process
      .sendSessionCommand(
        this.sessionId,
        { type: "set_subagent_subscription", level: "events" },
        10_000,
      )
      .catch((error) => ({ success: false, error: String(error) }) as OmpCommandOutcome);
    this.subagentSubscriptionAvailable = subscription.success;
    if (!subscription.success) {
      logger.warn("omp 项目模式子代理订阅不可用", { error: subscription.error ?? "unknown" });
    }
  }

  async send(command: OmpCommandFrame): Promise<OmpCommandOutcome> {
    // /context 侧信道先收口再下发其它命令（与 OmpChildProcess 相同约束）。
    if (this.contextRead) await this.contextRead;
    const timeout = command.type === "get_state" ? 10_000 : undefined;
    const { id: _drop, ...payload } = command as Record<string, unknown>;
    const outcome = await this.process.sendSessionCommand(this.sessionId, payload, timeout);
    if (command.type === "get_subagents") {
      return this.normalizeSubagentsResponse(outcome);
    }
    if (command.type === "get_available_commands") {
      // 项目模式目录行是 RpcProjectCommandDescriptor；映射回旧命令形状供既有投影消费。
      return { ...outcome, data: ompProjectCommandsToLegacy(outcome.data) };
    }
    return outcome;
  }

  /** 项目模式 get_subagents 返回 items（RpcProjectSubagentSummary）；投影为旧 subagents 快照形状。 */
  private normalizeSubagentsResponse(outcome: OmpCommandOutcome): OmpCommandOutcome {
    if (!outcome.success) return outcome;
    const data = outcome.data as { items?: unknown[] } | undefined;
    if (!Array.isArray(data?.items)) return outcome;
    const subagents: unknown[] = [];
    for (const raw of data.items) {
      const parsed = ompProjectSubagentSummarySchema.safeParse(raw);
      if (!parsed.success) continue;
      subagents.push({
        id: parsed.data.subagentId,
        agent: parsed.data.name ?? parsed.data.subagentId,
        status: projectSubagentStatusToLegacy(parsed.data.status),
        description: parsed.data.description ?? parsed.data.task,
        task: parsed.data.task,
        sessionFile: parsed.data.sessionFile,
        parentToolCallId: parsed.data.parentToolCallId,
        // lastUpdate 透传（ISO → 毫秒）：OmpSubagentBridge.applySnapshot 在重启 bootstrap 无
        // prior.startedAt 时优先用它作为运行卡片 startedAt，避免每次刷新都回落 Date.now()。
        ...(parsed.data.lastUpdate
          ? { lastUpdate: Date.parse(parsed.data.lastUpdate) || undefined }
          : {}),
      });
    }
    return { ...outcome, data: { ...(data as object), subagents } };
  }

  respondUi(response: Parameters<OmpProjectProcess["respondUi"]>[0]): void {
    this.process.respondUi(response);
  }

  async refreshState(): Promise<OmpStateData | null> {
    const outcome = await this.process
      .sendSessionCommand(this.sessionId, { type: "get_state" }, 10_000)
      .catch(() => null);
    if (!outcome?.success) {
      return null;
    }
    const parsed = ompStateDataSchema.safeParse(outcome.data);
    if (!parsed.success) {
      return null;
    }
    this.stateData = parsed.data;
    if (parsed.data.sessionFile) {
      this.ompSessionFile = parsed.data.sessionFile;
    }
    return parsed.data;
  }

  get state(): OmpStateData | null {
    return this.stateData;
  }

  /** 空闲时读取 omp /context；项目模式经 execute_command（prompt 默认按文本发送）。 */
  readContextReport(): Promise<OmpContextReport | null> {
    if (this.contextRead) return this.contextRead;
    const output: string[] = [];
    this.contextOutput = output;
    const work = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        let resolveLocal!: (local: boolean) => void;
        const localResult = new Promise<boolean>((resolve) => {
          resolveLocal = resolve;
        });
        const id = this.process.reserveRequestId();
        const response = this.process.request(
          { id, type: "execute_command", text: "/context", sessionId: this.sessionId },
          5_000,
        );
        this.contextResult = { id, resolve: resolveLocal };
        timer = setTimeout(() => resolveLocal(false), 5_000);
        timer.unref?.();
        const outcome = await response;
        if (
          !outcome.success ||
          (outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked === true
        )
          return null;
        if (
          (outcome.data as { agentInvoked?: boolean } | undefined)?.agentInvoked !== false &&
          !(await localResult)
        )
          return null;
        return parseOmpContextReport(output.join("\n"));
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        this.contextOutput = null;
        this.contextResult = null;
        this.contextRead = null;
      }
    })();
    this.contextRead = work;
    return work;
  }

  /** 进程层路由来的会话帧（已按 sessionId 归属）。 */
  handleFrame(record: Record<string, unknown>): void {
    switch (record.type) {
      case "response": {
        // 进程层已完成请求关联；这里只登记本地命令异步收口 tracker。
        this.promptResults.noteResponse({
          id: typeof record.id === "string" ? record.id : undefined,
          command: typeof record.command === "string" ? record.command : "",
          success: record.success === true,
          data: record.data,
        });
        return;
      }
      case "prompt_result": {
        const id = typeof record.id === "string" ? record.id : undefined;
        const agentInvoked =
          record.agentInvoked === false ? false : record.agentInvoked === true ? true : undefined;
        if (id && id === this.contextResult?.id) {
          this.contextResult.resolve(agentInvoked === false);
          return;
        }
        // 修复（A1 接线）：真实 omp 的 prompt_result 携带 status/sessionSettled/error
        // （v18.3.1 起，内嵌核已在发）；新核输入门取消的 prompt 以 aborted 收尾且无模型
        // 回合，status 必须透传给 tracker 与引擎，否则轮次永不收口。
        const status = typeof record.status === "string" ? record.status : undefined;
        const errorText =
          typeof record.error === "string"
            ? record.error
            : record.error &&
                typeof record.error === "object" &&
                typeof (record.error as { message?: unknown }).message === "string"
              ? (record.error as { message: string }).message
              : undefined;
        if (id && this.promptResults.shouldFinish({ id, agentInvoked, status })) {
          this.handlers.onPromptResult?.({
            type: "prompt_result",
            id,
            agentInvoked,
            ...(status !== undefined ? { status } : {}),
            ...(errorText !== undefined ? { error: errorText } : {}),
          });
        }
        return;
      }
      case "available_commands_update": {
        this.handlers.onCommandsUpdate?.((record as { commands?: unknown }).commands);
        return;
      }
      case "command_output": {
        const text = typeof record.text === "string" ? record.text : "";
        if (this.contextOutput) {
          this.contextOutput.push(text);
          return;
        }
        this.handlers.onCommandOutput?.({ text });
        return;
      }
      case "session_info_update": {
        const title = typeof record.title === "string" ? record.title : undefined;
        this.handlers.onSessionInfoUpdate?.({ type: "session_info_update", title });
        return;
      }
      case "config_update": {
        this.handlers.onConfigUpdate?.(record as unknown as OmpConfigUpdateFrame);
        return;
      }
      case "extension_error":
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
      case "ready":
        return;
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event": {
        this.handlers.onSubagentFrame?.(record as unknown as OmpSubagentFrame);
        return;
      }
      case "extension_ui_request":
      case "permission_request":
      case "ask_request":
        dispatchOmpUiFrame(record, {
          onUiRequest: this.handlers.onUiRequest,
          onPermissionRequest: this.handlers.onPermissionRequest,
          onAskRequest: this.handlers.onAskRequest,
          respond: (response) => this.respondUi(response),
        });
        return;
      default: {
        this.handlers.onEvent(record as unknown as OmpSessionEventFrame);
        return;
      }
    }
  }

  /** 进程退出：未收口的本地命令 tracker 清空，交引擎终结轮次。 */
  notifyExit(code: number | null): void {
    if (this.detached) return;
    this.detached = true;
    this.promptResults.clear();
    this.handlers.onExit(code);
  }

  /** 会话关闭（保留历史）：默认取消运行中工作后卸载；不终止共享进程。 */
  async dispose(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.process.detachSession(this.sessionId);
    const bounded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    });
    // 有界等待：卸载有序但不应阻塞适配器退出（进程 EOF 会兜底清理）。
    await Promise.race([
      this.process
        .sendProject({ type: "close_session", sessionId: this.sessionId, cancelRunning: true })
        .catch(() => {}),
      bounded,
    ]);
  }
}

/**
 * 项目模式状态 → OmpSubagentBridge 使用的旧状态词。
 * 修复（C2）：durable 终态还有 parked（完成后驻留）与 interrupted（崩溃中断，
 * rpc-project-subagents.buildFinishedSubagentRow），旧 default→"running" 会把它们映射成
 * 永不终止的运行卡片。running 是 live 词；一切未知非 live 词必须映射为终态——
 * parked 有完成事实按 success；interrupted 无完成事实按 cancelled（与 aborted 同为
 * 未完成终态）。目录侧 ompProjectDirectory.projectStatusToDirectory 已按 R1③ 同步为
 * parked→success、interrupted→cancelled，两个表面词汇一致。
 */
function projectSubagentStatusToLegacy(status: string | undefined): string {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "failed":
      return "failed";
    case "aborted":
    case "interrupted":
      return "cancelled";
    default:
      // parked 及一切未知词：宁可收敛到终态，绝不误标 running（永不终止卡片）。
      return status === "parked" ? "success" : "cancelled";
  }
}
