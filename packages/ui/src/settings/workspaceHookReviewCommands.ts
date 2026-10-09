import type { CommandPayloadMap, CommandType } from "@zcode/shared/zcode-protocol-v4";
import { type WorkspaceHookCommandBinding } from "@/store/workspaceHookReviewStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export async function sendWorkspaceHookCommand<T extends CommandType>(
  binding: Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
  sessionId: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const envelope = createCommandEnvelope({ type, sessionId, payload } as never);
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await binding.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    return {
      accepted: ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop",
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
    };
  } finally {
    binding.onCommandSettled?.(envelope.commandId);
  }
}
