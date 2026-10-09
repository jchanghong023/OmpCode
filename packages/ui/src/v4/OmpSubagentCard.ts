import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationAssistantWorkRenderItem } from "@/v4/conversationAssistantWorkItems.js";

/** OMP 一个 task 可启动多个子代理；按真实子代理行复用 Agent 卡片，不做 FIFO 配对。 */
export function ompSubagentCardItem(
  row: SubagentRow,
): Extract<ConversationAssistantWorkRenderItem, { kind: "agentToolCall" }> {
  const status: ToolCallRow["status"] =
    row.status === "success"
      ? "success"
      : row.status === "failed"
        ? "error"
        : row.status === "cancelled"
          ? "cancelled"
          : "running";
  // 长任务与后续通信曾覆盖标签标题；真实 ID 前置，任务正文仍完整保留。
  const agentId = row.entityId?.startsWith("omp-subagent:")
    ? row.entityId.slice("omp-subagent:".length)
    : undefined;
  const description = row.summaryText || row.subagentType;
  return {
    kind: "agentToolCall",
    key: `subagent:${row.rowId}`,
    subagentRow: row,
    row: {
      rowId: row.rowId,
      entityId: row.entityId,
      turnId: row.turnId,
      productTurnId: row.productTurnId,
      createdAt: row.createdAt,
      createdAtSeq: row.createdAtSeq,
      kind: "toolCall",
      toolCallId: row.entityId ?? `subagent:${row.rowId}`,
      toolName: "Agent",
      status,
      inputText: "",
      input: {
        description: agentId ? `${agentId} · ${description}` : description,
        prompt: row.summaryText,
        subagent_type: row.subagentType,
      },
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    },
  };
}
