// workspace-config 目录构建：用一个常驻 omp 进程查询模型目录与思考档位。
// omp 的 provider/model 注册表是进程级的；每个会话进程重复查询代价高且无必要。

import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { OmpProcessFactory } from "../app/ports.js";
import { ompModelCatalogEntrySchema } from "../domain/ompFrames.js";
import { logger } from "./logger.js";

export function createWorkspaceConfigLoader(ompFactory: OmpProcessFactory, workspacePath: string) {
  let catalogProcess: Awaited<ReturnType<OmpProcessFactory["create"]>> | null = null;

  async function ensureProcess() {
    if (catalogProcess) {
      return catalogProcess;
    }
    const processHandle = ompFactory.create({
      cwd: workspacePath,
      onEvent: () => {},
      onUiRequest: ({ respond, frame }) => respond({ type: "extension_ui_response", id: frame.id, cancelled: true }),
      onExit: () => {
        catalogProcess = null;
      },
    });
    await processHandle.start();
    catalogProcess = processHandle;
    return processHandle;
  }

  return async function loadWorkspaceConfig(): Promise<WorkspaceConfigState> {
    try {
      const processHandle = await ensureProcess();
      const [modelsOutcome, levelsOutcome, state] = await Promise.all([
        processHandle.send({ type: "get_available_models" }),
        processHandle.send({ type: "get_available_thinking_levels" }),
        processHandle.refreshState(),
      ]);
      const models = modelsOutcome.success
        ? parseModels(modelsOutcome.data)
        : [];
      const levels = levelsOutcome.success ? parseLevels(levelsOutcome.data) : [];
      const currentModel = state?.model;
      const currentValue =
        currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : "";
      return {
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue,
            options: models.map((model) => ({
              value: `${model.provider}/${model.id}`,
              name: model.name ?? `${model.provider}/${model.id}`,
              origin: "native" as const,
              modelProviderId: model.provider,
              modelProviderName: model.provider,
              ...(model.thoughtLevels && model.thoughtLevels.length > 0
                ? { modelThoughtLevels: model.thoughtLevels, modelDefaultThoughtLevel: model.thoughtLevels[0] }
                : {}),
            })),
          },
          ...(levels.length > 0
            ? [
                {
                  id: "thought_level",
                  name: "Thinking",
                  type: "select" as const,
                  currentValue: state?.thinkingLevel ?? "off",
                  options: levels.map((level) => ({ value: level, name: level, origin: "native" as const })),
                },
              ]
            : []),
        ],
        slashCommands: [],
      };
    } catch (error) {
      logger.warn("workspace-config 目录加载失败", { error: String(error) });
      return { configOptions: [], slashCommands: [] };
    }
  };
}

function parseModels(data: unknown): { provider: string; id: string; name?: string; thoughtLevels?: string[] }[] {
  const record = typeof data === "object" && data !== null ? (data as { models?: unknown }) : {};
  const models = Array.isArray(record.models) ? record.models : [];
  const output: { provider: string; id: string; name?: string; thoughtLevels?: string[] }[] = [];
  for (const entry of models) {
    const parsed = ompModelCatalogEntrySchema.safeParse(entry);
    if (parsed.success && parsed.data.provider && parsed.data.id) {
      const reasoning = (entry as { reasoning?: { levels?: string[] } }).reasoning;
      output.push({
        provider: parsed.data.provider,
        id: parsed.data.id,
        name: parsed.data.name,
        thoughtLevels: Array.isArray(reasoning?.levels) ? reasoning.levels.filter((level): level is string => typeof level === "string") : undefined,
      });
    }
  }
  return output;
}

function parseLevels(data: unknown): string[] {
  const record = typeof data === "object" && data !== null ? (data as { levels?: unknown }) : {};
  return Array.isArray(record.levels) ? record.levels.filter((level): level is string => typeof level === "string") : [];
}
