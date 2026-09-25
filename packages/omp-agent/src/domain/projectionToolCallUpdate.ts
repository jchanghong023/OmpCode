import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  createToolCallRow,
  mergeToolCallRow,
  type ToolCallUpsert,
  type TurnContext,
} from "./projectionRows.js";

/** 工具事实由当前轮持有；只有成功结果更新文件统计。 */
export function applyProjectionToolCallUpdate(input: {
  turn: TurnContext;
  update: ToolCallUpsert;
  createdAtSeq: number;
  rows: Iterable<ConversationRow>;
  nextRowId: () => number;
  rowAt: (rowId: number) => ConversationRow | undefined;
  upsertRow: (row: ConversationRow) => void;
}): void {
  const { turn, update } = input;
  const existing = [...input.rows].find(
    (row): row is ToolCallRow => row.kind === "toolCall" && row.toolCallId === update.toolCallId,
  );
  const merged = existing
    ? mergeToolCallRow(existing, update)
    : createToolCallRow({
        rowId: input.nextRowId(),
        turnId: turn.turnId,
        productTurnId: turn.productTurnId,
        createdAtSeq: input.createdAtSeq,
        ...update,
      });
  input.upsertRow(merged);
  if (update.status !== "success") return;
  turn.fileFacts.recordToolResult({
    toolName: update.toolName,
    input:
      typeof merged.input === "object" && merged.input !== null
        ? (merged.input as Record<string, unknown>)
        : undefined,
    resultDetails: update.resultDetails,
  });
  const header = input.rowAt(turn.headerRowId);
  if (header?.kind !== "turnHeader") return;
  const files = turn.fileFacts.summary();
  input.upsertRow({
    ...header,
    fileChanges: { additions: files.additions, deletions: files.deletions, files: files.files },
  });
}
