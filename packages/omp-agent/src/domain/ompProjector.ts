// omp AgentSessionEvent → ConversationProjection 的翻译器。
// 纯逻辑：不持有 IO；交互请求（extension_ui_request）不在此处理，由引擎层接管。

import type { OmpSessionEventFrame, OmpAssistantMessageEvent } from "./ompFrames.js";
import type { ConversationProjection } from "./conversationProjection.js";

interface ToolCallRuntime {
  toolCallId: string;
  inputJsonText: string;
  status: "inputStreaming" | "running" | "pendingApproval" | "success" | "error" | "cancelled";
}

export class OmpEventProjector {
  private tools = new Map<string, ToolCallRuntime>();
  private streaming = false;
  private stopRequested = false;

  constructor(private readonly projection: ConversationProjection) {}

  get isStreaming(): boolean {
    return this.streaming;
  }

  /** UI 发起 stop 后调用；下一次 agent_end 按中断收口。 */
  noteStopRequested(): void {
    this.stopRequested = true;
    this.projection.markStopRequested();
  }

  handleEvent(event: OmpSessionEventFrame): void {
    switch (event.type) {
      case "agent_start":
        this.projection.activateQueuedTurn();
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
        if (this.stopRequested) {
          this.stopRequested = false;
          this.projection.finishTurn("interrupted");
        } else {
          const failure = this.projection.lastError;
          this.projection.finishTurn(failure ? "failed" : "success", failure ?? undefined);
        }
        return;
      }
      case "message_start":
      case "message_end":
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
        return;
      case "message_update":
        this.handleAssistantMessageEvent(event.assistantMessageEvent);
        return;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, { toolCallId: event.toolCallId, inputJsonText: "", status: "running" });
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
        this.projection.upsertToolCall({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.isError ? "error" : "success",
          outputText: text,
          error: event.isError ? { code: "tool_error", message: firstLine(text) || "tool execution failed" } : undefined,
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
        this.projection.setModelConfig(event.thinkingLevel !== undefined ? { thought: event.thinkingLevel } : {});
        return;
      case "auto_compaction_start":
        this.projection.addTimelineMarker({ type: "compact", origin: "auto", status: "running" });
        return;
      case "auto_compaction_end":
        this.projection.addTimelineMarker({ type: "compact", origin: "auto", status: "success" });
        return;
      case "notice":
        if (event.level === "error") {
          this.projection.recordTurnError({ code: "provider", message: event.message ?? "provider error" });
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
function assistantErrorOf(message: { stopReason?: string; errorStatus?: number; errorMessage?: string }): { code: string; message: string } | null {
  if (message.stopReason !== "error") {
    return null;
  }
  return {
    code: `omp_provider_${message.errorStatus ?? "error"}`,
    message: message.errorMessage ?? `model request failed (${message.errorStatus ?? "no status"})`,
  };
}

function usageOf(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; inputTokens?: number; outputTokens?: number } | undefined) {
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
