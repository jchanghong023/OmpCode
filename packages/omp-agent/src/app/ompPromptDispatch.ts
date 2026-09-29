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
  if (input.modelSelection) {
    const failure = await applyEngineModelSelection(
      input.process,
      input.modelSelection,
      input.currentConfig,
    );
    if (failure) return { success: false, code: failure.code, error: failure.message };
  }
  const { text, images } = input;
  const attachment = images.length > 0 ? { images } : {};
  if (input.streaming) {
    // 流式中的补充输入始终按文本（steer 引导本轮 / follow_up 入队），不做命令分发。
    const command =
      input.followupMode === "guide"
        ? { type: "steer" as const, message: text, ...attachment }
        : { type: "follow_up" as const, message: text, ...attachment };
    const outcome = await input.process.send(command);
    return { ...outcome, code: "omp_prompt_failed" };
  }
  if (input.process.projectMode && text.startsWith("/")) {
    // 项目模式（rpc-ui-protocol §14.4）：prompt 默认 inputMode text；"/xxx" 输入改走
    // execute_command 严格分发——未知命令报错，绝不发给模型。
    const outcome = await input.process.send({ type: "execute_command", text });
    return { ...outcome, code: "omp_command_failed" };
  }
  const command = input.process.projectMode
    ? { type: "prompt" as const, message: text, ...attachment, inputMode: "text" as const }
    : { type: "prompt" as const, message: text, ...attachment };
  const outcome = await input.process.send(command);
  return { ...outcome, code: "omp_prompt_failed" };
}
