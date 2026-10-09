import { resolveExecutionState, type ModelSelection } from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";

export interface ComposerSubmissionConfig {
  modelSelection: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
}

/**
 * omp 换核（FORK.md）：首发/切换的模型身份校验以 omp 目录（workspace-config 投影）为准，
 * 不再查 ZCode 账号目录。reasoning 缺省取目录默认档；无档位模型回退 "off"
 * （适配器会把 "off" 一并下发给 omp set_thinking_level，显式关闭思考）。
 */
export function createOmpComposerSubmissionConfig(
  composer:
    | { mode?: string; planEnabled?: boolean; modelSelection?: ModelSelection }
    | null
    | undefined,
  catalog: {
    entries: readonly {
      providerId: string;
      modelId: string;
      defaultThoughtLevel: string | undefined;
    }[];
  } | null,
): ComposerSubmissionConfig | null {
  if (!composer || !catalog) {
    return null;
  }
  const selection = composer.modelSelection;
  const mode = submissionModeSchema.safeParse(composer.mode);
  const entry = selection
    ? catalog.entries.find(
        (candidate) =>
          candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
      )
    : undefined;
  if (!mode.success || !selection || !entry) {
    return null;
  }
  const reasoningLevel = selection.options?.reasoningLevel ?? entry.defaultThoughtLevel ?? "off";
  return Object.freeze({
    mode: mode.data === "plan" ? "build" : mode.data,
    planEnabled: resolveExecutionState(composer).planEnabled,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel }),
    }),
  });
}
