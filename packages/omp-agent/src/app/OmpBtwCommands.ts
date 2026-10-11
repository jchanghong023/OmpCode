import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { parseBtwViewId } from "../domain/OmpBtwFrames.js";
import { ProtocolError } from "./errors.js";
import type { OmpBtwStore } from "./OmpBtwStore.js";
import { diagnostics } from "./diagnostics.js";

export function isOmpBtwSessionCommand(envelope: CommandEnvelope): boolean {
  return Boolean(envelope.sessionId && parseBtwViewId(envelope.sessionId));
}

/** 接受/历史仍由原生父进程拥有；公共服务继续拥有信封幂等与 ACK。 */
export async function dispatchOmpBtwCommand(
  envelope: CommandEnvelope,
  sideViews: OmpBtwStore | undefined,
  reply: {
    ack(status: CommandAck["status"], extra?: Partial<CommandAck>): CommandAck;
    unsupported(what: string): CommandAck;
    requireSessionId(id: string | null): string;
  },
): Promise<CommandAck> {
  if (!sideViews) {
    const ack = reply.unsupported("side sessions");
    diagnostics.warn("omp.btw.command.unsupported", {
      commandId: envelope.commandId,
      sessionId: envelope.sessionId,
      commandType: envelope.type,
      status: "unsupported",
      reason: "side_sessions_unavailable",
    });
    return ack;
  }
  diagnostics.debug("omp.btw.command.received", {
    commandId: envelope.commandId,
    sessionId: envelope.sessionId,
    commandType: envelope.type,
  });
  try {
    const id = reply.requireSessionId(envelope.sessionId);
    if (envelope.type === "createSelectionSideSession") {
      const result = await sideViews.create(
        id,
        envelope.payload as CommandPayloadMap["createSelectionSideSession"],
        envelope,
      );
      const ack = reply.ack("accepted", { result });
      diagnostics.info("omp.btw.command.ack", {
        commandId: envelope.commandId,
        sessionId: id,
        commandType: envelope.type,
        status: "accepted",
      });
      return ack;
    }
    if (envelope.type === "sendText") {
      const payload = envelope.payload as CommandPayloadMap["sendText"];
      if (payload.planEnabled) {
        const ack = reply.unsupported("side session plan mode");
        diagnostics.warn("omp.btw.command.unsupported", {
          commandId: envelope.commandId,
          sessionId: id,
          commandType: envelope.type,
          status: "unsupported",
          reason: "plan_mode",
        });
        return ack;
      }
      const result = await sideViews.send(id, payload, envelope);
      const ack = reply.ack("accepted", { result });
      diagnostics.info("omp.btw.command.ack", {
        commandId: envelope.commandId,
        sessionId: id,
        commandType: envelope.type,
        status: "accepted",
      });
      return ack;
    }
    if (envelope.type === "stop") {
      const cancelled = await sideViews.stop(id);
      const status = cancelled ? "accepted" : "noop";
      const ack = reply.ack(status);
      diagnostics.info("omp.btw.command.ack", {
        commandId: envelope.commandId,
        sessionId: id,
        commandType: envelope.type,
        status,
      });
      return ack;
    }
    const ack = reply.unsupported("side session action");
    diagnostics.warn("omp.btw.command.unsupported", {
      commandId: envelope.commandId,
      sessionId: id,
      commandType: envelope.type,
      status: "unsupported",
      reason: "unsupported_action",
    });
    return ack;
  } catch (error) {
    const reasonCode =
      error instanceof ProtocolError && error.code === -32601
        ? "fault.command.sideSessionCapabilityMissing"
        : "fault.command.sideSessionFailed";
    const ack = reply.ack("rejected", {
      reasonCode,
      message: error instanceof Error ? error.message : String(error),
    });
    const schemaRejected = error instanceof Error && error.name === "ZodError";
    diagnostics.warn(
      schemaRejected ? "omp.btw.command.schema_rejected" : "omp.btw.command.rejected",
      {
        commandId: envelope.commandId,
        sessionId: envelope.sessionId,
        commandType: envelope.type,
        status: "rejected",
        reasonCode,
        failureStage: schemaRejected
          ? "schema_validation"
          : error instanceof ProtocolError
            ? "protocol_rejection"
            : "command_failure",
        errorType: error instanceof Error ? error.name : typeof error,
        ...(error instanceof ProtocolError ? { protocolCode: error.code } : {}),
      },
    );
    return ack;
  }
}
