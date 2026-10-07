// workspace-config 目录构建：经 OmpDirectoryGateway（常驻 `--mode rpc-ui --no-session`
// 目录进程）查询模型目录、思考档位与命令目录。omp 的 provider/model 注册表是进程级的；
// 每个会话进程重复查询代价高且无必要，统一收敛到目录进程。

import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { slashCommandsOfResponse } from "../domain/ompCommands.js";
import { ompStateDataSchema } from "../domain/ompFrames.js";
import { z } from "zod";

/** get_available_models 目录行（自 ompFrames 内联拆出，唯一消费方）。 */
const ompModelCatalogEntrySchema = z
  .object({
    provider: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();
import type { OmpDirectoryGatewayPort } from "../app/ports.js";
import { logger } from "./logger.js";

export interface WorkspaceConfigLoaderOptions {
  /** 命令目录变化推送（available_commands_update；目录进程常驻监听）；载荷为 omp 原始命令数组。 */
  onCommandsUpdate?: (commands: unknown) => void;
  /** 目录进程网关（实现 = adapters/ompDirectoryGateway.ts）。 */
  directory: OmpDirectoryGatewayPort;
}

export function createWorkspaceConfigLoader(
  workspacePath: string,
  options: WorkspaceConfigLoaderOptions,
) {
  const directory = options.directory;

  async function loadWorkspaceConfig(): Promise<WorkspaceConfigState> {
    try {
      const [modelsOutcome, levelsOutcome, commandsOutcome, state] = await Promise.all([
        directory.send({ type: "get_available_models" }),
        directory.send({ type: "get_available_thinking_levels" }),
        directory.send({ type: "get_available_commands" }).catch((error) => ({
          success: false as const,
          error: String(error),
        })),
        // 目录进程 --no-session：get_state 仍返回进程级模型事实（探测探针已验证）。
        sendStateQuery(),
      ]);
      const models = modelsOutcome.success ? parseModels(modelsOutcome.data) : [];
      const levels = levelsOutcome.success ? parseLevels(levelsOutcome.data) : [];
      if (!commandsOutcome.success) {
        logger.warn("omp 命令目录加载失败", { error: commandsOutcome.error });
      }
      const slashCommands = commandsOutcome.success
        ? slashCommandsOfResponse(commandsOutcome.data)
        : [];
      const currentModel = state?.model;
      const currentValue =
        currentModel?.provider && currentModel?.id
          ? `${currentModel.provider}/${currentModel.id}`
          : "";
      return buildConfigState(models, levels, currentValue, slashCommands, state?.thinkingLevel);
    } catch (error) {
      logger.warn("workspace-config 目录加载失败", { error: String(error) });
      return { configOptions: [], slashCommands: [] };
    }
  }

  /** get_state 在目录进程（--no-session）上仍返回进程级模型事实（探测探针已验证）。 */
  async function sendStateQuery() {
    const outcome = await directory.send({ type: "get_state" }).catch(() => null);
    if (!outcome?.success) return null;
    const parsed = ompStateDataSchema.safeParse(outcome.data);
    return parsed.success ? parsed.data : null;
  }

  async function loadSkillCommands(): Promise<unknown> {
    const outcome = await directory.send({ type: "get_available_commands" });
    if (!outcome.success) {
      throw new Error(outcome.error ?? "omp command catalog unavailable");
    }
    const record =
      typeof outcome.data === "object" && outcome.data !== null
        ? (outcome.data as { commands?: unknown })
        : {};
    return record.commands;
  }

  return { loadWorkspaceConfig, loadSkillCommands };
}

function parseModels(data: unknown): {
  provider: string;
  id: string;
  name?: string;
  thoughtLevels?: string[];
  defaultThoughtLevel?: string;
}[] {
  const record = typeof data === "object" && data !== null ? (data as { models?: unknown }) : {};
  const models = Array.isArray(record.models) ? record.models : [];
  const output: {
    provider: string;
    id: string;
    name?: string;
    thoughtLevels?: string[];
    defaultThoughtLevel?: string;
  }[] = [];
  for (const entry of models) {
    const parsed = ompModelCatalogEntrySchema.safeParse(entry);
    if (parsed.success && parsed.data.provider && parsed.data.id) {
      // omp Model 使用 thinking.efforts；旧 reasoning.levels 不是 RPC 模型目录字段。
      const thinking = (entry as { thinking?: { efforts?: unknown; defaultLevel?: unknown } })
        .thinking;
      const effortLevels = Array.isArray(thinking?.efforts)
        ? thinking.efforts.filter((level): level is string => typeof level === "string")
        : undefined;
      const thoughtLevels = effortLevels?.length
        ? ["off", ...effortLevels.filter((level) => level !== "off")]
        : undefined;
      const defaultThoughtLevel =
        typeof thinking?.defaultLevel === "string" && effortLevels?.includes(thinking.defaultLevel)
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
  return Array.isArray(record.levels)
    ? record.levels.filter((level): level is string => typeof level === "string")
    : [];
}

function buildConfigState(
  models: {
    provider: string;
    id: string;
    name?: string;
    thoughtLevels?: string[];
    defaultThoughtLevel?: string;
  }[],
  levels: string[],
  currentValue: string,
  slashCommands: WorkspaceConfigState["slashCommands"],
  currentThoughtLevel?: string,
): WorkspaceConfigState {
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
            ? {
                modelThoughtLevels: model.thoughtLevels,
                modelDefaultThoughtLevel: model.defaultThoughtLevel,
              }
            : {}),
        })),
      },
      ...(levels.length > 0
        ? [
            {
              id: "thought_level",
              name: "Thinking",
              type: "select" as const,
              currentValue: currentThoughtLevel ?? "off",
              options: levels.map((level) => ({
                value: level,
                name: level,
                origin: "native" as const,
              })),
            },
          ]
        : []),
    ],
    slashCommands,
  };
}
