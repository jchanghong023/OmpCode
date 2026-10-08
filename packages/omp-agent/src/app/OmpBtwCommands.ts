import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { parseBtwViewId } from "../domain/OmpBtwFrames.js";
import { ProtocolError } from "./errors.js";
import type { OmpBtwStore } from "./OmpBtwStore.js";

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
  if (!sideViews) return reply.unsupported("side sessions");
  try {
    const id = reply.requireSessionId(envelope.sessionId);
    if (envelope.type === "createSelectionSideSession") {
      const result = await sideViews.create(
        id,
        envelope.payload as CommandPayloadMap["createSelectionSideSession"],
        envelope,
      );
      return reply.ack("accepted", { result });
    }
    if (envelope.type === "sendText") {
      const payload = envelope.payload as CommandPayloadMap["sendText"];
      if (payload.context_refs?.length || payload.planEnabled)
        return reply.unsupported("side session shared contexts or plan mode");
      const result = await sideViews.send(id, payload, envelope);
      return reply.ack("accepted", { result });
    }
    if (envelope.type === "stop") {
      const cancelled = await sideViews.stop(id);
      return reply.ack(cancelled ? "accepted" : "noop");
    }
    return reply.unsupported("side session action");
  } catch (error) {
    return reply.ack("rejected", {
      reasonCode:
        error instanceof ProtocolError && error.code === -32601
          ? "fault.command.sideSessionCapabilityMissing"
          : "fault.command.sideSessionFailed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
