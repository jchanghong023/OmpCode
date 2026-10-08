import type { ConversationRow, QueueState } from "@zcode/shared/zcode-protocol-v4";

/** 修复：OMP 已接受但未消费的输入只在队列面板展示，不能同时出现“工作中”。 */
export function rowsWithoutQueuedInputs(
  rows: ConversationRow[],
  queue: QueueState,
): ConversationRow[] {
  if (queue.items.length === 0) return rows;
  const commands = new Set(queue.items.map((item) => item.sourceCommandId));
  const turns = new Set(
    rows.flatMap((row) =>
      (row.kind === "turnHeader" || row.kind === "userInput") &&
      row.sourceCommandId &&
      commands.has(row.sourceCommandId)
        ? [row.turnId]
        : [],
    ),
  );
  return rows.filter((row) => !turns.has(row.turnId));
}
