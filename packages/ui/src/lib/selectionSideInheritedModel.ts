import type { OmpModelCatalog } from "@/omp-configuration/module.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

/** 副屏继承父 runtime 的生效模型；不能把主 Composer 未提交的草稿带进新 child。 */
export function resolveSelectionSideInheritedModel(
  config: SessionConfigState | null | undefined,
  catalog: OmpModelCatalog | null,
) {
  if (!config) return null;
  // 父运行态没有思考档位时保持稀疏；空串不是原生模型的显式档位。
  const reasoningLevel = config.thought?.trim();
  return (
    createComposerSubmissionConfig(
      {
        mode: config.mode,
        modelSelection: {
          providerId: config.provider,
          modelId: config.model,
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        },
      },
      catalog,
    )?.modelSelection ?? null
  );
}
