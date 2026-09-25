// workspace-config 目录构建：用一个常驻 omp 进程查询模型目录与思考档位。
// omp 的 provider/model 注册表是进程级的；每个会话进程重复查询代价高且无必要。

import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { OmpProcessFactory } from "../app/ports.js";
import { slashCommandsOfResponse } from "../domain/ompCommands.js";
import { ompModelCatalogEntrySchema } from "../domain/ompFrames.js";
import { logger } from "./logger.js";

export interface WorkspaceConfigLoaderOptions {
  /** 命令目录变化推送（available_commands_update；目录进程常驻监听）；载荷为 omp 原始命令数组。 */
  onCommandsUpdate?: (commands: unknown) => void;
}

export function createWorkspaceConfigLoader(ompFactory: OmpProcessFactory, workspacePath: string, options: WorkspaceConfigLoaderOptions = {}) {
  let catalogProcess: Awaited<ReturnType<OmpProcessFactory["create"]>> | null = null;

  async function ensureProcess() {
    if (catalogProcess) {
      return catalogProcess;
    }
    const processHandle = ompFactory.create({
      cwd: workspacePath,
      onEvent: () => {},
      onUiRequest: ({ respond, frame }) => respond({ type: "extension_ui_response", id: frame.id, cancelled: true }),
      onExit: (code) => {
        logger.warn("omp 模型目录进程已退出", { code });
        catalogProcess = null;
      },
      // 命令目录热更新（marketplace 安装、插件启停等）：立即推送，UI 补全菜单随之刷新。
      onCommandsUpdate: (commands) => options.onCommandsUpdate?.(commands),
    });
    await processHandle.start();
    catalogProcess = processHandle;
    return processHandle;
  }

  return async function loadWorkspaceConfig(): Promise<WorkspaceConfigState> {
    try {
      const processHandle = await ensureProcess();
      const [modelsOutcome, levelsOutcome, commandsOutcome, state] = await Promise.all([
        processHandle.send({ type: "get_available_models" }),
        processHandle.send({ type: "get_available_thinking_levels" }),
        processHandle.send({ type: "get_available_commands" }).catch((error) => ({
          success: false as const,
          error: String(error),
        })),
        processHandle.refreshState(),
      ]);
      const models = modelsOutcome.success
        ? parseModels(modelsOutcome.data)
        : [];
      const levels = levelsOutcome.success ? parseLevels(levelsOutcome.data) : [];
      if (!commandsOutcome.success) {
        logger.warn("omp 命令目录加载失败", { error: commandsOutcome.error });
      }
      const slashCommands = commandsOutcome.success ? slashCommandsOfResponse(commandsOutcome.data) : [];
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
                ? { modelThoughtLevels: model.thoughtLevels, modelDefaultThoughtLevel: model.defaultThoughtLevel }
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
        slashCommands,
      };
    } catch (error) {
      logger.warn("workspace-config 目录加载失败", { error: String(error) });
      return { configOptions: [], slashCommands: [] };
    }
  };
}

function parseModels(data: unknown): { provider: string; id: string; name?: string; thoughtLevels?: string[]; defaultThoughtLevel?: string }[] {
  const record = typeof data === "object" && data !== null ? (data as { models?: unknown }) : {};
  const models = Array.isArray(record.models) ? record.models : [];
  const output: { provider: string; id: string; name?: string; thoughtLevels?: string[]; defaultThoughtLevel?: string }[] = [];
  for (const entry of models) {
    const parsed = ompModelCatalogEntrySchema.safeParse(entry);
    if (parsed.success && parsed.data.provider && parsed.data.id) {
      // omp Model 使用 thinking.efforts；旧 reasoning.levels 不是 RPC 模型目录字段。
      const thinking = (entry as { thinking?: { efforts?: unknown; defaultLevel?: unknown } }).thinking;
      const effortLevels = Array.isArray(thinking?.efforts)
        ? thinking.efforts.filter((level): level is string => typeof level === "string")
        : undefined;
      const thoughtLevels = effortLevels?.length ? ["off", ...effortLevels.filter((level) => level !== "off")] : undefined;
      const defaultThoughtLevel = typeof thinking?.defaultLevel === "string" && effortLevels?.includes(thinking.defaultLevel)
        ? thinking.defaultLevel
        : effortLevels?.[0];
      output.push({
        provider: parsed.data.provider,
        id: parsed.data.id,
        name: parsed.data.name,
        thoughtLevels,
        defaultThoughtLevel,
      });
    }
  }
  return output;
}

function parseLevels(data: unknown): string[] {
  const record = typeof data === "object" && data !== null ? (data as { levels?: unknown }) : {};
  return Array.isArray(record.levels) ? record.levels.filter((level): level is string => typeof level === "string") : [];
}
