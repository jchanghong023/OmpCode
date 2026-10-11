import { zcodeSessionAgentInteractionsParamsSchema } from "@zcode/shared";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { OmpAgentInteractionStore } from "./OmpAgentInteractionStore.js";
import { diagnostics } from "./diagnostics.js";
import { ProtocolError } from "./errors.js";

export async function queryAgentInteractions(
  params: unknown,
  context: {
    workspaceKey: string;
    workspacePath: string;
    registry: SessionRegistry;
    interactions: OmpAgentInteractionStore;
  },
) {
  const parsed = zcodeSessionAgentInteractionsParamsSchema.safeParse(params);
  if (!parsed.success) {
    diagnostics.warn("omp.agent_interactions.query.rejected", {
      failureStage: "params_validation",
      protocolCode: -32602,
    });
    throw new ProtocolError(-32602, "invalid agent interaction workspace or root session");
  }
  const { sessionId, cursor, limit } = parsed.data;
  const workspaceMismatch =
    parsed.data.workspace.workspaceKey !== context.workspaceKey ||
    parsed.data.workspace.workspacePath !== context.workspacePath;
  const subagentSession = sessionId.startsWith("omp-subagent:");
  if (workspaceMismatch || subagentSession) {
    diagnostics.warn("omp.agent_interactions.query.rejected", {
      sessionId,
      failureStage: workspaceMismatch ? "workspace_mismatch" : "subagent_session",
      protocolCode: -32602,
    });
    throw new ProtocolError(-32602, "invalid agent interaction workspace or root session");
  }
  const existingEngine = context.registry.getEngine(sessionId);
  const engine =
    existingEngine ??
    (await context.registry.resumeSession({
      sessionId,
      workspaceId: context.workspaceKey,
      workspacePath: context.workspacePath,
    }));
  diagnostics.debug("omp.agent_interactions.query.accepted", {
    sessionId,
    limit,
    cursorPresent: Boolean(cursor),
    engineReused: Boolean(existingEngine),
  });
  // 冷恢复只水合记录；这个读入口不调用 ensureOmpStarted 或任何 prompt/control。
  return context.interactions.query(
    engine,
    cursor,
    limit,
    () => context.registry.getEngine(sessionId) === engine,
  );
}
