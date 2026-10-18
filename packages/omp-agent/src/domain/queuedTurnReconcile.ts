// TurnContext 是应用已接纳输入的唯一队列；这里只做派发租约、消费与终态纯状态迁移。
// queue 不再发送 native follow_up，不依据核心文本快照猜测接纳/消费，也不设宽限定时器。

import type { ConversationRow, StatePatch } from "@zcode/shared/zcode-protocol-v4";
import {
  finalizeFailedQueuedTurn,
  finalizeLocalCommandTurn,
  finalizeTurnContexts,
} from "./projectionTurnFinalizer.js";
import {
  createTurnHeaderRow,
  createUserInputRow,
  type TurnContext,
  type TurnSubmission,
} from "./projectionRows.js";
import { TurnFileFacts } from "./fileFacts.js";
import type { ProjectionAState, TurnOutcome } from "./projectionTypes.js";
import { runningControlPatch, terminalControlPatch } from "./projectionStatePatches.js";

export interface BeginTurnInput {
  text: string;
  inputId: string;
  sourceCommandId: string;
  clientId: string;
  routing?: "startNow" | "guide" | "queue";
  submission?: TurnSubmission;
}

/** 投影侧委托宿主：排队轮/挂起轮/行与状态的读写出口（数组与 Map 以引用共享，直接生效）。 */
export interface QueuedTurnReconcileHost {
  queuedTurns: TurnContext[];
  /** 各轮输入文本（turnId → text）：队列对账（A3）匹配 omp 队列快照用；轮收口时清理。 */
  inputTextByTurnId: Map<string, string>;
  rowIds: number[];
  rowAt: (rowId: number) => ConversationRow | undefined;
  upsertRow: (row: ConversationRow) => void;
  turnFacts: Map<string, TurnFileFacts>;
  activeTurn: () => TurnContext | null;
  setActiveTurn: (turn: TurnContext | null) => void;
  /** 挂起轮的活数组（steer 挂起的旧轮）：push/splice/清空按引用直接生效。 */
  suspendedTurns: () => TurnContext[];
  patchState: (patch: StatePatch) => void;
  state: () => ProjectionAState;
  seq: () => number;
  nextRowId: () => number;
  appendRow: (row: ConversationRow) => void;
  setLastError: (error: { code: string; message: string } | null) => void;
  closeStreamingRows: (
    finalState: "complete" | "interrupted" | "failed",
    turn: TurnContext | null,
  ) => void;
}

/** 开启用户输入轮；queue/guide 先登记同一 owner，只有真实消费才切换活跃输出归属。 */
export function beginUserTurnOf(host: QueuedTurnReconcileHost, input: BeginTurnInput): void {
  if (!host.activeTurn() && input.routing !== "queue" && input.routing !== "guide")
    host.setLastError(null);
  const turnNumber = host.rowIds.filter((id) => host.rowAt(id)?.kind === "turnHeader").length + 1;
  const turnId = `turn-${turnNumber}-${input.inputId}`;
  const init = { turnId, productTurnId: turnId, createdAtSeq: host.seq() + 1 };
  const headerRowId = host.nextRowId();
  const userRowId = host.nextRowId();
  host.appendRow(
    createTurnHeaderRow({
      ...init,
      rowId: headerRowId,
      sourceCommandId: input.sourceCommandId,
      historyRoundCount: turnNumber - 1,
    }),
  );
  host.appendRow(
    createUserInputRow({
      ...init,
      rowId: userRowId,
      text: input.text,
      sourceCommandId: input.sourceCommandId,
      clientId: input.clientId,
    }),
  );
  const nextTurn: TurnContext = {
    turnId,
    sourceCommandId: input.sourceCommandId,
    productTurnId: turnId,
    headerRowId,
    fileFacts: new TurnFileFacts(),
    responseCounter: 0,
    streamingTextRow: null,
    streamingReasoningRow: null,
    ...(input.submission ? { submission: input.submission } : {}),
  };
  // 文本索引只服务原生派生行；已接纳输入的完整 payload 仅随 TurnContext 保存一次。
  host.inputTextByTurnId.set(turnId, input.text);
  // 冷启动双投递都可能标成 startNow；有活跃轮时须排队，避免覆盖旧 TurnContext。
  const active = host.activeTurn();
  if (input.routing === "queue" || input.routing === "guide" || active) {
    // guide 也先保留在同一 owner；真实 steer 消费时才切换输出归属，UI 复用既有 pending-guide 落位。
    host.queuedTurns.push(nextTurn);
  } else {
    host.setActiveTurn(nextTurn);
    host.patchState(runningControlPatch());
  }
}

/** 只有同命令的真实本地完成可收口，绝不能借无内容完成抢先激活下一条等待输入。 */
export function finishQueuedLocalOnlyTurnOf(
  host: QueuedTurnReconcileHost,
  sourceCommandId?: string,
): boolean {
  const target = sourceCommandId ?? host.activeTurn()?.sourceCommandId;
  if (!target) return false;
  const completed = finalizeLocalCommandTurn(host, target);
  if (completed && !host.activeTurn())
    host.patchState(terminalControlPatch(host.state(), "success"));
  return completed;
}

