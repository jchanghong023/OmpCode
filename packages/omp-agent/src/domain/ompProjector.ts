// omp AgentSessionEvent → ConversationProjection 的翻译器。
// 纯逻辑：不持有 IO；交互请求（extension_ui_request）不在此处理，由引擎层接管。

import type { OmpSessionEventFrame, OmpAssistantMessageEvent, OmpStateData } from "./ompFrames.js";
import type { ConversationProjection } from "./conversationProjection.js";

interface ToolCallRuntime {
  toolCallId: string;
  inputJsonText: string;
  status: "inputStreaming" | "running" | "pendingApproval" | "success" | "error" | "cancelled";
}

/** 引擎侧竞态/对账钩子（A3/A5）：projector 只翻译帧，时序事实由引擎持有。 */
export interface OmpProjectorHooks {
  /** A5：返回在途 steer 的 guide 轮 sourceCommandId（无在途或非当前活跃轮为 null）。 */
  steerGuideCommandId?: () => string | null;
  /** A3：queue_update 事件到达（引擎 debounce 后回读 get_state 对账本地排队轮）。 */
  onQueueUpdate?: () => void;
}

export class OmpEventProjector {
  private tools = new Map<string, ToolCallRuntime>();
  /** 已收到终态（tool_execution_end / failOpenToolRows）的工具行；运行态更新不得复活终态行。 */
  private endedTools = new Set<string>();
  private streaming = false;
  private stopRequested = false;

  constructor(
    private readonly projection: ConversationProjection,
    private readonly hooks: OmpProjectorHooks = {},
  ) {}

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** UI 发起 stop 后调用；下一次 agent_end 按中断收口。 */
  noteStopRequested(): void {
    this.stopRequested = true;
    this.projection.markStopRequested();
  }

  /**
   * omp 进程崩溃退出时调用（F42）：terminal agent_end 不会到来，streaming/stopRequested
   * 与在途工具表只由进程生命周期持有，不复位则重启后首轮 sendText 按陈旧 isStreaming
   * 把全新输入误路由为 follow_up（静默排队）或 steer（报错）。只复位流式运行时状态，
   * 不动投影侧轮次——崩溃时排队的轮已由 failAllTurns 收口，两者清理语义保持一致。
   */
  resetForRestart(): void {
    this.streaming = false;
    this.stopRequested = false;
    // 清掉崩溃进程的在途工具运行时：若残留，下一个进程首个 terminal agent_end 的
    // failOpenToolRows 会把上一进程已收口的工具行错误改写为 cancelled。
    this.tools.clear();
    this.endedTools.clear();
  }

