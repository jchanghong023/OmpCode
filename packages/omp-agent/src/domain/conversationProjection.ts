// 会话投影状态机：把「输入/流式/工具/状态」变化折叠成 v4 conversation 的 rows+state，
// 并产出 snapshot / deltas。纯内存、无 IO；权威 schema 校验发生在发送边界（adapters）。
//
// seq 语义：每个增量 op 在产生时立即分配 seq（帧区间 (fromSeq, toSeq] 的记账基础）；
// pending 列表只是「尚未进入 delta log 的 op」，snapshot 恒以当前 seq 为准，
// 因此任意订阅者以 watermark=seq 收快照后，后续只会收到 seq 更大的 op，不会重复施加。
//
// 行对象组装在 projectionRows.ts；增量合并在 deltaMerge.ts（架构 maxFileLines=400）。

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
import { contextWindowPatch, modelConfigPatch, runningControlPatch, terminalControlPatch, usagePatch } from "./projectionStatePatches.js";
import { mergeDeltas, type LoggedDelta } from "./deltaMerge.js";
import { OmpSubagentProjection } from "./ompSubagentDirectory.js";
import { readProjectionFileChanges } from "./projectionFileChanges.js";
import { finalizeFailedQueuedTurn, finalizeTurnContexts } from "./projectionTurnFinalizer.js";
import { applyProjectionToolCallUpdate } from "./projectionToolCallUpdate.js";
import {
  createMarkerRow,
  createStreamingRow,
  createTurnHeaderRow,
  createUserInputRow,
  buildConversationSnapshot,
  conversationRowsRange,
  type ToolCallUpsert,
  type TurnContext,
} from "./projectionRows.js";

export interface BeginTurnInput {
  text: string;
  inputId: string;
  sourceCommandId: string;
  clientId: string;
  routing?: "startNow" | "guide" | "queue";
}

