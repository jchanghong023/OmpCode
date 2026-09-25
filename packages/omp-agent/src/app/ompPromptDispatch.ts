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
  const command = input.streaming
    ? input.followupMode === "guide"
      ? { type: "steer" as const, message: text, ...attachment }
      : { type: "follow_up" as const, message: text, ...attachment }
    : { type: "prompt" as const, message: text, ...attachment };
  const outcome = await input.process.send(command);
  return { ...outcome, code: "omp_prompt_failed" };
}
