import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  createDraftUnit,
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  refreshRenderUnitClock,
  shouldKeepRenderUnit,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnRenderUnit,
  type DraftTurnRenderUnit,
} from "./conversationTurnRenderUnits.js";

interface CachedTurnRenderUnit {
  draft: DraftTurnRenderUnit;
  rowIndices: number[];
  unit: ConversationTurnRenderUnit;
  /** -1 表示当前轮只有不可见行，仍保留分组以便后续变为可见。 */
  resultIndex: number;
}

function appendDraftRow(draft: DraftTurnRenderUnit, row: ConversationRow): void {
  if (row.kind === "turnHeader") {
    draft.header = row;
    return;
  }
  draft.orderedRows.push(row);
  if (row.kind === "userInput") draft.userInputs.push(row);
  else if (row.kind === "hookInvocation") draft.hookInvocations.push(row);
  else draft.assistantWorkRows.push(row);
}

function sameDraftRows(previous: DraftTurnRenderUnit, next: DraftTurnRenderUnit): boolean {
  return (
    previous.header === next.header &&
    previous.orderedRows.length === next.orderedRows.length &&
    previous.orderedRows.every((row, index) => row === next.orderedRows[index])
  );
}

function realQueryRowIds(unit: ConversationTurnRenderUnit): number[] {
  return unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId);
}

/** 仅保存可由传入的不可变 rows 重新计算的 UI 派生值；不持有会话事实。 */
export class ConversationTurnRenderCache {
  private rows?: readonly ConversationRow[];
  private entries = new Map<string, CachedTurnRenderUnit>();
  private result: ConversationTurnRenderUnit[] = [];
  private options: BuildConversationTurnRenderUnitsOptions = {};
  private runningTurns = new Set<string>();
  private headerlessTurns = new Set<string>();
  /** 计时与助手文本更新不改变查询成员，导航回调可复用同一个 Set。 */
  queryRowIds = new Set<number>();

  get hasRunningUnit(): boolean {
    return this.runningTurns.size > 0;
  }

