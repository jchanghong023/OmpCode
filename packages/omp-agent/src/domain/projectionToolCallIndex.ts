import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

/** ConversationProjection 持有的行 ID 派生索引；不保存另一份工具事实。 */
export class ProjectionToolCallIndex {
  private readonly firstByToolCallId = new Map<string, number>();
  private readonly latestByToolCallId = new Map<string, number>();

  firstRow(
    toolCallId: string,
    rows: ReadonlyMap<number, ConversationRow>,
  ): ToolCallRow | undefined {
    const rowId = this.firstByToolCallId.get(toolCallId);
    const row = rowId === undefined ? undefined : rows.get(rowId);
    return row?.kind === "toolCall" ? row : undefined;
  }

  latestRowId(toolCallId: string): number | null {
    return this.latestByToolCallId.get(toolCallId) ?? null;
  }

  append(row: ConversationRow): void {
    if (row.kind !== "toolCall") return;
    if (!this.firstByToolCallId.has(row.toolCallId))
      this.firstByToolCallId.set(row.toolCallId, row.rowId);
    this.latestByToolCallId.set(row.toolCallId, row.rowId);
  }

  upsert(
    previous: ConversationRow | undefined,
    row: ConversationRow,
    rows: ReadonlyMap<number, ConversationRow>,
    rowIds: readonly number[],
  ): void {
    if (!previous) {
      this.append(row);
      return;
    }
    const previousId = previous.kind === "toolCall" ? previous.toolCallId : undefined;
    const nextId = row.kind === "toolCall" ? row.toolCallId : undefined;
    // Bug 根因：逐次工具事件复制并扫描全部 rows；同 ID 更新不改变行位置，直接复用索引。
    // 重水合改写 kind/ID 时重建一次，保留旧首行更新与最近权限锚定的不同排序语义。
    if (previousId !== nextId) this.rebuild(rows, rowIds);
  }

  rebuild(rows: ReadonlyMap<number, ConversationRow>, rowIds: readonly number[]): void {
    this.clear();
    for (const row of rows.values()) {
      if (row.kind === "toolCall" && !this.firstByToolCallId.has(row.toolCallId))
        this.firstByToolCallId.set(row.toolCallId, row.rowId);
    }
    for (const rowId of rowIds) {
      const row = rows.get(rowId);
      if (row?.kind === "toolCall") this.latestByToolCallId.set(row.toolCallId, row.rowId);
    }
  }

  clear(): void {
    this.firstByToolCallId.clear();
    this.latestByToolCallId.clear();
  }
}
