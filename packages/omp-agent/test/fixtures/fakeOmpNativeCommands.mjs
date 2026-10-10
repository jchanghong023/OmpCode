// 同步 confirm 未返回 prompt ACK 时，回答与 abort 控制回路仍须可达。
import { out, pendingUi, respond } from "./fakeOmpHelpers.mjs";

let synchronousDialog = null;
export const nativeCommands =
  process.env.FAKE_OMP_NATIVE_COMMANDS === "1" ? [{ name: "goal", source: "builtin" }] : [];

export function handleNativeCommand(command) {
  if (!nativeCommands.length) return false;
  if (command.type === "prompt" && command.message === "/goal drop") {
    const pending = { id: "native-goal-confirm", promptId: command.id };
    synchronousDialog = pending;
    pendingUi.set(pending.id, (response) => {
      if (synchronousDialog !== pending) return;
      synchronousDialog = null;
      out({
        type: "command_output",
        text: response.confirmed ? "Goal dropped." : "Goal retained.",
      });
      respond(pending.promptId, "prompt", true, { agentInvoked: false });
    });
    // 原生 goal 控制器同步 await confirm，prompt 受理 ACK 在回答之后才返回。
    out({
      type: "extension_ui_request",
      id: pending.id,
      method: "confirm",
      title: "Drop goal?",
      message: "Remove the current objective?",
    });
    return true;
  }
  if (command.type === "abort" && synchronousDialog) {
    const pending = synchronousDialog;
    synchronousDialog = null;
    pendingUi.delete(pending.id);
    out({
      type: "extension_ui_request",
      id: "native-goal-cancel",
      method: "cancel",
      targetId: pending.id,
    });
    out({ type: "command_output", text: "Goal drop cancelled." });
    respond(pending.promptId, "prompt", true, { agentInvoked: false });
    respond(command.id, "abort", true);
    return true;
  }
  return false;
}
