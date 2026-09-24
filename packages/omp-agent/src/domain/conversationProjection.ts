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
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { createLogEpoch } from "./ids.js";
import { initialAState, type ProjectionAState, type TurnOutcome } from "./projectionTypes.js";
import { TurnFileFacts } from "./fileFacts.js";
import { mergeDeltas, type LoggedDelta } from "./deltaMerge.js";
import { contextWindowPatch, modelConfigPatch, runningControlPatch, terminalControlPatch, usagePatch } from "./projectionStatePatches.js";
import {
  createMarkerRow,
  createStreamingRow,
  createToolCallRow,
  createTurnHeaderRow,
  createUserInputRow,
  buildConversationSnapshot,
  mergeToolCallRow,
  type ToolCallUpsert,
  type TurnContext,
} from "./projectionRows.js";

export interface BeginTurnInput {
  text: string;
  inputId: string;
  sourceCommandId: string;
  clientId: string;
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
  private turnFacts = new Map<string, TurnFileFacts>();
  private lastErrorValue: { code: string; message: string } | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.state = initialAState({});
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
    this.turn = {
      turnId,
      productTurnId: turnId,
      headerRowId,
      fileFacts: new TurnFileFacts(),
      responseCounter: 0,
      streamingTextRow: null,
      streamingReasoningRow: null,
    };
    this.patchState(runningControlPatch());
  }

  markStopRequested(): void {
    if (this.state.control.phase !== "running") {
      return;
    }
    this.patchState({
      control: { ...this.state.control, canStop: false, stopState: "stopping" },
    });
  }

  /** 记录本轮错误事实（provider/运行时）；下一次 finishTurn 以 failed 收口。 */
  recordTurnError(error: { code: string; message: string }): void {
    this.lastErrorValue = error;
  }

  finishTurn(outcome: TurnOutcome, error?: { code: string; message: string }): void {
    const turn = this.turn;
    if (turn) {
      this.closeStreamingRows(outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "complete");
      // 保留本轮文件事实供 fileChanges 查询（有界，最近 20 轮）。
      this.turnFacts.set(turn.turnId, turn.fileFacts);
      if (this.turnFacts.size > 20) {
        const oldest = this.turnFacts.keys().next().value;
        if (oldest !== undefined) {
          this.turnFacts.delete(oldest);
        }
      }
      const header = this.rows.get(turn.headerRowId);
      if (header && header.kind === "turnHeader") {
        const files = turn.fileFacts.summary();
        this.upsertRow({
          ...header,
          state: outcome === "success" ? "completedSuccess" : outcome === "interrupted" ? "completedInterrupted" : "failed",
          endedAt: Date.now(),
          fileChanges: { additions: files.additions, deletions: files.deletions, files: files.files },
        });
      }
    }
    if (outcome === "failed") {
      this.lastErrorValue = error ?? { code: "runtime", message: "turn failed" };
    }
    this.patchState(terminalControlPatch(this.state, outcome, error));
    this.turn = null;
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

  private closeStreamingRows(finalState: "complete" | "interrupted" | "failed"): void {
    const turn = this.turn;
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
    if (!turn) {
      return;
    }
    const existing = [...this.rows.values()].find(
      (row): row is ToolCallRow => row.kind === "toolCall" && row.toolCallId === update.toolCallId,
    );
    const merged = existing
      ? mergeToolCallRow(existing, update)
      : createToolCallRow({
          rowId: this.nextRowId++,
          turnId: turn.turnId,
          productTurnId: turn.productTurnId,
          createdAtSeq: this.sequence + 1,
          ...update,
        });
    this.upsertRow(merged);
    // 文件事实以「已结束的工具调用」为准累计，供 turnHeader 摘要与 fileChanges 查询。
    if (update.status === "success" || update.status === "error") {
      turn.fileFacts.recordToolResult({
        toolName: update.toolName,
        input: typeof merged.input === "object" && merged.input !== null ? (merged.input as Record<string, unknown>) : undefined,
      });
      const header = this.rows.get(turn.headerRowId);
      if (header && header.kind === "turnHeader") {
        const files = turn.fileFacts.summary();
        this.upsertRow({
          ...header,
          fileChanges: { additions: files.additions, deletions: files.deletions, files: files.files },
        });
      }
    }
  }

  // ── 状态面 ──
  addUsage(delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    this.patchState(usagePatch(this.state, delta));
  }

  setContextWindow(usedTokens: number | null, maxTokens: number | null): void {
    this.patchState(contextWindowPatch(this.state, usedTokens, maxTokens));
  }

  setModelConfig(config: { provider?: string; model?: string; thought?: string; thoughtLevels?: string[] }): void {
    this.patchState(modelConfigPatch(this.state, config));
  }

  setTitle(title: string, source: "default" | "generated" | "custom"): void {
    this.patchState({ meta: { title, titleSource: source } });
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
    const row = this.rows.get(targetRowId);
    if (!row) {
      throw new Error("row not found");
    }
    const header = [...this.rows.values()].find((candidate) => candidate.kind === "turnHeader" && candidate.turnId === row.turnId);
    if (!header || header.kind !== "turnHeader") {
      return { files: 0, additions: 0, deletions: 0, items: [] };
    }
    const facts =
      this.turn && this.turn.turnId === row.turnId
        ? this.turn.fileFacts
        : this.turnFacts.get(row.turnId) ?? TurnFileFacts.fromSummary(header.fileChanges);
    return { ...facts.summary(), items: facts.items() };
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
    const ids = beforeRowId === undefined ? this.rowIds : this.rowIds.filter((id) => id < beforeRowId);
    const page = ids.slice(-limit);
    const first = page[0];
    return {
      rows: page.map((id) => this.rows.get(id)!),
      hasMore: first !== undefined && ids.indexOf(first) > 0,
    };
  }

  /** 冷恢复：把历史行直接放入投影（无订阅者时使用；不产生 delta）。 */
  hydrateRows(rows: ConversationRow[]): void {
    for (const row of rows) {
      this.rows.set(row.rowId, row);
      this.rowIds.push(row.rowId);
      this.nextRowId = Math.max(this.nextRowId, row.rowId + 1);
    }
    this.rowIds.sort((a, b) => a - b);
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
    this.rows.set(row.rowId, row);
    if (!this.rowIds.includes(row.rowId)) {
      this.rowIds.push(row.rowId);
    }
    this.pushPending({ op: "row.upserted", row });
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
