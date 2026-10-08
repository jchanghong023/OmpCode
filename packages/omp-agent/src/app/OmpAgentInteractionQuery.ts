import { zcodeSessionAgentInteractionsParamsSchema } from "@zcode/shared";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { OmpAgentInteractionStore } from "./OmpAgentInteractionStore.js";
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
  if (
    !parsed.success ||
    parsed.data.workspace.workspaceKey !== context.workspaceKey ||
    parsed.data.workspace.workspacePath !== context.workspacePath ||
    parsed.data.sessionId.startsWith("omp-subagent:")
  ) {
    throw new ProtocolError(-32602, "invalid agent interaction workspace or root session");
  }
  const { sessionId, cursor, limit } = parsed.data;
  const engine =
    context.registry.getEngine(sessionId) ??
    (await context.registry.resumeSession({
      sessionId,
      workspaceId: context.workspaceKey,
      workspacePath: context.workspacePath,
    }));
  // 冷恢复只水合记录；这个读入口不调用 ensureOmpStarted 或任何 prompt/control。
  return context.interactions.query(
    engine,
    cursor,
    limit,
    () => context.registry.getEngine(sessionId) === engine,
  );
}
