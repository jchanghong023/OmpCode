import type { OmpSessionProcess } from "./ports.js";
import { applyEngineModelSelection } from "./ompEngineProcess.js";

export async function dispatchOmpText(input: {
  process: OmpSessionProcess;
  text: string;
  images: { type: "image"; data: string; mimeType: string }[];
  streaming: boolean;
  followupMode: "queue" | "guide";
  modelSelection?: { provider: string; model: string; thought?: string };
  currentConfig: { provider: string; model: string; thought: string };
}): Promise<{ success: boolean; data?: unknown; code?: string; error?: string }> {
  const { text, images } = input;
  // 修复（G9）：被拒输入不得先改写会话模型——「项目模式 + 斜杠命令 + 附件」守卫
  // 前置于 applyEngineModelSelection，模型选择只在输入被接受后执行。
  // 修复（F8）：execute_command 协议无附件载体（domain/ompProjectFrames.ts），带图片时
  // 不能静默丢弃附件，必须明确失败让用户改用无附件命令或把图片说明写入命令参数。
  if (input.process.projectMode && text.startsWith("/") && images.length > 0) {
    return {
      success: false,
      code: "omp_command_attachments_unsupported",
      error: "斜杠命令暂不支持同时发送图片附件；请去掉附件后重发，或把图片说明写入命令参数",
    };
  }
  if (input.modelSelection) {
    const failure = await applyEngineModelSelection(
      input.process,
      input.modelSelection,
      input.currentConfig,
    );
    if (failure) return { success: false, code: failure.code, error: failure.message };
  }
  const attachment = images.length > 0 ? { images } : {};
  if (input.streaming) {
    // 流式中的补充输入始终按文本（steer 引导本轮 / follow_up 入队），不做命令分发。
    const command =
      input.followupMode === "guide"
        ? { type: "steer" as const, message: text, ...attachment }
        : { type: "follow_up" as const, message: text, ...attachment };
    const outcome = await input.process.send(command);
    // 修复（G15）：code 只表达失败类别，成功结果不携带。
    return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
  }
  if (input.process.projectMode && text.startsWith("/")) {
    // 项目模式（rpc-ui-protocol §14.4）：prompt 默认 inputMode text；"/xxx" 输入改走
    // execute_command 严格分发——未知命令报错，绝不发给模型。
    // （附件守卫已前置于模型选择，此处进入分支的输入必无附件。）
    const outcome = await input.process.send({ type: "execute_command", text });
    return outcome.success ? outcome : { ...outcome, code: "omp_command_failed" };
  }
  const command = input.process.projectMode
    ? { type: "prompt" as const, message: text, ...attachment, inputMode: "text" as const }
    : { type: "prompt" as const, message: text, ...attachment };
  const outcome = await input.process.send(command);
  return outcome.success ? outcome : { ...outcome, code: "omp_prompt_failed" };
}
