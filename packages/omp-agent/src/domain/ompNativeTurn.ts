import { createTurnHeaderRow, createUserInputRow } from "./projectionRows.js";
import { TurnFileFacts } from "./fileFacts.js";
import { runningControlPatch } from "./projectionStatePatches.js";
import type { QueuedTurnReconcileHost } from "./queuedTurnReconcile.js";

/** OMP 原生 loop/goal/后台续跑没有 UI accepted 输入；仅由真实事件派生显示轮。 */
export function ensureOmpNativeTurn(host: QueuedTurnReconcileHost, text?: string): void {
  let turn = host.activeTurn();
  if (!turn) {
    const turnId = `omp-native-${host.seq() + 1}`;
    const sourceCommandId = turnId;
    const headerRowId = host.nextRowId();
    const header = createTurnHeaderRow({
      rowId: headerRowId,
      turnId,
      productTurnId: turnId,
      createdAtSeq: host.seq() + 1,
      sourceCommandId,
      historyRoundCount: host.rowIds.filter((id) => host.rowAt(id)?.kind === "turnHeader").length,
    });
    if (header.kind === "turnHeader")
      host.appendRow({ ...header, origin: "backgroundResult", sourceCommandId: undefined });
    turn = {
      turnId,
      productTurnId: turnId,
      sourceCommandId,
      headerRowId,
      fileFacts: new TurnFileFacts(),
      responseCounter: 0,
      streamingTextRow: null,
      streamingReasoningRow: null,
    };
    host.setActiveTurn(turn);
    host.setLastError(null);
    host.patchState(runningControlPatch());
  }
  // accepted/queued 的用户行已存在；重复 user message_start 也不能再追加 native 输入。
  if (
    text === undefined ||
    !turn.sourceCommandId.startsWith("omp-native-") ||
    host.inputTextByTurnId.has(turn.turnId)
  )
    return;
  const row = createUserInputRow({
    rowId: host.nextRowId(),
    turnId: turn.turnId,
    productTurnId: turn.productTurnId,
    createdAtSeq: host.seq() + 1,
    sourceCommandId: turn.sourceCommandId,
    clientId: "omp",
    text,
  });
  if (row.kind === "userInput")
    host.appendRow({
      ...row,
      origin: "synthetic",
      sourceCommandId: undefined,
      clientId: undefined,
    });
  host.inputTextByTurnId.set(turn.turnId, text);
}
