import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationEngine } from "./conversationEngine.js";

export function buildEngineSessionSummary(input: {
  engine: ConversationEngine;
  sessionId: string;
  createdAt: number;
  lastActivityAt?: number;
}): SessionSummary {
  const state = input.engine.projection.stateSnapshot;
  const rows = input.engine.projection.buildSnapshot().rows.window;
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
    lastActivityAt: input.lastActivityAt ?? Date.now(),
    ...(lastAssistant?.kind === "assistantText"
      ? { lastAssistantPreview: lastAssistant.text.slice(0, 120) }
      : {}),
    createdAt: input.createdAt,
  };
}
