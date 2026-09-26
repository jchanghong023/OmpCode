// legacy SessionStateSnapshot 构建：从 v4 投影行回填旧协议 create/resume/read 的快照。
// 旧链路（task 索引、恢复兜底）只需要结构合法的摘要；流式主链路在 v4。

import type { ConversationEngine } from "./conversationEngine.js";
import { ZCODE_PROTOCOL_NAME, ZCODE_PROTOCOL_VERSION } from "@zcode/shared";

interface LegacyMessage {
  info: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

export function buildLegacySnapshot(params: {
  engine: ConversationEngine;
  sessionId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  messageLimit?: number;
}): Record<string, unknown> {
  const { engine, workspacePath } = params;
  const sessionId = params.sessionId ?? engine.sessionId;
  const state = engine.projection.stateSnapshot;
  const snapshot = engine.projection.buildSnapshot();
  const messages = legacyMessages(engine, params.messageLimit ?? 200);
  const now = Date.now();
  return {
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId,
      workspace: {
        workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        workspaceKey: params.workspaceKey,
      },
      sessionKind: "interactive",
      title: state.meta.title,
      titleSource: state.meta.titleSource === "custom" ? "custom" : state.meta.titleSource === "generated" ? "generated" : "first_input",
      mode: "build",
      status: statusOf(state.control.phase),
      createdAt: now,
      updatedAt: now,
    },
    settings: {
      model: {
        ...(state.config.provider && state.config.model
          ? {
              current: {
                providerId: state.config.provider,
                modelId: state.config.model,
                ...(state.config.thought ? { options: { reasoningLevel: state.config.thought } } : {}),
              },
            }
          : {}),
        available: [],
      },
      thoughtLevel: {
        enabled: true,
        ...(state.config.thought ? { current: state.config.thought } : {}),
        available: state.config.thoughtLevels.map((level) => ({ value: level, label: level })),
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId,
      status: statusOf(state.control.phase),
      mode: "build",
      turnCount: snapshot.rows.window.filter((row) => row.kind === "turnHeader").length,
      totalTokenCount:
        state.usage.cumulative.inputTokens +
        state.usage.cumulative.outputTokens +
        state.usage.cumulative.cacheReadTokens +
        state.usage.cumulative.cacheWriteTokens,
      contextUsed: state.usage.contextWindow?.usedTokens ?? 0,
      contextWindow: state.usage.contextWindow?.maxTokens ?? 0,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: engine.projection.seq,
      stateRevision: engine.projection.revision,
      pendingRequestIds: [],
    },
    messages,
  };
}

function statusOf(phase: string): string {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "error":
      return "error";
    case "draft":
      return "idle";
    default:
      return "completed";
  }
}

function legacyMessages(engine: ConversationEngine, limit: number): LegacyMessage[] {
  const rows = engine.projection.buildSnapshot().rows.window.slice(-limit);
  const messages: LegacyMessage[] = [];
  let assistantParentId = "root";
  for (const row of rows) {
    const partBase = { partId: `part-${row.rowId}`, sessionId: engine.sessionId, messageId: `msg-${row.rowId}` };
    if (row.kind === "userInput") {
      assistantParentId = `msg-${row.rowId}`;
      messages.push({
        info: {
          messageId: `msg-${row.rowId}`,
          sessionId: engine.sessionId,
          role: "user",
          time: { created: row.createdAt },
          agent: "omp",
        },
        parts: [{ ...partBase, type: "text", text: row.text }],
      });
    } else if (row.kind === "assistantText" || row.kind === "reasoning") {
      messages.push({
        info: {
          messageId: `msg-${row.rowId}`,
          sessionId: engine.sessionId,
          role: "assistant",
          time: { created: row.createdAt },
          parentMessageId: assistantParentId,
          agent: "omp",
          path: { cwd: engine.workspacePath, root: engine.workspacePath },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ ...partBase, type: row.kind === "reasoning" ? "reasoning" : "text", text: row.text }],
      });
    } else if (row.kind === "toolCall") {
      const last = messages.at(-1);
      const toolPart = {
        ...partBase,
        type: "tool",
        callId: row.toolCallId,
        tool: row.toolName,
        state: toolStateOf(row.status, row.input, row.output?.text ?? ""),
      };
      if (last && last.info.role === "assistant") {
        last.parts.push(toolPart);
      } else {
        messages.push({
          info: {
            messageId: `msg-${row.rowId}`,
            sessionId: engine.sessionId,
            role: "assistant",
            time: { created: row.createdAt },
            parentMessageId: assistantParentId,
            agent: "omp",
            path: { cwd: engine.workspacePath, root: engine.workspacePath },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [toolPart],
        });
      }
    }
  }
  return messages;
}

function toolStateOf(status: string, input: unknown, output: string): Record<string, unknown> {
  const jsonInput = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (status) {
    case "running":
      return { status: "running", input: jsonInput, startedAt: Date.now() };
    case "pendingApproval":
    case "inputStreaming":
      return { status: "pending", input: jsonInput, raw: "" };
    case "error":
      return { status: "error" as never, input: jsonInput, output, startedAt: Date.now(), completedAt: Date.now(), error: "tool error" };
    default:
      return { status: "completed", input: jsonInput, output, title: "", metadata: {}, startedAt: Date.now(), completedAt: Date.now() };
  }
}