  handleEvent(event: OmpSessionEventFrame): void {
    switch (event.type) {
      case "agent_start":
        this.projection.activateQueuedTurn();
        // 修复：新 run 开始不代表全部 follow_up 已消费；用户 message_start 才逐项激活，
        // 缺少用户事件的旧核仍由 terminal get_state 对账收口，不能提前清空可见队列。
        this.streaming = true;
        this.stopRequested = false;
        return;
      case "agent_end": {
        const terminal = event.isTerminal !== false;
        if (!terminal) {
          return;
        }
        this.streaming = false;
        this.failOpenToolRows();
        const failure = this.projection.lastError;
        const outcome = this.stopRequested ? "interrupted" : failure ? "failed" : "success";
        // 修复（A5）：engine 在发送 steer 的窗口内（beginUserTurn(guide) 后、响应返回前）
        // terminal agent_end 到达时，无内容行的 guide 轮转回 queuedTurns（steer 已入 omp
        // steering 队列，由下一个 agent_start 激活承接），仅收口被挂起的旧轮。
        const steerGuide = this.hooks.steerGuideCommandId?.() ?? null;
        if (
          steerGuide !== null &&
          this.projection.requeueActiveTurnAsQueued(outcome, failure ?? undefined)
        ) {
          this.stopRequested = false;
          return;
        }
        if (this.stopRequested) {
          this.stopRequested = false;
          this.projection.finishTurn("interrupted");
        } else {
          this.projection.finishTurn(failure ? "failed" : "success", failure ?? undefined);
        }
        return;
      }
      case "message_start":
      case "message_end":
        if (event.type === "message_start" && event.message.role === "user") {
          const content = event.message.content;
          this.projection.activateQueuedTurn(
            typeof content === "string" ? content : textOfContent(content ?? []),
          );
        }
        if (event.message.role === "assistant") {
          // 供应商错误（如 401 未授权模型）记在 assistant 消息的 stopReason/errorStatus 上，
          // 不走 notice 事件；不消费就会以「成功 + 空回复」静默收口（UI 实测缺陷）。
          // 成功消息到达时清除粘性错误，避免 omp 自动重试成功后仍误报失败。
          const failure = assistantErrorOf(event.message);
          if (failure) {
            this.projection.recordTurnError(failure);
          } else if (event.type === "message_end") {
            this.projection.recordTurnError(null);
          }
          this.projection.addUsage(usageOf(event.message.usage));
          if (event.type === "message_end") {
            this.projection.closeAssistantResponse();
          }
        }
        if (event.type === "message_end" && event.message.role === "custom") {
          this.projection.appendCustomMessage(event.message);
        }
        return;
      case "message_update":
        this.handleAssistantMessageEvent(event.assistantMessageEvent);
        return;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          inputJsonText: "",
          status: "running",
        });
        this.projection.upsertToolCall({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running",
          input: event.args,
          inputText: stringifyArgs(event.args),
          startedAt: Date.now(),
        });
        return;
      case "tool_execution_update":
        // 修复依据（P2 验收 D1，Windows/CentOS 双平台真实 omp v18.3.5+fork.265 实测）：
        // abort 时 omp 先发 tool_execution_end(isError:true) 再补一条带 partialResult 的
        // 尾随 tool_execution_update；旧逻辑会把已终态工具行改回 running，而 end 已把工具
        // 移出在途表，terminal agent_end 的 failOpenToolRows 无法再收口，造成「会话标头已
        // Stopped 但工具行残留 Running」。工具行终态不变式：终态行不接受运行态更新。
        if (this.endedTools.has(event.toolCallId)) {
          return;
        }
        if (event.partialResult?.content) {
          const preview = textOfContent(event.partialResult.content);
          this.projection.upsertToolCall({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            outputText: preview.length > 0 ? preview : undefined,
          });
        }
        return;
      case "tool_execution_end": {
        const text = event.result?.content ? textOfContent(event.result.content) : "";
        this.tools.delete(event.toolCallId);
        this.endedTools.add(event.toolCallId);
        // 用户中断期间的 isError 是 abort 的取消事实（omp 文案「Command aborted」），
        // 不是工具自身失败：收口为 cancelled（已停止），与 failOpenToolRows 的中断语义、
        // UI 已停止标签及 Windows 基线一致；非中断期的 isError 仍是真实工具失败（error）。
        const abortedByUser = this.stopRequested && event.isError === true;
        this.projection.upsertToolCall({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: abortedByUser ? "cancelled" : event.isError ? "error" : "success",
          outputText: text,
          error:
            !abortedByUser && event.isError
              ? { code: "tool_error", message: firstLine(text) || "tool execution failed" }
              : undefined,
          endedAt: Date.now(),
          resultDetails: event.result?.details,
        });
        return;
      }
      case "model_changed": {
        // 真实 omp 的 model_changed 是裸事件（#emit 无载荷，见 agent-session.ts）；
        // 无载荷时不在此落空标记，由引擎回读 get_state 后统一投影。fake 核带载荷时直接消费。
        if (!event.model) {
          return;
        }
        this.projection.setModelConfig({
          ...(event.model?.provider !== undefined ? { provider: event.model.provider } : {}),
          ...(event.model?.id !== undefined ? { model: event.model.id } : {}),
        });
        this.projection.addTimelineMarker({
          type: "modelChange",
          fromProvider: "",
          fromModel: "",
          toProvider: event.model?.provider ?? "",
          toModel: event.model?.id ?? "",
          toThought: "",
        });
        return;
      }
      case "thinking_level_changed":
        this.projection.setModelConfig(
          event.thinkingLevel !== undefined ? { thought: event.thinkingLevel } : {},
        );
        return;
      case "auto_compaction_start":
        this.projection.addTimelineMarker({ type: "compact", origin: "auto", status: "running" });
        return;
      case "auto_compaction_end": {
        // 修复（A2）：auto_compaction_end 携带结果事实（agent-session-events.ts：
        // aborted/willRetry/errorMessage/skipped），无条件 success 会把失败/中止的自动
        // 压缩标成成功。aborted 或带 errorMessage → failed；skipped（良性跳过）→ noop；
        // 否则 success。aborted+willRetry → running 是前向兼容防御分支：已核对当前 omp
        // 全部发射点（session-maintenance.ts 8 处）aborted:true 时 willRetry 恒 false，
        // 现行行为不会进入该分支；仅当未来核引入「中止后自动重试」语义时按重试中标记
        // （由下一次 auto_compaction_end 收口），避免把重试中的压缩误标为终态。
        let status: "running" | "success" | "failed" | "noop";
        if (event.aborted === true && event.willRetry === true) {
          status = "running";
        } else if (event.aborted === true || event.errorMessage !== undefined) {
          status = "failed";
        } else if (event.skipped === true) {
          status = "noop";
        } else {
          status = "success";
        }
        this.projection.addTimelineMarker({ type: "compact", origin: "auto", status });
        return;
      }
      case "queue_update":
        // A3：队列快照事件只作对账触发器；事实以引擎 debounce 后回读的 get_state 为准。
        this.hooks.onQueueUpdate?.();
        return;
      case "notice":
        if (event.level === "error") {
          this.projection.recordTurnError({
            code: "provider",
            message: event.message ?? "provider error",
          });
        }
        return;
      default:
        return;
    }
  }

  private handleAssistantMessageEvent(streamEvent: OmpAssistantMessageEvent | undefined): void {
    if (!streamEvent) {
      return;
    }
    switch (streamEvent.type) {
      case "text_delta":
        if (streamEvent.delta) {
          this.projection.appendAssistantText(streamEvent.delta);
        }
        return;
      case "thinking_delta":
        if (streamEvent.delta) {
          this.projection.appendReasoning(streamEvent.delta);
        }
        return;
      case "toolcall_start":
        return;
      case "toolcall_delta": {
        // 参数 JSON 流式分片：聚合到 toolcall_end 再落 input。
        return;
      }
      default:
        return;
    }
  }

  private failOpenToolRows(): void {
    for (const tool of this.tools.values()) {
      // 与 tool_execution_end 同语义：这些行已按 cancelled 收口，尾随运行态更新不得复活。
      this.endedTools.add(tool.toolCallId);
      this.projection.upsertToolCall({
        toolCallId: tool.toolCallId,
        toolName: "unknown",
        status: "cancelled",
        endedAt: Date.now(),
      });
    }
    this.tools.clear();
  }
}

