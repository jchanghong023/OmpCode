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
      const [modelsOutcome, levelsOutcome, commandsOutcome] = await Promise.all([
        directory.send({ type: "get_available_models" }),
        directory.send({ type: "get_available_thinking_levels" }),
        directory.send({ type: "get_available_commands" }).catch((error: unknown) => ({
          success: false as const,
          error: String(error),
        })),
      ]);
      // 核心串行处理目录命令；模型注册刷新可能超过 get_state 的 10 秒请求时限。
      // 先等目录刷新完成，再回读真实模型，避免排队时间耗尽时限后丢失首屏模型初值。
      const state = await sendStateQuery();
      if (!modelsOutcome.success) {
        logger.warn("workspace config model catalog fallback", {
          event: "omp.workspace_config.models.fallback",
          stage: "models_rpc",
          reason: "rpc_failure",
          errorType: modelsOutcome.error === undefined ? "unknown" : typeof modelsOutcome.error,
          fallbackStatus: "empty_list",
          fallbackCount: 0,
        });
      }
      if (!levelsOutcome.success) {
        logger.warn("workspace config thinking levels fallback", {
          event: "omp.workspace_config.thinking_levels.fallback",
          stage: "thinking_levels_rpc",
          reason: "rpc_failure",
          errorType: levelsOutcome.error === undefined ? "unknown" : typeof levelsOutcome.error,
          fallbackStatus: "empty_list",
          fallbackCount: 0,
        });
      }
      const models = modelsOutcome.success ? parseModels(modelsOutcome.data) : [];
      const levels = levelsOutcome.success ? parseLevels(levelsOutcome.data) : [];
      if (!commandsOutcome.success) {
        logger.warn("workspace config command catalog fallback", {
          event: "omp.workspace_config.command_catalog.fallback",
          stage: "command_catalog_rpc",
          reason: "rpc_failure",
          errorType: typeof commandsOutcome.error,
          fallbackStatus: "empty_list",
          fallbackCount: 0,
        });
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
      logger.warn("workspace config fallback", {
        event: "omp.workspace_config.load.fallback",
        stage: "configuration_load",
        reason: "operation_exception",
        errorType: error instanceof Error ? error.name : typeof error,
        fallbackStatus: "empty_config",
        configOptionCount: 0,
        slashCommandCount: 0,
      });
      return { configOptions: [], slashCommands: [] };
    }
  }

  /** get_state 在目录进程（--no-session）上仍返回进程级模型事实（探测探针已验证）。 */
  async function sendStateQuery() {
    const outcome = await directory.send({ type: "get_state" }).catch((error: unknown) => {
      logger.warn("workspace config state fallback", {
        event: "omp.workspace_config.state.fallback",
        stage: "state_rpc",
        reason: "transport_failure",
        errorType: error instanceof Error ? error.name : typeof error,
        fallbackStatus: "default_selection",
      });
      return null;
    });
    if (!outcome) return null;
    if (!outcome.success) {
      logger.warn("workspace config state fallback", {
        event: "omp.workspace_config.state.fallback",
        stage: "state_rpc",
        reason: "rpc_failure",
        errorType: outcome.error === undefined ? "unknown" : typeof outcome.error,
        fallbackStatus: "default_selection",
      });
      return null;
    }
    const parsed = ompStateDataSchema.safeParse(outcome.data);
    if (!parsed.success) {
      logger.warn("workspace config state rejected", {
        event: "omp.workspace_config.state.rejected",
        stage: "state_schema",
        reason: "schema_rejected",
        resultType: outcome.data === null ? "null" : typeof outcome.data,
        issueCount: parsed.error.issues.length,
        fallbackStatus: "default_selection",
      });
      return null;
    }
    return parsed.data;
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
  if (!Array.isArray(record.models)) {
    logger.warn("workspace config model catalog rejected", {
      event: "omp.workspace_config.models.rejected",
      stage: "catalog_schema",
      reason: record.models === undefined ? "list_missing" : "list_not_array",
      resultType: record.models === null ? "null" : typeof record.models,
      containerType: data === null ? "null" : typeof data,
      rejectedCount: 1,
    });
    return [];
  }
  const models = record.models;
  const output: {
    provider: string;
    id: string;
    name?: string;
    thoughtLevels?: string[];
    defaultThoughtLevel?: string;
  }[] = [];
  let schemaRejectedCount = 0;
  let schemaIssueCount = 0;
  let requiredFieldRejectedCount = 0;
  for (const entry of models) {
    const parsed = ompModelCatalogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      schemaRejectedCount += 1;
      schemaIssueCount += parsed.error.issues.length;
      continue;
    }
    if (!parsed.data.provider || !parsed.data.id) {
      requiredFieldRejectedCount += 1;
      continue;
    }
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
  const rejectedCount = schemaRejectedCount + requiredFieldRejectedCount;
  if (rejectedCount > 0) {
    logger.warn("workspace config model entries rejected", {
      event: "omp.workspace_config.models.rejected",
      stage: "entry_schema",
      reason: "invalid_entries",
      entryCount: models.length,
      rejectedCount,
      schemaIssueCount,
      requiredFieldRejectedCount,
    });
  }
  return output;
}

function parseLevels(data: unknown): string[] {
  const record = typeof data === "object" && data !== null ? (data as { levels?: unknown }) : {};
  if (!Array.isArray(record.levels)) {
    logger.warn("workspace config thinking levels rejected", {
      event: "omp.workspace_config.thinking_levels.rejected",
      stage: "list_schema",
      reason: record.levels === undefined ? "list_missing" : "list_not_array",
      resultType: record.levels === null ? "null" : typeof record.levels,
      containerType: data === null ? "null" : typeof data,
      rejectedCount: 1,
    });
    return [];
  }
  const levels = record.levels.filter((level): level is string => typeof level === "string");
  const rejectedCount = record.levels.length - levels.length;
  if (rejectedCount > 0) {
    logger.warn("workspace config thinking levels rejected", {
      event: "omp.workspace_config.thinking_levels.rejected",
      stage: "entry_schema",
      reason: "non_string_entries",
      entryCount: record.levels.length,
      rejectedCount,
    });
  }
  return levels;
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