/** 按输入命令失败收口：命中排队轮直接失败收口该轮，否则按活跃轮失败收口（failActive 回调）。 */
export function failCommandTurnOf(
  host: QueuedTurnReconcileHost,
  sourceCommandId: string,
  error: { code: string; message: string },
  failActive: (error: { code: string; message: string }) => void,
): void {
  // 失败通过命令身份定位；payload 租约必须与终态一起撤销。
  const queued = host.queuedTurns.find((turn) => turn.sourceCommandId === sourceCommandId);
  const finalized =
    queued &&
    finalizeFailedQueuedTurn({
      queuedTurns: host.queuedTurns,
      sourceCommandId,
      turnFacts: host.turnFacts,
      rowAt: host.rowAt,
      upsertRow: host.upsertRow,
    });
  if (finalized) {
    if (queued.submission) {
      const dispatched = queued.submission.state !== "pending";
      queued.submission.state = "cancelled";
      if (dispatched && !host.activeTurn()) {
        host.setLastError(error);
        host.patchState(terminalControlPatch(host.state(), "failed", error));
      }
    }
    host.inputTextByTurnId.delete(queued.turnId);
    return;
  }
  // 原命令可能已收口并激活了下一轮；晚到失败不得污染不相关的新轮。
  if (host.activeTurn()?.sourceCommandId === sourceCommandId) failActive(error);
}

/** 全轮失败（进程退出/删除会话）：活跃轮与全部排队轮依次失败收口。 */
export function failAllTurnsOf(
  host: QueuedTurnReconcileHost,
  error: { code: string; message: string },
  failCommand: (sourceCommandId: string, error: { code: string; message: string }) => void,
): void {
  failCommand(host.activeTurn()?.sourceCommandId ?? "", error);
  while (host.queuedTurns.length > 0) {
    const next = host.queuedTurns[0];
    if (!next) break;
    failCommand(next.sourceCommandId, error);
  }
}

/** 轮收口：同时结束被挂起的旧轮与当前轮，登记终态控制面并清空轮状态。
 * terminalControlPatch 会清空 queue 读面，但 queuedTurns 可能仍在等待真实消费；
 * projection 委托返回时必须同步重派生，不能等 drain 才修复快照。
 */
export function finishTurnOf(
  host: QueuedTurnReconcileHost,
  outcome: TurnOutcome,
  error?: { code: string; message: string },
): void {
  const turn = host.activeTurn();
  const suspended = host.suspendedTurns();
  if (!turn && suspended.length === 0) return;
  const finalized = [...suspended, ...(turn ? [turn] : [])];
  for (const candidate of finalized) {
    if (candidate.submission && candidate.submission.state !== "consumed") {
      candidate.submission.state = "cancelled";
    }
  }
  finalizeTurnContexts({
    turns: finalized,
    outcome,
    rowAt: host.rowAt,
    upsertRow: host.upsertRow,
    closeStreamingRows: (active) =>
      host.closeStreamingRows(
        outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "complete",
        active,
      ),
    turnFacts: host.turnFacts,
  });
  for (const finished of finalized) host.inputTextByTurnId.delete(finished.turnId);
  if (outcome === "failed") {
    host.setLastError(error ?? { code: "runtime", message: "turn failed" });
  }
  host.patchState(terminalControlPatch(host.state(), outcome, error));
  host.setActiveTurn(null);
  suspended.length = 0;
}

/** 成功终态后的串行派发租约。native guide 未消费时不能抢先启动应用队首。 */
export function claimQueuedSubmissionOf(
  host: QueuedTurnReconcileHost,
  generation: number,
): TurnSubmission | null {
  if (host.activeTurn()) return null;
  if (host.queuedTurns.some((turn) => turn.submission?.delivery === "steer")) return null;
  const submission = host.queuedTurns[0]?.submission;
  if (!submission || submission.generation !== generation || submission.state !== "pending")
    return null;
  submission.state = "dispatching";
  // 配置与派发已真实开始，可停止；等待项仍保留到 user message_start，不伪造正在输出的行。
  host.patchState(runningControlPatch());
  return submission;
}

/** 先撤销租约再发布空队列，旧 async 配置/派发续体只能观察 cancelled，不能投递。 */
export function cancelQueuedSubmissionsOf(
  host: QueuedTurnReconcileHost,
  outcome: "interrupted" | "failed",
  error?: { code: string; message: string },
): void {
  const cancelled = host.queuedTurns.splice(0);
  const dispatched = cancelled.some(
    (turn) =>
      turn.submission &&
      turn.submission.state !== "pending" &&
      turn.submission.state !== "cancelled",
  );
  for (const turn of cancelled) {
    if (turn.submission) turn.submission.state = "cancelled";
    host.inputTextByTurnId.delete(turn.turnId);
  }
  const active = host.activeTurn();
  if (!active && dispatched) host.patchState(terminalControlPatch(host.state(), outcome, error));
  if (active?.submission && active.submission.state !== "consumed")
    active.submission.state = "cancelled";
  for (const turn of host.suspendedTurns()) {
    if (turn.submission && turn.submission.state !== "consumed")
      turn.submission.state = "cancelled";
  }
  finalizeTurnContexts({
    turns: cancelled,
    outcome,
    rowAt: host.rowAt,
    upsertRow: host.upsertRow,
    closeStreamingRows: () => {},
    turnFacts: host.turnFacts,
  });
}