export class ConversationProjection {
  readonly sessionId: string;
  readonly logEpoch: string = createLogEpoch();
  private sequence = 0;
  private revisionValue = 0;
  private rows = new Map<number, ConversationRow>();
  private rowIds: number[] = [];
  private nextRowId = 1;
  private state: ProjectionAState;
  private deltaLog: LoggedDelta[] = [];
  private pending: LoggedDelta[] = [];
  private turn: TurnContext | null = null;
  private suspendedTurns: TurnContext[] = [];
  private queuedTurns: TurnContext[] = [];
  private turnFacts = new Map<string, TurnFileFacts>();
  private lastErrorValue: { code: string; message: string } | null = null;
  private readonly subagents: OmpSubagentProjection;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.state = initialAState({});
    this.subagents = new OmpSubagentProjection({
      rowAt: (id) => this.rows.get(id),
      turnAnchor: () => {
        const row = this.turn ?? [...this.rows.values()].reverse().find((candidate) => candidate.kind === "turnHeader");
        return row ? { turnId: row.turnId, productTurnId: row.productTurnId ?? row.turnId } : null;
      },
      nextRowId: () => this.nextRowId++,
      sequence: () => this.sequence,
      state: () => this.state.subagents,
      upsertRow: (row) => this.upsertRow(row),
      patchState: (subagents) => this.patchState({ subagents }),
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
  // ── 轮次与输入 ──
  beginUserTurn(input: BeginTurnInput): void {
    this.lastErrorValue = null;
    const turnNumber = this.rowIds.filter((id) => this.rows.get(id)?.kind === "turnHeader").length + 1;
    const turnId = `turn-${turnNumber}-${input.inputId}`;
    const init = { turnId, productTurnId: turnId, createdAtSeq: this.sequence + 1 };
    const headerRowId = this.nextRowId++;
    const userRowId = this.nextRowId++;
    this.appendRow(
      createTurnHeaderRow({ ...init, rowId: headerRowId, sourceCommandId: input.sourceCommandId, historyRoundCount: turnNumber - 1 }),
    );
    this.appendRow(
      createUserInputRow({ ...init, rowId: userRowId, text: input.text, sourceCommandId: input.sourceCommandId, clientId: input.clientId }),
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
    // 冷启动双投递都可能标成 startNow；有活跃轮时须排队，避免覆盖旧 TurnContext。
    if (this.turn && input.routing !== "guide") {
      // omp follow_up 只在当前 agent_end 之后启动；现有输出仍归原轮。
      this.queuedTurns.push(nextTurn);
    } else {
      if (input.routing === "guide" && this.turn) {
        // steer 在当前 agent 内生效；保留旧轮供同一 agent_end 收口。
        this.closeStreamingRows("complete");
        this.suspendedTurns.push(this.turn);
      }
      this.turn = nextTurn;
      this.patchState(runningControlPatch());
    }
  }
  activateQueuedTurn(): void {
    if (this.turn || this.queuedTurns.length === 0) return;
    this.turn = this.queuedTurns.shift() ?? null;
    if (this.turn) this.patchState(runningControlPatch());
  }
  /** 本地命令没有 agent_start；上一轮结束后由完成事实激活并收口队首。 */
  finishQueuedLocalOnlyTurn(): boolean {
    if (this.turn) return false;
    this.activateQueuedTurn();
    if (!this.turn) return false;
    this.closeAssistantResponse();
    this.finishTurn("success");
    return true;
  }
  failCommandTurn(sourceCommandId: string, error: { code: string; message: string }): void {
    if (finalizeFailedQueuedTurn({
      queuedTurns: this.queuedTurns, sourceCommandId, turnFacts: this.turnFacts,
      rowAt: (rowId) => this.rows.get(rowId), upsertRow: (row) => this.upsertRow(row),
    })) return;
    this.recordTurnError(error);
    this.finishTurn("failed", error);
  }
  failAllTurns(error: { code: string; message: string }): void {
    this.failCommandTurn(this.turn?.sourceCommandId ?? "", error);
    while (this.queuedTurns.length > 0) {
      const next = this.queuedTurns[0];
      if (!next) break;
      this.failCommandTurn(next.sourceCommandId, error);
    }
  }
  markStopRequested(): void {
    if (this.state.control.phase !== "running") {
      return;
    }
    this.patchState({
      control: { ...this.state.control, canStop: false, stopState: "stopping" },
    });
  }
  /** 记录本轮错误事实（provider/运行时）；下一次 finishTurn 以 failed 收口；null 清除（omp 自动重试成功）。 */
  recordTurnError(error: { code: string; message: string } | null): void {
    this.lastErrorValue = error;
  }
  finishTurn(outcome: TurnOutcome, error?: { code: string; message: string }): void {
    const turn = this.turn;
    if (!turn && this.suspendedTurns.length === 0) return;
    finalizeTurnContexts({
      turns: [...this.suspendedTurns, ...(turn ? [turn] : [])], outcome,
      rowAt: (rowId) => this.rows.get(rowId), upsertRow: (row) => this.upsertRow(row),
      closeStreamingRows: (active) => this.closeStreamingRows(outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "complete", active),
      turnFacts: this.turnFacts,
    });
    if (outcome === "failed") {
      this.lastErrorValue = error ?? { code: "runtime", message: "turn failed" };
    }
    this.patchState(terminalControlPatch(this.state, outcome, error));
    this.turn = null;
    this.suspendedTurns = [];
  }
  // ── 流式文本与思考 ──
  appendAssistantText(delta: string): void {
    this.appendStreamDelta(delta, "assistantText");
  }
  appendReasoning(delta: string): void {
    this.appendStreamDelta(delta, "reasoning");
  }
  private appendStreamDelta(delta: string, kind: "assistantText" | "reasoning"): void {
    if (!this.turn || delta.length === 0) {
      return;
    }
    const anchorKey = kind === "assistantText" ? "streamingTextRow" : "streamingReasoningRow";
    if (!this.turn[anchorKey]) {
      this.turn.responseCounter += 1;
      const rowId = this.nextRowId++;
      this.appendRow(
        createStreamingRow({
          rowId,
          turnId: this.turn.turnId,
          productTurnId: this.turn.productTurnId,
          createdAtSeq: this.sequence + 1,
          kind,
          responseCounter: this.turn.responseCounter,
        }),
      );
      this.turn[anchorKey] = { rowId, entityId: `resp-${this.turn.turnId}-${this.turn.responseCounter}-${kind === "assistantText" ? "text" : "reasoning"}` };
    }
    const anchor = this.turn[anchorKey]!;
    // 行对象同步累积正文：snapshot/rowsRange 的读者不该被要求重放 row.delta。
    const row = this.rows.get(anchor.rowId);
    if (row && (row.kind === "assistantText" || row.kind === "reasoning")) {
      this.rows.set(anchor.rowId, { ...row, text: row.text + delta });
    }
    this.pushPending({ op: "row.delta", rowId: anchor.rowId, path: "text", append: delta });
  }
  /** 模型响应结束（message_end）：关闭本响应的流式行；下一次文本增量开新行。 */
  closeAssistantResponse(): void {
    this.closeStreamingRows("complete");
    if (this.turn) {
      this.turn.streamingTextRow = null;
      this.turn.streamingReasoningRow = null;
    }
  }

  private closeStreamingRows(finalState: "complete" | "interrupted" | "failed", turn = this.turn): void {
    if (!turn) {
      return;
    }
    for (const anchor of [turn.streamingTextRow, turn.streamingReasoningRow]) {
      if (!anchor) {
        continue;
      }
      const row = this.rows.get(anchor.rowId);
      if (!row) {
        continue;
      }
      if (row.kind === "assistantText" && row.state === "streaming") {
        this.upsertRow({ ...row, state: finalState });
      } else if (row.kind === "reasoning" && row.state === "streaming" && finalState !== "failed") {
        this.upsertRow({ ...row, state: finalState });
      }
    }
  }

  // ── 工具调用 ──
  upsertToolCall(update: ToolCallUpsert): void {
    const turn = this.turn;
    if (!turn) return;
    applyProjectionToolCallUpdate({
      turn, update, createdAtSeq: this.sequence + 1, rows: this.rows.values(),
      nextRowId: () => this.nextRowId++, rowAt: (rowId) => this.rows.get(rowId),
      upsertRow: (row) => this.upsertRow(row),
    });
  }

  // ── 状态面 ──
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
  setSubagentAvailability(availability: "ready" | "unavailable"): void { this.subagents.setAvailability(availability); }
  subagentDirectory(offset = 0) {
    return this.subagents.directory(offset);
  }
  addPendingInteraction(interaction: PendingInteraction): void {
    this.patchState({ pendingInteractions: [...this.state.pendingInteractions, interaction] });
  }

  resolvePendingInteraction(interactionId: string): void {
    this.patchState({
      pendingInteractions: this.state.pendingInteractions.filter((item) => item.interactionId !== interactionId),
    });
  }

  addTimelineMarker(marker: TimelineMarkerPayload): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    const rowId = this.nextRowId++;
    this.appendRow(
      createMarkerRow({ rowId, turnId: turn.turnId, productTurnId: turn.productTurnId, createdAtSeq: this.sequence + 1, marker }),
    );
  }

  fileChangesForTarget(targetRowId: number): { files: number; additions: number; deletions: number; items: ReturnType<TurnFileFacts["items"]> } {
    return readProjectionFileChanges(targetRowId, this.rows, this.turn, this.turnFacts);
  }

  // ── 读面 ──
  buildSnapshot(): ConversationSnapshot {
    return buildConversationSnapshot(
      {
        sessionId: this.sessionId,
        logEpoch: this.logEpoch,
        seq: this.sequence,
        revision: this.revisionValue,
        state: this.state,
        rowIds: this.rowIds,
        rowAt: (rowId) => this.rows.get(rowId),
      },
      PROTOCOL_V4_LIMITS.snapshotTailWindowRows,
    );
  }

  rowsRange(beforeRowId: number | undefined, limit: number): { rows: ConversationRow[]; hasMore: boolean } {
    return conversationRowsRange(this.rowIds, (id) => this.rows.get(id), beforeRowId, limit);
  }

  /** 冷恢复：把历史行直接放入投影（无订阅者时使用；不产生 delta）。 */
  hydrateRows(rows: ConversationRow[]): void {
    for (const row of rows) {
      this.rows.set(row.rowId, row);
      this.rowIds.push(row.rowId);
      this.nextRowId = Math.max(this.nextRowId, row.rowId + 1);
    }
    this.rowIds.sort((a, b) => a - b);
    this.state = { ...this.state, subagents: this.subagents.hydrate(rows) };
  }

  /** pending → delta log（合并连续同构 op）；返回合并后的列表。 */
  drainPendingDeltas(): ConversationDelta[] {
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
  }

  private patchState(patch: StatePatch): void {
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
