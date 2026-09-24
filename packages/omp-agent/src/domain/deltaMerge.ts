// 增量合并（conflation）：同一批次内合并连续同构 op，压低帧字节；seq 取被合并段的最后一个。

import type { ConversationDelta, StatePatch } from "@zcode/shared/zcode-protocol-v4";

export interface LoggedDelta {
  seq: number;
  delta: ConversationDelta;
}

export function mergeDeltas(entries: LoggedDelta[]): LoggedDelta[] {
  const merged: LoggedDelta[] = [];
  for (const entry of entries) {
    const last = merged.at(-1);
    if (
      last &&
      entry.delta.op === "row.delta" &&
      last.delta.op === "row.delta" &&
      last.delta.rowId === entry.delta.rowId &&
      last.delta.path === entry.delta.path
    ) {
      last.delta = { ...last.delta, append: last.delta.append + entry.delta.append };
      last.seq = entry.seq;
      continue;
    }
    if (last && entry.delta.op === "state.updated" && last.delta.op === "state.updated") {
      last.delta = { op: "state.updated", patch: { ...last.delta.patch, ...entry.delta.patch } as StatePatch };
      last.seq = entry.seq;
      continue;
    }
    merged.push({ seq: entry.seq, delta: entry.delta });
  }
  return merged;
}