  build(
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions,
  ): ConversationTurnRenderUnit[] {
    if (!this.rows || this.rows.length !== rows.length) return this.rebuild(rows, options);
    const dirtyTurns = new Set<string>();
    if (this.rows !== rows) {
      // Bug 根因：旧缓存命中仍重分组所有行、逐轮比较并重建 Map。
      // 投影窗口没有 delta 提示时只做一次引用扫描；结构稳定时只重建变化轮。
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const previous = this.rows[index]!;
        if (row === previous) continue;
        if (row.rowId !== previous.rowId || row.turnId !== previous.turnId) {
          return this.rebuild(rows, options);
        }
        dirtyTurns.add(row.turnId);
      }
    }
    if (this.options.sessionPhase !== options.sessionPhase) {
      // 有 header 的轮次以投影终态为权威，只有旧数据缺 header 时依赖 session phase。
      for (const turnId of this.headerlessTurns) dirtyTurns.add(turnId);
    }
    const changedEntries = new Set<CachedTurnRenderUnit>();
    let visibilityChanged = false;
    for (const turnId of dirtyTurns) {
      const entry = this.entries.get(turnId)!;
      const draft = createDraftUnit(turnId);
      for (const index of entry.rowIndices) appendDraftRow(draft, rows[index]!);
      entry.draft = draft;
      const unit = materializeDraftUnit(draft, entry.resultIndex, this.result.length, options);
      this.updateQueryRows(entry.unit, unit);
      visibilityChanged ||= shouldKeepRenderUnit(unit) !== entry.resultIndex >= 0;
      entry.unit = unit;
      this.updateMembership(entry);
      changedEntries.add(entry);
    }
    if (this.options.nowMs !== options.nowMs) {
      // 计时不读取历史行，也不重新构造工作分段；只更新运行轮的时长派生值。
      for (const turnId of this.runningTurns) {
        if (dirtyTurns.has(turnId)) continue;
        const entry = this.entries.get(turnId)!;
        const unit = refreshRenderUnitClock(entry.unit, options.nowMs);
        if (unit !== entry.unit) {
          entry.unit = unit;
          changedEntries.add(entry);
        }
      }
    }
    if (visibilityChanged) this.rebuildVisibleResult(options);
    else if (changedEntries.size > 0) {
      const result = this.result.slice();
      for (const entry of changedEntries) {
        if (entry.resultIndex < 0) continue;
        entry.unit = normalizeRenderUnitPosition(
          entry.unit,
          entry.resultIndex,
          result.length,
          options,
        );
        result[entry.resultIndex] = entry.unit;
      }
      this.result = result;
    }
    this.rows = rows;
    this.options = options;
    return this.result;
  }

  private updateMembership(entry: CachedTurnRenderUnit): void {
    if (entry.unit.isRunning) this.runningTurns.add(entry.draft.turnId);
    else this.runningTurns.delete(entry.draft.turnId);
    if (entry.draft.header) this.headerlessTurns.delete(entry.draft.turnId);
    else this.headerlessTurns.add(entry.draft.turnId);
  }

  private updateQueryRows(
    previous: ConversationTurnRenderUnit,
    next: ConversationTurnRenderUnit,
  ): void {
    const previousIds = realQueryRowIds(previous);
    const nextIds = realQueryRowIds(next);
    if (
      previousIds.length === nextIds.length &&
      previousIds.every((id, index) => id === nextIds[index])
    )
      return;
    const queryRowIds = new Set(this.queryRowIds);
    for (const rowId of previousIds) queryRowIds.delete(rowId);
    for (const rowId of nextIds) queryRowIds.add(rowId);
    this.queryRowIds = queryRowIds;
  }

  private rebuild(
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions,
  ): ConversationTurnRenderUnit[] {
    const drafts = new Map<string, { draft: DraftTurnRenderUnit; rowIndices: number[] }>();
    rows.forEach((row, index) => {
      let group = drafts.get(row.turnId);
      if (!group) {
        group = { draft: createDraftUnit(row.turnId), rowIndices: [] };
        drafts.set(row.turnId, group);
      }
      appendDraftRow(group.draft, row);
      group.rowIndices.push(index);
    });
    const entries = new Map<string, CachedTurnRenderUnit>();
    const queryRowIds = new Set<number>();
    this.runningTurns.clear();
    this.headerlessTurns.clear();
    for (const [turnId, { draft, rowIndices }] of drafts) {
      const previous = this.entries.get(turnId);
      const reusable =
        previous &&
        sameDraftRows(previous.draft, draft) &&
        (draft.header || this.options.sessionPhase === options.sessionPhase);
      const unit = reusable
        ? refreshRenderUnitClock(previous.unit, options.nowMs)
        : materializeDraftUnit(draft, 0, 1, options);
      const entry = { draft, rowIndices, unit, resultIndex: -1 };
      entries.set(turnId, entry);
      this.updateMembership(entry);
      for (const rowId of realQueryRowIds(unit)) queryRowIds.add(rowId);
    }
    this.entries = entries;
    this.queryRowIds = queryRowIds;
    this.rebuildVisibleResult(options);
    this.rows = rows;
    this.options = options;
    return this.result;
  }

  private rebuildVisibleResult(options: BuildConversationTurnRenderUnitsOptions): void {
    const kept: CachedTurnRenderUnit[] = [];
    for (const entry of this.entries.values()) {
      entry.resultIndex = -1;
      if (shouldKeepRenderUnit(entry.unit)) kept.push(entry);
    }
    this.result = kept.map((entry, index) => {
      entry.resultIndex = index;
      entry.unit = normalizeRenderUnitPosition(entry.unit, index, kept.length, options);
      return entry.unit;
    });
  }
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
  cache?: ConversationTurnRenderCache,
): ConversationTurnRenderUnit[] {
  if (cache) return cache.build(rows, options);
  const drafts = new Map<string, DraftTurnRenderUnit>();
  for (const row of rows) {
    let draft = drafts.get(row.turnId);
    if (!draft) {
      draft = createDraftUnit(row.turnId);
      drafts.set(row.turnId, draft);
    }
    appendDraftRow(draft, row);
  }
  const materialized = [...drafts.values()].map((draft, index) =>
    materializeDraftUnit(draft, index, drafts.size, options),
  );
  const kept = materialized.filter(shouldKeepRenderUnit);
  return kept.map((unit, index) => normalizeRenderUnitPosition(unit, index, kept.length, options));
}
