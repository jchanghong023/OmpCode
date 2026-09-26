import { ompSessionIdOfFilePath } from "../domain/ids.js";
import { deriveTitle } from "../domain/titleText.js";
import type { ConversationEngine } from "./conversationEngine.js";
import type { OmpStorePort } from "./ports.js";

/** legacy 读面从 Registry 的唯一会话所有者和 omp 冷存储派生，不持有独立索引。 */
export async function listLegacySessions(input: {
  engines: Iterable<ConversationEngine>;
  rekeyedEngineIds: ReadonlySet<string>;
  store: OmpStorePort;
  workspacePath: string;
  workspaceKey: string;
}): Promise<Record<string, unknown>[]> {
  const workspace = { workspacePath: input.workspacePath, workspaceKey: input.workspaceKey };
  const sessions: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const engine of input.engines) {
    const stableId = ompSessionIdOfFilePath(engine.ompSessionFile) ?? engine.sessionId;
    const indexId = input.rekeyedEngineIds.has(engine.sessionId) ? stableId : engine.sessionId;
    seen.add(stableId);
    seen.add(engine.sessionId);
    const state = engine.projection.stateSnapshot;
    sessions.push({
      sessionId: indexId,
      workspace,
      sessionKind: "interactive",
      title: state.meta.title,
      mode: "build",
      status:
        state.control.phase === "running"
          ? "running"
          : state.control.phase === "error"
            ? "error"
            : "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  for (const cold of await input.store.listSessions(input.workspacePath)) {
    if (seen.has(cold.sessionId)) continue;
    sessions.push({
      sessionId: cold.sessionId,
      workspace,
      sessionKind: "interactive",
      title: cold.title ?? deriveTitle(cold.firstUserText ?? ""),
      mode: "build",
      status: "completed",
      createdAt: cold.createdAt,
      updatedAt: cold.updatedAt,
    });
  }
  return sessions;
}