/** omp 把供应商失败记在 assistant 消息上（stopReason=error + errorStatus/errorMessage）。 */
function assistantErrorOf(message: {
  stopReason?: string;
  errorStatus?: number;
  errorMessage?: string;
}): { code: string; message: string } | null {
  if (message.stopReason !== "error") {
    return null;
  }
  return {
    code: `omp_provider_${message.errorStatus ?? "error"}`,
    message: message.errorMessage ?? `model request failed (${message.errorStatus ?? "no status"})`,
  };
}

/**
 * get_state.queuedMessages 的防御式解析（A3）：followUp 必须是纯字符串数组（本地排队轮
 * 对账的主队列）；steering 可选并入（A5 转回排队的 guide 轮按 steering 队列对账）。
 * 快照缺失或形状不明返回 null——对账跳过（不确定→不动，绝不误关）。
 */
export function ompQueueTextsOf(state: OmpStateData): string[] | null {
  const queued = state.queuedMessages;
  if (!queued || typeof queued !== "object" || !Array.isArray(queued.followUp)) return null;
  if (queued.followUp.some((text) => typeof text !== "string")) return null;
  const texts = [...queued.followUp];
  if (Array.isArray(queued.steering) && !queued.steering.some((text) => typeof text !== "string")) {
    texts.unshift(...queued.steering);
  }
  return texts;
}

function usageOf(
  usage:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        inputTokens?: number;
        outputTokens?: number;
      }
    | undefined,
) {
  if (!usage) {
    return {};
  }
  return {
    inputTokens: usage.input ?? usage.inputTokens ?? 0,
    outputTokens: usage.output ?? usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
  };
}

function textOfContent(content: { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function firstLine(value: string): string {
  return value.split("\n")[0] ?? "";
}

function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) {
    return "";
  }
  if (typeof args === "string") {
    return args.slice(0, 2048);
  }
  try {
    return JSON.stringify(args, null, 2).slice(0, 2048);
  } catch {
    return String(args).slice(0, 2048);
  }
}
