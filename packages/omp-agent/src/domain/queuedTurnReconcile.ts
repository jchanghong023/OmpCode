// 排队轮对账与轮生命周期（A3/A4/A5，自 conversationProjection.ts 内聚抽出）：
// 纯逻辑模块——轮开启/激活/收口、失败与 steer 竞态转回排队、输入文本登记表与排队轮
// 数组的判定/收口都在这里；投影持有状态并经 QueuedTurnReconcileHost 委托调用，
// 投影对外 API 不变。

import type { ConversationRow, StatePatch } from "@zcode/shared/zcode-protocol-v4";
import { finalizeFailedQueuedTurn, finalizeTurnContexts } from "./projectionTurnFinalizer.js";
import { createTurnHeaderRow, createUserInputRow, type TurnContext } from "./projectionRows.js";
import { TurnFileFacts } from "./fileFacts.js";
import type { ProjectionAState, TurnOutcome } from "./projectionTypes.js";
import { runningControlPatch, terminalControlPatch } from "./projectionStatePatches.js";

export interface BeginTurnInput {
  text: string;
  inputId: string;
  sourceCommandId: string;
  clientId: string;
  routing?: "startNow" | "guide" | "queue";
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

/** 开启用户输入轮：登记 turnHeader/userInput 行与新 TurnContext；有活跃轮时按 routing 排队或挂起旧轮。 */
export function beginUserTurnOf(host: QueuedTurnReconcileHost, input: BeginTurnInput): void {
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
  };
  // 全轮登记输入文本（A5 转回排队的 guide 轮也要参与 A3 队列对账匹配）。
  host.inputTextByTurnId.set(turnId, input.text);
  // 冷启动双投递都可能标成 startNow；有活跃轮时须排队，避免覆盖旧 TurnContext。
  const active = host.activeTurn();
  if (active && input.routing !== "guide") {
    // omp follow_up 只在当前 agent_end 之后启动；现有输出仍归原轮。
    host.queuedTurns.push(nextTurn);
  } else {
    if (input.routing === "guide" && active) {
      // steer 在当前 agent 内生效；保留旧轮供同一 agent_end 收口。
      host.closeStreamingRows("complete", active);
      host.suspendedTurns().push(active);
    }
    host.setActiveTurn(nextTurn);
    host.patchState(runningControlPatch());
  }
}

/** 队首排队轮激活为活跃轮（omp 新 run 的 agent_start / 本地命令完成事实触发）。 */
export function activateQueuedTurnOf(host: QueuedTurnReconcileHost): void {
  if (host.activeTurn() || host.queuedTurns.length === 0) return;
  host.setActiveTurn(host.queuedTurns.shift() ?? null);
  if (host.activeTurn()) host.patchState(runningControlPatch());
}

/** 本地命令没有 agent_start；上一轮结束后由完成事实激活并收口队首。 */
export function finishQueuedLocalOnlyTurnOf(
  host: QueuedTurnReconcileHost,
  closeAssistant: () => void,
  finishTurn: (outcome: "success") => void,
): boolean {
  if (host.activeTurn()) return false;
  activateQueuedTurnOf(host);
  if (!host.activeTurn()) return false;
  closeAssistant();
  finishTurn("success");
  return true;
}

