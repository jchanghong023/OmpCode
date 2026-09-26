import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export function bufferStreamText(
  pendingByRowId: Map<number, string[]>,
  rowId: number,
  delta: string,
): void {
  const pending = pendingByRowId.get(rowId);
  if (pending) pending.push(delta);
  else pendingByRowId.set(rowId, [delta]);
}

/** 将尚未发布的流式片段按需物化到行索引，避免逐 chunk 复制整段正文。 */
export function materializeStreamTextRow(
  rows: Map<number, ConversationRow>,
  pendingByRowId: Map<number, string[]>,
  rowId: number,
): ConversationRow | undefined {
  const row = rows.get(rowId);
  const pending = pendingByRowId.get(rowId);
  if (!row || !pending || pending.length === 0) return row;
  pendingByRowId.delete(rowId);
  if (row.kind !== "assistantText" && row.kind !== "reasoning") return row;
  const next = { ...row, text: row.text + pending.join("") };
  rows.set(rowId, next);
  return next;
}
