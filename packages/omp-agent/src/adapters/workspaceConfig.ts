// workspace-config 目录构建：用一个常驻 omp 进程查询模型目录与思考档位。
// omp 的 provider/model 注册表是进程级的；每个会话进程重复查询代价高且无必要。
// v3 fork surface 的工作区级查询（test_model / list_mcp_servers）也复用该进程。

import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { OmpProcessFactory } from "../app/ports.js";
import { slashCommandsOfResponse } from "../domain/ompCommands.js";
import { ompModelCatalogEntrySchema } from "../domain/ompFrames.js";
import {
  ompMcpServerRowSchema,
  ompModelTestResultSchema,
  type OmpForkQueryCommand,
  type OmpMcpServerRow,
  type OmpModelTestResult,
} from "../domain/ompForkFrames.js";
import { logger } from "./logger.js";

export interface WorkspaceConfigLoaderOptions {
  /** 命令目录变化推送（available_commands_update；目录进程常驻监听）；载荷为 omp 原始命令数组。 */
  onCommandsUpdate?: (commands: unknown) => void;
}

/** 未协商 v3 的 omp 对 fork 命令的拒绝文案（rpc-ui-protocol 4.0 既有行为）。 */
function isUnknownCommand(error: string | undefined): boolean {
  return typeof error === "string" && /unknown command/i.test(error);
}

export function createWorkspaceConfigLoader(
  ompFactory: OmpProcessFactory,
  workspacePath: string,
  options: WorkspaceConfigLoaderOptions = {},
) {
  let catalogProcess: Awaited<ReturnType<OmpProcessFactory["create"]>> | null = null;

  async function ensureProcess() {
    if (catalogProcess) {
      return catalogProcess;
    }
    const processHandle = ompFactory.create({
      cwd: workspacePath,
      onEvent: () => {},
      onUiRequest: ({ respond, frame }) =>
        respond({ type: "extension_ui_response", id: frame.id, cancelled: true }),
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

  async function loadWorkspaceConfig(): Promise<WorkspaceConfigState> {
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
                  currentValue: state?.thinkingLevel ?? "off",
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
    } catch (error) {
      logger.warn("workspace-config 目录加载失败", { error: String(error) });
      return { configOptions: [], slashCommands: [] };
    }
  }

  async function loadSkillCommands(): Promise<unknown> {
    const processHandle = await ensureProcess();
    const outcome = await processHandle.send({ type: "get_available_commands" });
    if (!outcome.success) {
      throw new Error(outcome.error ?? "omp command catalog unavailable");
    }
    const record =
      typeof outcome.data === "object" && outcome.data !== null
        ? (outcome.data as { commands?: unknown })
        : {};
    return record.commands;
  }

  /**
   * v3 fork surface 工作区级查询。协商顺序由 omp 串行 stdin 保证（negotiate_protocol
   * 先于本命令写入），因此到达时 v3 门控已定：未协商二进制回 Unknown command → 返回
   * null（能力缺失，调用方按既有降级语义处理），其余失败如实抛出。
   */
  async function sendForkQuery(command: OmpForkQueryCommand): Promise<unknown | null> {
    const processHandle = await ensureProcess();
    const outcome = await processHandle.send(command);
    if (!outcome.success) {
      if (isUnknownCommand(outcome.error)) {
        return null;
      }
      throw new Error(outcome.error ?? `omp ${command.type} failed`);
    }
    return outcome.data;
  }

  /** provider/testModelConnectivity 后端：实测连通性，六类失败归因随载荷返回。 */
  async function testModel(provider: string, modelId: string): Promise<OmpModelTestResult | null> {
    const data = await sendForkQuery({ type: "test_model", provider, modelId });
    if (data === null) {
      return null;
    }
    const parsed = ompModelTestResultSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn("omp test_model 响应不合法", { issues: parsed.error.issues.length });
      throw new Error("omp test_model returned an invalid payload");
    }
    return parsed.data;
  }

  /** mcp/list 后端：omp 配置的 MCP 服务器与尽力连接状态。 */
  async function listMcpServers(): Promise<OmpMcpServerRow[] | null> {
    const data = await sendForkQuery({ type: "list_mcp_servers" });
    if (data === null) {
      return null;
    }
    const record = typeof data === "object" && data !== null ? (data as { servers?: unknown }) : {};
    const rows = Array.isArray(record.servers) ? record.servers : [];
    const servers: OmpMcpServerRow[] = [];
    for (const row of rows) {
      const parsed = ompMcpServerRowSchema.safeParse(row);
      if (parsed.success) {
        servers.push(parsed.data);
      } else {
        logger.warn("omp list_mcp_servers 行不合法", { issues: parsed.error.issues.length });
      }
    }
    return servers;
  }

  return { loadWorkspaceConfig, loadSkillCommands, testModel, listMcpServers };
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
