// 投影行的幂等合并（从 conversationProjection 拆出；架构 maxFileLines=400）。
// 服务于子代理只读详情视图的事件驱动重水合：视图对 get_subagent_messages 做「全量重读」，
// rowsFromOmpEntries 对同一份完整记录重建出确定性 rowId（同 entries → 同 rowId），因此
// 合并语义为：已存在 rowId 内容变化才 upsert、新行 append——订阅端实时增长且不出现重复行。
// 不在此回收或新分配行号；nextRowId 由 host.claimRowId 抬升下界，防止后续活动轮分配撞号。

import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export interface ProjectionRowMergeHost {
  rows: Map<number, ConversationRow>;
  claimRowId(rowId: number): void;
  appendRow(row: ConversationRow): void;
  upsertRow(row: ConversationRow): void;
}

export function mergeProjectionRows(host: ProjectionRowMergeHost, latest: ConversationRow[]): void {
  for (const row of latest) {
    const known = host.rows.get(row.rowId);
    if (!known) {
      host.claimRowId(row.rowId);
      host.appendRow(row);
    } else if (JSON.stringify(known) !== JSON.stringify(row)) {
      // 同 rowId 内容未变（确定性重建的常见情形）不下发，避免订阅端被无意义 upsert 刷屏。
      host.upsertRow(row);
    }
  }
  // 全量重读的行号单调递增且新行恒大于已存在行，追加序天然有序，无需重排。
}
