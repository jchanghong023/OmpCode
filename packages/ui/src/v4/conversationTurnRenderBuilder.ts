import type { ConversationRow, SessionPhase, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import {
  createDraftUnit,
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  shouldKeepRenderUnit,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnRenderUnit,
  type DraftTurnRenderUnit,
} from "./conversationTurnRenderUnits.js";

interface CachedTurnRenderUnit {
  header?: TurnHeaderRow;
  orderedRows: readonly ConversationRow[];
  isLastDraft: boolean;
  nowMs?: number;
  sessionPhase?: SessionPhase;
  unit: ConversationTurnRenderUnit;
}

/** 仅保存可由传入 rows 重新计算的 UI 派生值；不持有会话事实。 */
export class ConversationTurnRenderCache {
  entries = new Map<string, CachedTurnRenderUnit>();
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
  cache?: ConversationTurnRenderCache,
): ConversationTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();
  for (const row of rows) {
    let unit = unitByTurnId.get(row.turnId);
    if (!unit) {
      unit = createDraftUnit(row.turnId);
      units.push(unit);
      unitByTurnId.set(row.turnId, unit);
    }
    if (row.kind === "turnHeader") {
      unit.header = row;
    } else {
      unit.orderedRows.push(row);
      if (row.kind === "userInput") unit.userInputs.push(row);
      else if (row.kind === "hookInvocation") unit.hookInvocations.push(row);
      else unit.assistantWorkRows.push(row);
    }
  }

  const materialized = units.map((draft, index) => {
    const prior = cache?.entries.get(draft.turnId);
    const isLastDraft = index === units.length - 1;
    // Bug 根因：每秒计时或单轮流式帧都重新物化所有已加载历史轮次。
    // 只复用输入行引用、位置和会话阶段都相同的完成轮；运行轮仍用当前时钟重算。
    const reusable =
      prior !== undefined &&
      prior.header === draft.header &&
      prior.isLastDraft === isLastDraft &&
      prior.sessionPhase === options.sessionPhase &&
      (!prior.unit.isRunning || prior.nowMs === options.nowMs) &&
      prior.orderedRows.length === draft.orderedRows.length &&
      prior.orderedRows.every((row, rowIndex) => row === draft.orderedRows[rowIndex]);
    return {
      draft,
      unit: reusable ? prior.unit : materializeDraftUnit(draft, index, units.length, options),
      reusable,
      isLastDraft,
    };
  });
  const kept = materialized.filter((entry) => shouldKeepRenderUnit(entry.unit));
  const result = kept.map((entry, index) => {
    const isLast = index === kept.length - 1;
    return entry.reusable && entry.unit.isLastTurn === isLast
      ? entry.unit
      : normalizeRenderUnitPosition(entry.unit, index, kept.length, options);
  });
  if (cache) {
    cache.entries = new Map(
      kept.map((entry, index) => [
        entry.draft.turnId,
        {
          header: entry.draft.header,
          orderedRows: entry.draft.orderedRows,
          isLastDraft: entry.isLastDraft,
          nowMs: options.nowMs,
          sessionPhase: options.sessionPhase,
          unit: result[index]!,
        },
      ]),
    );
  }
  return result;
}
