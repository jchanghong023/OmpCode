// 流式文本行的存储与生命周期（从 conversationProjection 拆出；架构 maxFileLines=400）。
// 只做流式 append/关闭的行级操作，不碰轮次状态机；host 由 ConversationProjection 提供写出口。

import type { ConversationDelta, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { createStreamingRow, type TurnContext } from "./projectionRows.js";

function bufferStreamText(
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

/** 流式 append/关闭的投影写出口（ConversationProjection 以单一 host 对象提供）。 */
export interface ProjectionStreamHost {
  rows: Map<number, ConversationRow>;
  pendingStreamTextByRowId: Map<number, string[]>;
  turn(): TurnContext | null;
  sequence(): number;
  nextRowId(): number;
  appendRow(row: ConversationRow): void;
  upsertRow(row: ConversationRow): void;
  pushPending(delta: ConversationDelta): void;
}

/** 流式文本/思考增量：复用当前轮的流式行（无则开新行），片段进缓冲并产出 row.delta。 */
export function appendProjectionStreamDelta(
  host: ProjectionStreamHost,
  delta: string,
  kind: "assistantText" | "reasoning",
): void {
  const turn = host.turn();
  if (!turn || delta.length === 0) {
    return;
  }
  const anchorKey = kind === "assistantText" ? "streamingTextRow" : "streamingReasoningRow";
  if (!turn[anchorKey]) {
    turn.responseCounter += 1;
    const rowId = host.nextRowId();
    host.appendRow(
      createStreamingRow({
        rowId,
        turnId: turn.turnId,
        productTurnId: turn.productTurnId,
        createdAtSeq: host.sequence() + 1,
        kind,
        responseCounter: turn.responseCounter,
      }),
    );
    turn[anchorKey] = {
      rowId,
      entityId: `resp-${turn.turnId}-${turn.responseCounter}-${kind === "assistantText" ? "text" : "reasoning"}`,
    };
  }
  const anchor = turn[anchorKey]!;
  // 逐 chunk 拼接整行会让长回复产生 O(n²) 拷贝；只在读快照或收口时物化。
  bufferStreamText(host.pendingStreamTextByRowId, anchor.rowId, delta);
  host.pushPending({ op: "row.delta", rowId: anchor.rowId, path: "text", append: delta });
}

/** 收口本轮流式行到终态；failed 只收口文本行（思考行保留 streaming 语义由 finalizer 处理）。 */
export function closeProjectionStreamingRows(
  host: ProjectionStreamHost,
  finalState: "complete" | "interrupted" | "failed",
  turn: TurnContext | null,
): void {
  if (!turn) {
    return;
  }
  for (const anchor of [turn.streamingTextRow, turn.streamingReasoningRow]) {
    if (!anchor) {
      continue;
    }
    const row = materializeStreamTextRow(host.rows, host.pendingStreamTextByRowId, anchor.rowId);
    if (!row) {
      continue;
    }
    if (row.kind === "assistantText" && row.state === "streaming") {
      host.upsertRow({ ...row, state: finalState });
    } else if (row.kind === "reasoning" && row.state === "streaming" && finalState !== "failed") {
      host.upsertRow({ ...row, state: finalState });
    }
  }
}
