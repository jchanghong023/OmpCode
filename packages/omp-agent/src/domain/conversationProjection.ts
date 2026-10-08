// 会话投影唯一 owner（契约见 CONTRACT.md）：纯内存 rows/state → snapshot/delta；op 立即分配 seq，快照水位后只交付更大 seq；轮次、队列与行构造委托领域模块。

import { buildOmpSubagentViewId } from "./ompFrames.js";
import { consumeQueuedInputOf, publishQueuedInputsOf } from "./queuedInputProjection.js";
import {
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type PendingInteraction,
  type StatePatch,
  type TimelineMarkerPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { createLogEpoch } from "./ids.js";
import { initialAState, type ProjectionAState, type TurnOutcome } from "./projectionTypes.js";
import { TurnFileFacts } from "./fileFacts.js";
import { contextWindowPatch, modelConfigPatch, snoozePendingInteractions, usagePatch, withInteractionStopControl } from "./projectionStatePatches.js";
import { mergeDeltas, type LoggedDelta } from "./deltaMerge.js";
import { mergeProjectionRows } from "./projectionRowMerge.js";
import { OmpSubagentProjection } from "./ompSubagentDirectory.js";
import { readProjectionFileChanges } from "./projectionFileChanges.js";
import {
  beginUserTurnOf,
  failAllTurnsOf,
  failCommandTurnOf,
  finishQueuedLocalOnlyTurnOf,
  finishTurnOf,
  mergeQueuedTurnsIntoActiveOf,
  reconcileQueuedTurnsOf,
  requeueActiveTurnAsQueuedOf,
  type BeginTurnInput,
  type QueuedTurnReconcileHost,
} from "./queuedTurnReconcile.js";
import { applyProjectionToolCallUpdate } from "./projectionToolCallUpdate.js";
import { appendProjectionStreamDelta, closeProjectionStreamingRows, materializeStreamTextRow, type ProjectionStreamHost } from "./projectionStreamText.js";
import { conversationRowIdOfToolCall, createMarkerRow, buildConversationSnapshot, conversationRowsRange, type ToolCallUpsert, type TurnContext } from "./projectionRows.js";
import { appendOmpCustomMessage } from "./OmpCustomMessage.js";
import { appendOmpCommandOutput, type OmpCommandOutputRecord } from "./OmpCommandOutput.js";
import { ensureOmpNativeTurn } from "./ompNativeTurn.js";
import { ompTodoState, ompTodoStateFromRows } from "./ompTodoPlan.js";

export type { BeginTurnInput } from "./queuedTurnReconcile.js";

export class ConversationProjection {
  readonly sessionId: string;
  readonly logEpoch: string = createLogEpoch();
  private sequence = 0;
  private revisionValue = 0;
  private rows = new Map<number, ConversationRow>();
  private pendingStreamTextByRowId = new Map<number, string[]>();
  private rowIds: number[] = [];
  private nextRowId = 1;
  private state: ProjectionAState;
  private deltaLog: LoggedDelta[] = [];
  private pending: LoggedDelta[] = [];
  private turn: TurnContext | null = null;
  private suspendedTurns: TurnContext[] = [];
  private queuedTurns: TurnContext[] = [];
  private turnFacts = new Map<string, TurnFileFacts>();
  /** 各轮输入文本（turnId → text）：队列对账（A3）匹配 omp 队列快照用；轮收口时清理。 */
  private inputTextByTurnId = new Map<string, string>();
  private readonly queuedReconcileHost: QueuedTurnReconcileHost = {
    queuedTurns: this.queuedTurns,
    inputTextByTurnId: this.inputTextByTurnId,
    rowIds: this.rowIds,
    rowAt: (rowId) => this.rows.get(rowId),
    upsertRow: (row) => this.upsertRow(row),
    turnFacts: this.turnFacts,
    activeTurn: () => this.turn,
    setActiveTurn: (turn) => {
      this.turn = turn;
    },
    suspendedTurns: () => this.suspendedTurns,
    patchState: (patch) => this.patchState(patch),
    state: () => this.state,
    seq: () => this.sequence,
    nextRowId: () => this.nextRowId++,
    appendRow: (row) => this.appendRow(row),
    setLastError: (error) => (this.lastErrorValue = error),
    closeStreamingRows: (finalState, turn) => closeProjectionStreamingRows(this.streamHost, finalState, turn),
  };
  private readonly streamHost: ProjectionStreamHost = {
    rows: this.rows,
    pendingStreamTextByRowId: this.pendingStreamTextByRowId,
    turn: () => this.turn,
    sequence: () => this.sequence,
    nextRowId: () => this.nextRowId++,
    appendRow: (row) => this.appendRow(row),
    upsertRow: (row) => this.upsertRow(row),
    pushPending: (delta) => this.pushPending(delta),
  };
  private lastErrorValue: { code: string; message: string } | null = null;
  private readonly subagents: OmpSubagentProjection;
  // 子代理地址携带父会话归属；无父会话语义的只读视图由 EngineInit 覆盖。
  constructor(sessionId: string, viewIdOf: (subagentId: string) => string = (id) => buildOmpSubagentViewId(sessionId, id)) {
    this.sessionId = sessionId;
    this.state = initialAState({});
    this.subagents = new OmpSubagentProjection({
      rowAt: (id) => this.rows.get(id),
      turnAnchor: () => {
        const row = this.turn ?? [...this.rows.values()].reverse().find((r) => r.kind === "turnHeader");
        return row ? { turnId: row.turnId, productTurnId: row.productTurnId ?? row.turnId } : null;
      },
      nextRowId: () => this.nextRowId++,
      sequence: () => this.sequence,
      state: () => this.state.subagents,
      upsertRow: (row) => this.upsertRow(row),
      patchState: (subagents) => this.patchState({ subagents }),
      viewIdOf,
    });
  }
  get seq(): number {
    return this.sequence;
  }
  get revision(): number {
    return this.revisionValue;
  }
  get stateSnapshot(): ProjectionAState {
    return this.state;
  }
  get lastError(): { code: string; message: string } | null {
    return this.lastErrorValue;
  }
  beginUserTurn(input: BeginTurnInput): void {
    beginUserTurnOf(this.queuedReconcileHost, input);
    publishQueuedInputsOf(this.queuedReconcileHost);
  }
  activateQueuedTurn(text?: string, native = false): void {
    consumeQueuedInputOf(this.queuedReconcileHost, text);
    if (native) ensureOmpNativeTurn(this.queuedReconcileHost, text);
  }
  /** 本地命令没有 agent_start；上一轮结束后由完成事实激活并收口队首。 */
  finishQueuedLocalOnlyTurn(sourceCommandId?: string): boolean {
    return finishQueuedLocalOnlyTurnOf(
      this.queuedReconcileHost,
      () => this.closeAssistantResponse(),
      (outcome) => this.finishTurn(outcome),
      sourceCommandId,
    );
  }
  failCommandTurn(sourceCommandId: string, error: { code: string; message: string }): void {
    failCommandTurnOf(this.queuedReconcileHost, sourceCommandId, error, (failure) => {
      this.recordTurnError(failure);
      this.finishTurn("failed", failure);
    });
  }
  failAllTurns(error: { code: string; message: string }): void {
    failAllTurnsOf(this.queuedReconcileHost, error, (sourceCommandId, failure) => this.failCommandTurn(sourceCommandId, failure));
  }
  markStopRequested(): void {
    if (!this.state.control.canStop) return;
    this.patchState({ control: { ...this.state.control, canStop: false, stopState: "stopping" } });
  }
  /** 记录本轮错误事实（provider/运行时）；下一次 finishTurn 以 failed 收口；null 清除（omp 自动重试成功）。 */
  recordTurnError(error: { code: string; message: string } | null): void {
    this.lastErrorValue = error;
  }
  finishTurn(outcome: TurnOutcome, error?: { code: string; message: string }): void {
    finishTurnOf(this.queuedReconcileHost, outcome, error);
  }
  hasQueuedTurns(): boolean {
    return this.queuedTurns.length > 0;
  }
  /**
   * 队列对账（A3）：判定与收口逻辑在 queuedTurnReconcile.ts（对账语义注释见该模块）；
   * 返回收口数。
   */
  reconcileQueuedTurns(queueTexts: string[] | null): number {
    return reconcileQueuedTurnsOf(this.queuedReconcileHost, queueTexts);
  }
  /** agent_start 合并收口（A4）：合并语义与显示失真备注见 queuedTurnReconcile.ts。 */
  mergeQueuedTurnsIntoActive(): void {
    if (this.turn === null) return;
    mergeQueuedTurnsIntoActiveOf(this.queuedReconcileHost);
  }
  /** 当前活跃轮的 sourceCommandId（无活跃轮为 null；A5 steer 在途判定用）。 */
  activeTurnSourceCommandId(): string | null {
    return this.turn?.sourceCommandId ?? null;
  }
  /** steer 在途竞态（A5）：完整竞态语义与时序见 queuedTurnReconcile.ts；返回 false 时调用方按常规 agent_end 收口。 */
  requeueActiveTurnAsQueued(outcome: TurnOutcome, error?: { code: string; message: string }): boolean {
    return requeueActiveTurnAsQueuedOf(this.queuedReconcileHost, outcome, error);
  }
  appendAssistantText(delta: string): void {
    appendProjectionStreamDelta(this.streamHost, delta, "assistantText");
  }
  appendCustomMessage(message: unknown): void {
    appendOmpCustomMessage(this.streamHost, message);
  }
  appendCommandOutput(record: OmpCommandOutputRecord): void {
    appendOmpCommandOutput(this.streamHost, record);
  }
  appendReasoning(delta: string): void {
    appendProjectionStreamDelta(this.streamHost, delta, "reasoning");
  }
  // 模型响应结束（message_end）：关闭本响应的流式行；下一次文本增量开新行。
  closeAssistantResponse(): void {
    closeProjectionStreamingRows(this.streamHost, "complete", this.turn);
    const turn = this.turn;
    if (turn) {
      turn.streamingTextRow = null;
      turn.streamingReasoningRow = null;
    }
  }

  upsertToolCall(update: ToolCallUpsert): void {
    const turn = this.turn;
    if (!turn) return;
    applyProjectionToolCallUpdate({
      turn,
      update,
      createdAtSeq: this.sequence + 1,
      rows: this.rows.values(),
      nextRowId: () => this.nextRowId++,
      rowAt: (rowId) => this.rows.get(rowId),
      upsertRow: (row) => this.upsertRow(row),
    });
  }

  /** 无主 transcript 的辅助投影：仍由同一序列发布状态，不操作主 turn/queue。 */
  patchSideViewState(patch: Pick<StatePatch, "control" | "inputRouting" | "availability" | "config">): void {
    this.patchState(patch);
  }
  addUsage(delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    this.patchState(usagePatch(this.state, delta));
  }

  setContextWindow(usedTokens: number | null, maxTokens: number | null, report?: import("./ompContextReport.js").OmpContextReport | null): void {
    this.patchState(contextWindowPatch(this.state, usedTokens, maxTokens, report));
  }
  setModelConfig(config: { provider?: string; model?: string; thought?: string; thoughtLevels?: string[]; followupMode?: "queue" | "guide"; autoCompactionEnabled?: boolean }): void {
    this.patchState(modelConfigPatch(this.state, config));
  }
  setTitle(title: string, source: "default" | "generated" | "custom"): void {
    this.patchState({ meta: { title, titleSource: source } });
  }

  upsertSubagent(input: Parameters<OmpSubagentProjection["upsert"]>[0]): void {
    this.subagents.upsert(input);
  }
  setSubagentAvailability(availability: "ready" | "unavailable"): void {
    this.subagents.setAvailability(availability);
  }
  subagentDirectory(offset = 0, limit = 20) {
    return this.subagents.directory(offset, limit);
  }
  addPendingInteraction(interaction: PendingInteraction): void {
    this.patchState({ pendingInteractions: [...this.state.pendingInteractions, interaction] });
  }

  resolvePendingInteraction(interactionId: string): void {
    this.patchState({ pendingInteractions: this.state.pendingInteractions.filter((item) => item.interactionId !== interactionId) });
  }

  /** AskUserQuestion 首次交互暂停倒计时：autoResolution 置 snoozed（omp 侧 ask_pause 由交互代理发送）。 */
  snoozeInteractionAutoResolution(interactionId: string): void {
    const pendingInteractions = snoozePendingInteractions(this.state.pendingInteractions, interactionId);
    if (pendingInteractions) this.patchState({ pendingInteractions });
  }

  /** 权限卡锚定：按 omp toolCallId 找最近一条工具行（找不到返回 null）。 */
  rowIdOfToolCall(toolCallId: string): number | null {
    return conversationRowIdOfToolCall(this.rows, this.rowIds, toolCallId);
  }

  addTimelineMarker(marker: TimelineMarkerPayload): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    const rowId = this.nextRowId++;
    this.appendRow(createMarkerRow({ rowId, turnId: turn.turnId, productTurnId: turn.productTurnId, createdAtSeq: this.sequence + 1, marker }));
  }

  fileChangesForTarget(targetRowId: number): { files: number; additions: number; deletions: number; items: ReturnType<TurnFileFacts["items"]> } {
    return readProjectionFileChanges(targetRowId, this.rows, this.turn, this.turnFacts);
  }

  buildSnapshot(): ConversationSnapshot {
    return buildConversationSnapshot(
      {
        sessionId: this.sessionId,
        logEpoch: this.logEpoch,
        seq: this.sequence,
        revision: this.revisionValue,
        state: this.state,
        rowIds: this.rowIds,
        rowAt: (rowId) => this.materializeStreamTextRow(rowId),
      },
      PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
    );
  }

  rowsRange(beforeRowId: number | undefined, limit: number): { rows: ConversationRow[]; hasMore: boolean } {
    return conversationRowsRange(this.rowIds, (id) => this.materializeStreamTextRow(id), beforeRowId, limit);
  }

  /** 冷恢复：把历史行直接放入投影（无订阅者时使用；不产生 delta）。 */
  hydrateRows(rows: ConversationRow[]): void {
    rows = rows.map((row) => this.subagents.withViewId(row));
    for (const row of rows) {
      this.rows.set(row.rowId, row);
      this.rowIds.push(row.rowId);
      this.claimRowId(row.rowId);
    }
    this.rowIds.sort((a, b) => a - b);
    this.state = { ...this.state, subagents: this.subagents.hydrate(rows), plan: ompTodoStateFromRows(rows) };
  }

  /** 只读详情视图的事件驱动重水合：全量重读行幂等合并（新行 append、同 rowId 内容变化才 upsert），订阅端实时增长且无重复行。 */
  mergeRows(rows: ConversationRow[]): void {
    rows = rows.map((row) => this.subagents.withViewId(row));
    mergeProjectionRows({ rows: this.rows, claimRowId: (rowId) => this.claimRowId(rowId), appendRow: (row) => this.appendRow(row), upsertRow: (row) => this.upsertRow(row) }, rows);
  }
  /** 只读记录重写：同一 owner 发删除屏障再追加，实时/恢复订阅看到相同替换结果。 */
  replaceHydratedRows(rows: ConversationRow[]): void {
    rows = rows.map((row) => this.subagents.withViewId(row));
    if (this.rowIds.length > 0) this.pushPending({ op: "row.removed", fromRowId: this.rowIds[0]! });
    this.rows.clear();
    this.pendingStreamTextByRowId.clear();
    this.rowIds.length = 0;
    for (const row of rows) {
      this.claimRowId(row.rowId);
      this.appendRow(row);
    }
    this.patchState({ subagents: this.subagents.hydrate(rows), plan: ompTodoStateFromRows(rows) });
  }

  /** pending → delta log（合并连续同构 op）；返回合并后的列表。 */
  drainPendingDeltas(): ConversationDelta[] {
    publishQueuedInputsOf(this.queuedReconcileHost);
    if (this.pending.length === 0) {
      return [];
    }
    const merged = mergeDeltas(this.pending);
    this.pending = [];
    this.deltaLog.push(...merged);
    this.trimDeltaLog();
    return merged.map((entry) => entry.delta);
  }

  /** (fromSeq, toSeq] 的增量；水位早于 log 覆盖范围时返回 null（需要 snapshot）。 */
  deltasBetween(fromSeq: number, toSeq: number): ConversationDelta[] | null {
    if (toSeq <= fromSeq) {
      return [];
    }
    if (this.deltaLog.length === 0 || this.deltaLog[0]!.seq > fromSeq + 1) {
      return null;
    }
    return this.deltaLog.filter((entry) => entry.seq > fromSeq && entry.seq <= toSeq).map((entry) => entry.delta);
  }

  private appendRow(row: ConversationRow): void {
    this.rows.set(row.rowId, row);
    this.rowIds.push(row.rowId);
    this.pushPending({ op: "row.appended", row });
    const plan = ompTodoState(row);
    if (plan !== undefined) this.patchState({ plan });
  }

  /** 水合/合并行自带稳定 rowId：只抬升分配下界，不回收编号。 */
  private claimRowId(rowId: number): void {
    this.nextRowId = Math.max(this.nextRowId, rowId + 1);
  }

  private upsertRow(row: ConversationRow): void {
    // Bug 根因：首次工具/子代理行误发 row.upserted，桌面增量客户端对未知 rowId
    // 按协议忽略，导致运行态只有状态计数、没有可见记录；首次必须 append。
    const isNew = !this.rows.has(row.rowId);
    this.rows.set(row.rowId, row);
    if (isNew) {
      this.rowIds.push(row.rowId);
    }
    this.pushPending(isNew ? { op: "row.appended", row } : { op: "row.upserted", row });
    const plan = ompTodoState(row);
    if (plan !== undefined) this.patchState({ plan });
  }
  private materializeStreamTextRow = (rowId: number): ConversationRow | undefined => materializeStreamTextRow(this.rows, this.pendingStreamTextByRowId, rowId);

  private patchState(patch: StatePatch): void {
    patch = withInteractionStopControl(this.state, patch);
    this.state = { ...this.state, ...patch } as ProjectionAState;
    this.revisionValue += 1;
    this.pushPending({ op: "state.updated", patch: { ...patch, revision: this.revisionValue } as StatePatch });
  }

  private pushPending(delta: ConversationDelta): void {
    this.sequence += 1;
    this.pending.push({ seq: this.sequence, delta });
  }

  private trimDeltaLog(): void {
    const cap = PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    if (this.deltaLog.length > cap) {
      this.deltaLog.splice(0, this.deltaLog.length - cap);
    }
  }
}
