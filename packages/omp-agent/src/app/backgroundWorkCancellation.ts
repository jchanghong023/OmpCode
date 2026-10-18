import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionRegistry } from "./sessionRegistry.js";
import { diagnostics } from "./diagnostics.js";

/** Compact Agent Stop reuses the real parent's control owner; ACK is admission, never terminal proof. */
export async function cancelBackgroundWork(
  registry: SessionRegistry,
  workspaceId: string,
  envelope: CommandEnvelope,
): Promise<Pick<CommandAck, "status" | "reasonCode" | "message">> {
  const { workId } = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const sessionId = envelope.sessionId;
  return diagnostics.run({ sessionId: sessionId ?? undefined, workId }, async () => {
    diagnostics.info("omp.background_work.cancel.started");
    const reject = (code: string, message: string) => {
      diagnostics.warn("omp.background_work.cancel.rejected", { code, resultStatus: "rejected" });
      return {
        status: "rejected" as const,
        reasonCode: `fault.command.backgroundWorkCancelRejected.${code}`,
        message,
      };
    };
    const engine = sessionId ? registry.getEngine(sessionId) : null;
    if (!engine || engine.workspaceId !== workspaceId)
      return reject("not_found", "Background work does not belong to this workspace/session");
    const state = engine.projection.stateSnapshot;
    const works = state.backgroundWorks.filter((work) => work.workId === workId);
    if (works.length !== 1) return reject("not_found", "Background work is missing or ambiguous");
    const work = works[0]!;
    if (
      work.kind !== "subagent" ||
      work.status !== "running" ||
      work.cancellable === false ||
      !work.childSessionId
    )
      return reject("not_running", "Only an active native subagent can be cancelled");
    const children = state.subagents.running.filter(
      (child) => child.childSessionId === work.childSessionId,
    );
    const child = children.length === 1 ? children[0] : undefined;
    const host = engine.subagentProcessHost();
    if (
      !child?.agentId ||
      host.observedSubagentStatus(child.agentId, host.currentProcess()) !== "running"
    )
      return reject("not_running", "No current-process running child owns this work");
    diagnostics.info("omp.background_work.cancel.target_resolved", {
      subagentId: child.agentId,
      parentSessionId: engine.sessionId,
    });
    try {
      const outcome = await registry.controlSubagent(sessionId!, child.agentId, "stop");
      if (!outcome.success)
        return reject(
          outcome.code ?? "control_failed",
          outcome.error ?? "Subagent cancellation failed",
        );
      diagnostics.info("omp.background_work.cancel.result", {
        subagentId: child.agentId,
        resultStatus: "stopping",
      });
      return { status: "accepted" };
    } catch (error) {
      diagnostics.error("omp.background_work.cancel.failed", {
        errorType: error instanceof Error ? error.name : typeof error,
        resultStatus: "rejected",
      });
      return reject("control_failed", error instanceof Error ? error.message : String(error));
    }
  });
}
