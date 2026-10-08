// 镜像当前 OMP 背景命令：ACK 仅提交结束，后续无 ID 输出和等待交互仍可继续。
import { out, pendingUi, respond } from "./fakeOmpHelpers.mjs";

let backgroundDialog = null;
let synchronousDialog = null;
export const nativeCommands =
  process.env.FAKE_OMP_NATIVE_COMMANDS === "1"
    ? [
        { name: "wiki", source: "builtin" },
        { name: "compact", source: "builtin" },
        { name: "goal", source: "builtin" },
      ]
    : [];

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
  if (command.type === "prompt" && command.message === "/compact soft keep paragraphs") {
    respond(command.id, "prompt", true, { agentInvoked: false });
    setTimeout(() => out({ type: "command_output", text: "Compaction: first paragraph\n" }), 10);
    setTimeout(() => out({ type: "command_output", text: "Compaction: second paragraph\n" }), 25);
    return true;
  }
  if (command.type === "prompt" && command.message === "/wiki") {
    respond(command.id, "prompt", true, { agentInvoked: false });
    backgroundDialog = "native-wiki-dialog";
    pendingUi.set(backgroundDialog, (response) => {
      backgroundDialog = null;
      out({
        type: "command_output",
        text: response.cancelled ? "Wiki cancelled." : "Wiki selected.",
      });
    });
    out({
      type: "extension_ui_request",
      id: backgroundDialog,
      method: "select",
      title: "Document indexes",
      options: ["New document index"],
    });
    return true;
  }
  if (command.type === "abort" && backgroundDialog) {
    out({
      type: "extension_ui_request",
      id: "native-wiki-cancel",
      method: "cancel",
      targetId: backgroundDialog,
    });
    pendingUi.delete(backgroundDialog);
    backgroundDialog = null;
    out({ type: "command_output", text: "Wiki stopped." });
    respond(command.id, "abort", true);
    return true;
  }
  return false;
}
