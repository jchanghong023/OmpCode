import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { TurnFileFacts } from "./fileFacts.js";
import type { TurnContext } from "./projectionRows.js";
import type { TurnOutcome } from "./projectionTypes.js";

/** 一个 agent_end 可以同时结束被 steer 挂起的旧轮和当前轮。 */
export function finalizeTurnContexts(input: {
  turns: TurnContext[];
  outcome: TurnOutcome;
  rowAt: (rowId: number) => ConversationRow | undefined;
  upsertRow: (row: ConversationRow) => void;
  closeStreamingRows: (turn: TurnContext) => void;
  turnFacts: Map<string, TurnFileFacts>;
}): void {
  for (const turn of input.turns) {
    input.closeStreamingRows(turn);
    input.turnFacts.set(turn.turnId, turn.fileFacts);
    if (input.turnFacts.size > 20) {
      const oldest = input.turnFacts.keys().next().value;
      if (oldest !== undefined) input.turnFacts.delete(oldest);
    }
    const header = input.rowAt(turn.headerRowId);
    if (header?.kind !== "turnHeader") continue;
    const files = turn.fileFacts.summary();
    input.upsertRow({
      ...header,
      state:
        input.outcome === "success"
          ? "completedSuccess"
          : input.outcome === "interrupted"
            ? "completedInterrupted"
            : "failed",
      endedAt: Date.now(),
      fileChanges: { additions: files.additions, deletions: files.deletions, files: files.files },
    });
  }
}

export function finalizeFailedQueuedTurn(input: {
  queuedTurns: TurnContext[];
  sourceCommandId: string;
  rowAt: (rowId: number) => ConversationRow | undefined;
  upsertRow: (row: ConversationRow) => void;
  turnFacts: Map<string, TurnFileFacts>;
}): boolean {
  const index = input.queuedTurns.findIndex(
    (turn) => turn.sourceCommandId === input.sourceCommandId,
  );
  if (index < 0) return false;
  const [queued] = input.queuedTurns.splice(index, 1);
  if (queued) {
    finalizeTurnContexts({
      turns: [queued],
      outcome: "failed",
      rowAt: input.rowAt,
      upsertRow: input.upsertRow,
      closeStreamingRows: () => {},
      turnFacts: input.turnFacts,
    });
  }
  return true;
}

/** 本地 ACK 只完成控制提交；按 ID 标记 controlOnly，不能关闭普通队首或活跃模型轮。 */
export function finalizeLocalCommandTurn(
  input: {
    queuedTurns: TurnContext[];
    activeTurn: () => TurnContext | null;
    inputTextByTurnId: Map<string, string>;
    rowAt: (rowId: number) => ConversationRow | undefined;
    upsertRow: (row: ConversationRow) => void;
    turnFacts: Map<string, TurnFileFacts>;
  },
  sourceCommandId: string,
): boolean {
  const index = input.queuedTurns.findIndex((turn) => turn.sourceCommandId === sourceCommandId);
  const active = input.activeTurn();
  const turn =
    index >= 0
      ? input.queuedTurns[index]
      : active?.sourceCommandId === sourceCommandId
        ? active
        : null;
  if (!turn) return true;
  const header = input.rowAt(turn.headerRowId);
  if (header?.kind === "turnHeader") input.upsertRow({ ...header, executionKind: "controlOnly" });
  if (index < 0) return false;
  input.queuedTurns.splice(index, 1);
  finalizeTurnContexts({
    turns: [turn],
    outcome: "success",
    rowAt: input.rowAt,
    upsertRow: input.upsertRow,
    closeStreamingRows: () => {},
    turnFacts: input.turnFacts,
  });
  input.inputTextByTurnId.delete(turn.turnId);
  return true;
}
