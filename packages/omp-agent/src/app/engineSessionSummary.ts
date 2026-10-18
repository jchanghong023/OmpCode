import type { ConversationRow, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationEngine } from "./conversationEngine.js";

/** Read-only projection: hydration/config notifications and shutdown are not conversation activity. */
export function engineSessionTimes(
  engine: ConversationEngine,
  rows: readonly ConversationRow[] = engine.projection.buildSnapshot().rows.window,
): { createdAt: number; updatedAt: number } {
  let updatedAt = engine.activityBaselineAt;
  for (const row of rows) {
    if (
      row.kind !== "userInput" &&
      row.kind !== "assistantText" &&
      row.kind !== "reasoning" &&
      row.kind !== "toolCall"
    )
      continue;
    updatedAt = Math.max(updatedAt, row.createdAt);
    if (row.kind === "toolCall" && row.endedAt !== undefined) {
      updatedAt = Math.max(updatedAt, row.endedAt);
    }
  }
  return { createdAt: engine.createdAt, updatedAt: Math.trunc(updatedAt) };
}

export function buildEngineSessionSummary(input: {
  engine: ConversationEngine;
  sessionId: string;
  createdAt?: number;
  lastActivityAt?: number;
}): SessionSummary {
  const state = input.engine.projection.stateSnapshot;
  const rows = input.engine.projection.buildSnapshot().rows.window;
  const times = engineSessionTimes(input.engine, rows);
  const lastAssistant = [...rows].reverse().find((row) => row.kind === "assistantText");
  return {
    sessionId: input.sessionId,
    workspaceId: input.engine.workspaceId,
    title: state.meta.title,
    titleSource: state.meta.titleSource,
    phase: state.control.phase,
    sessionEnded: state.control.sessionEnded,
    hasBackgroundWork: state.backgroundWorks.some((work) => work.status === "running"),
    pendingInteractionSummary: {
      permissionCount: state.pendingInteractions.filter((item) => item.kind === "permission")
        .length,
      userInputCount: state.pendingInteractions.filter((item) => item.kind === "userInput").length,
    },
    lastActivityAt: Math.max(times.updatedAt, input.lastActivityAt ?? times.updatedAt),
    ...(lastAssistant?.kind === "assistantText"
      ? { lastAssistantPreview: lastAssistant.text.slice(0, 120) }
      : {}),
    createdAt: input.createdAt ?? times.createdAt,
  };
}