/** 按输入命令失败收口：命中排队轮直接失败收口该轮，否则按活跃轮失败收口（failActive 回调）。 */
export function failCommandTurnOf(
  host: QueuedTurnReconcileHost,
  sourceCommandId: string,
  error: { code: string; message: string },
  failActive: (error: { code: string; message: string }) => void,
): void {
  // finalizeFailedQueuedTurn 内部按 sourceCommandId 定位并 splice；这里预先找到同一条
  // 轮以同步清理输入文本登记（A3 对账表不得残留已收口轮）。
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

/** 轮收口：同时结束被挂起的旧轮与当前轮，登记终态控制面并清空轮状态。 */
export function finishTurnOf(
  host: QueuedTurnReconcileHost,
  outcome: TurnOutcome,
  error?: { code: string; message: string },
): void {
  const turn = host.activeTurn();
  const suspended = host.suspendedTurns();
  if (!turn && suspended.length === 0) return;
  const finalized = [...suspended, ...(turn ? [turn] : [])];
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

/**
 * steer 在途竞态（A5）：terminal agent_end 抢在 steer 响应之前到达。无内容行的 guide
 * 轮不能被连带收口——其 steer 已入 omp steering 队列（成功响应后由下一个独立 agent
 * 回合承接：agent_start 激活排队轮）；把该轮转回 queuedTurns，仅收口被挂起的旧轮。
 * 返回 false（无活跃轮或已有内容行，steer 已被本 run 承接）时调用方按常规 agent_end 收口。
 */
export function requeueActiveTurnAsQueuedOf(
  host: QueuedTurnReconcileHost,
  outcome: TurnOutcome,
  error?: { code: string; message: string },
): boolean {
  const turn = host.activeTurn();
  if (!turn || turnHasContentOf(host, turn)) return false;
  const suspended = host.suspendedTurns().splice(0);
  host.setActiveTurn(null);
  if (suspended.length > 0) {
    for (const old of suspended) host.inputTextByTurnId.delete(old.turnId);
    finalizeTurnContexts({
      turns: suspended,
      outcome,
      rowAt: host.rowAt,
      upsertRow: host.upsertRow,
      closeStreamingRows: () => {},
      turnFacts: host.turnFacts,
    });
  }
  host.queuedTurns.push(turn);
  host.patchState(terminalControlPatch(host.state(), outcome, error));
  return true;
}

/** 轮内是否已有内容行（turnHeader/userInput 之外）；A5 判定 guide 轮是否已被承接。 */
function turnHasContentOf(host: QueuedTurnReconcileHost, turn: TurnContext): boolean {
  return host.rowIds.some((rowId) => {
    const row = host.rowAt(rowId);
    return (
      row !== undefined &&
      row.turnId === turn.turnId &&
      row.kind !== "turnHeader" &&
      row.kind !== "userInput"
    );
  });
}

/**
 * S4-1 seen 登记（「在场历史」）：omp 停止边界会把排队 follow_up 出队合并进同一 run 消费
 * 并回答（agent-loop.ts:1754-1763——任一 run 结束前 dequeue followUp 并 continue 同一 run，
 * 不产生新 agent_start，被消费文本的回复在同一 run 内流式输出），是主流路径。因此
 * 「terminal agent_end 快照缺席」不能一刀切 interrupted：只有曾在任一 omp 队列快照
 * （queue_update 事件载荷或空闲 get_state 的 queuedMessages，经 promptQueueReconciler
 * 传入，含流式 markOnly 调用）中「在场」过、或其 steer/follow_up 分发 success ACK 已到达
 * （F2b-P1：v18.4.8 上 ACK ⇒ 已入队，经 promptQueueReconciler.noteDispatchAckSeen 以
 * markOnly 单元素快照登记）的排队轮，缺席才说明已被停止边界 drain 消费。
 * 登记表以 TurnContext 对象身份为键的模块级 WeakSet：宿主实现对象
 * （conversationProjection 的 queuedReconcileHost）本次修复不变更，弱引用在轮收口后可
 * 回收，跨引擎实例按轮对象隔离互不影响。
 */
const queueSeenTurns = new WeakSet<TurnContext>();

/**
 * 对账模式通道：projection.reconcileQueuedTurns 签名固定为 (queueTexts: string[] | null)，
 * 模式以 unique symbol 属性附着在快照文本数组上随调用传入（ompQueueTextsOf 每次返回
 * 新数组，原地附着无跨调用副作用）：
 * - "markOnly"：流式中的快照——只登记 seen，不判定收口（既有不变式：流式中不判定）；
 * - "forceClose"：S4-2 宽限复查——复查快照仍缺席的从未 seen 轮按 interrupted 收口；
 * - 缺省：terminal agent_end / 空闲 debounce 对账——登记 seen；seen 且缺席按合并终态
 *   收口；从未 seen 且缺席保持排队（等待宽限复查）。
 */
export type QueueReconcileMode = "markOnly" | "forceClose";
export const QUEUE_RECONCILE_MODE: unique symbol = Symbol("omp-agent.queueReconcileMode");
type QueueReconcileTexts = string[] & { [QUEUE_RECONCILE_MODE]?: QueueReconcileMode };

/** 给快照文本数组附着对账模式（由 promptQueueReconciler 在调用对账前标记）。 */
export function markQueueReconcileTexts(texts: string[], mode: QueueReconcileMode): string[] {
  (texts as QueueReconcileTexts)[QUEUE_RECONCILE_MODE] = mode;
  return texts;
}

/**
 * 斜杠命令的命令名段：输入首个 ASCII 空白（空格、\t、\n、\v、\f、\r）前的段落
 * （"/deploy prod --yes" → "/deploy"，"/deploy" → "/deploy"）。不用正则匹配控制字符，
 * 逐字符扫描即可（omp 命令名不含这些字符之外的边界语义）。
 */
function slashCommandNameOf(inputText: string): string {
  for (let index = 0; index < inputText.length; index += 1) {
    const char = inputText[index];
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\v" ||
      char === "\f" ||
      char === "\r"
    ) {
      return inputText.slice(0, index);
    }
  }
  return inputText;
}

/**
 * 排队文本与 omp 队列快照文本匹配（S4-4，F2b-P2 收紧）：先按原文全等；omp 队列 chip 文本
 * 是模板展开/改写后的内容（agent-session.ts queueChipText 返回「入队后内容首个 text 块」
 * 而非提交原文），原文全等会对斜杠命令假缺席。对 "/" 开头的排队文本按命令名段比对：
 * chip 等于命令名段（裸命令 chip）或以「命令名段 + 空格」开头（同命令参数 chip）才命中。
 * 修复（F2b-P2/XR-B）：此前的 chip 前缀匹配（ompText.startsWith(inputText)）会让
 * "/deploy" 误命中不同命令的 chip "/deploy-prod"，把未消费的 /deploy 轮误标 seen，
 * 随后空快照再把它误收口 success。
 */
function queueTextMatchesOf(inputText: string, ompTexts: string[]): boolean {
  const commandName = slashCommandNameOf(inputText);
  return ompTexts.some(
    (ompText) =>
      ompText === inputText ||
      (inputText.startsWith("/") &&
        (ompText === commandName || ompText.startsWith(`${commandName} `))),
  );
}

/**
 * 队列对账（A3/S4-1/S4-2/S4-4）：以 omp 队列快照（steering+followUp 文本）对账本地排队轮。
 * omp 停止边界会把排队 follow_up 合并进同一 run 消费并回答（主流路径，见 queueSeenTurns
 * 注释），快照缺席不再一刀切 interrupted：
 * - 文本在场 → 登记 seen（含流式 markOnly 调用）并保持排队；
 * - seen 且现已缺席 → 已被停止边界 drain 消费，按合并终态收口（success，与 A4
 *   mergeQueuedTurnsIntoActiveOf 同语义）；
 * - 从未 seen 且缺席 → 可能在入队路上（S4-2：omp #queueUserMessage 对图片附件有秒级
 *   视觉描述延迟后才入队（agent-session.ts:8053-8170），新核输入门串行同理），保持排队，
 *   由 promptQueueReconciler 的宽限复查决定收口（复查仍缺席 forceClose → interrupted，
 *   需求 A1；复查前出现过再消失 → 按合并终态）。
 * 既有不变式保持：queueTexts 为 null（快照缺失/形状不明）不动（不确定→不动，绝不误关）；
 * 流式中只登记不收口；空文本轮（纯图片输入）无法匹配，不动。返回收口数。
 */
export function reconcileQueuedTurnsOf(
  host: QueuedTurnReconcileHost,
  queueTexts: string[] | null,
): number {
  if (queueTexts === null || host.queuedTurns.length === 0) return 0;
  const mode = (queueTexts as QueueReconcileTexts)[QUEUE_RECONCILE_MODE];
  const ompTexts = queueTexts.map((text) => text.trim());
  let closed = 0;
  for (let index = host.queuedTurns.length - 1; index >= 0; index -= 1) {
    const turn = host.queuedTurns[index]!;
    const text = (host.inputTextByTurnId.get(turn.turnId) ?? "").trim();
    if (text.length === 0) continue;
    if (queueTextMatchesOf(text, ompTexts)) {
      queueSeenTurns.add(turn);
      continue;
    }
    if (mode === "markOnly") continue;
    const consumed = queueSeenTurns.has(turn);
    if (!consumed && mode !== "forceClose") continue;
    host.queuedTurns.splice(index, 1);
    host.inputTextByTurnId.delete(turn.turnId);
    queueSeenTurns.delete(turn);
    finalizeTurnContexts({
      turns: [turn],
      // seen 且缺席 = 停止边界 drain 已合并消费（success，同 A4 合并收口）；从未 seen 且
      // 宽限复查仍缺席 = omp 丢弃或未入队（interrupted，需求 A1「取消/失败按 interrupted
      // /failed 收口」）。
      outcome: consumed ? "success" : "interrupted",
      rowAt: host.rowAt,
      upsertRow: host.upsertRow,
      closeStreamingRows: () => {},
      turnFacts: host.turnFacts,
    });
    closed += 1;
  }
  return closed;
}

/**
 * agent_start 合并收口（A4）：当前轮已占位（startNow 输入直接成为当前轮，或队首刚被
 * 激活）而仍有排队轮。已核对 omp 核心：新 prompt 的 run 在停止边界把 followUp 队列
 * 合并进同一 run（agent-loop.ts 停止边界 dequeue；agent-session.ts 用户 prompt 同时
 * 解除中断冻结），这些排队轮不会再获得独立 agent_start；收口为与当前轮合并的终态
 * （completedSuccess），输出统一归当前轮，避免永久 running。
 * 合并轮终态跟随当前 run 结果：omp 对被合并的 waiting prompt 会按 run 结果上报
 * prompt_result，若 run 失败本侧合并轮仍标 success，属已接受的显示失真（XR1 备注 3），
 * 未来可在 agent_end 失败时回写。
 */
export function mergeQueuedTurnsIntoActiveOf(host: QueuedTurnReconcileHost): void {
  if (host.queuedTurns.length === 0) return;
  const merged = host.queuedTurns.splice(0, host.queuedTurns.length);
  for (const turn of merged) host.inputTextByTurnId.delete(turn.turnId);
  finalizeTurnContexts({
    turns: merged,
    outcome: "success",
    rowAt: host.rowAt,
    upsertRow: host.upsertRow,
    closeStreamingRows: () => {},
    turnFacts: host.turnFacts,
  });
}
