import { useEffect, useMemo } from "react";
import { ZCODE_AGENT_PROVIDER, type ModelSelection, type ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

const EMPTY_CONFIG_OPTIONS: ZCodeConfigOption[] = [];
// 原 Composer 的 workspace 单飞移动到此处；设置与多个 picker 共享同一个水合入口。
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

export interface OmpModelCatalogEntry {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly thoughtLevels: readonly string[] | undefined;
  readonly defaultThoughtLevel: string | undefined;
}
export interface OmpModelCatalog {
  readonly entries: readonly OmpModelCatalogEntry[];
  readonly preferredSelection: ModelSelection | null;
}

export function readOmpModelCatalog(options: readonly ZCodeConfigOption[]): OmpModelCatalog | null {
  const model = options.find((option) => option.id === "model" && option.type === "select");
  if (!model?.options?.length) return null;
  const entries: OmpModelCatalogEntry[] = [];
  for (const option of model.options) {
    const slash = option.value.indexOf("/");
    if (slash <= 0 || slash === option.value.length - 1) continue;
    const providerId = option.modelProviderId?.trim() || option.value.slice(0, slash);
    entries.push({
      providerId,
      providerName: option.modelProviderName?.trim() || providerId,
      modelId: option.value.slice(slash + 1),
      modelName: option.name,
      thoughtLevels: option.modelThoughtLevels,
      defaultThoughtLevel: option.modelDefaultThoughtLevel,
    });
  }
  const preferred = entries.find(
    (entry) => `${entry.providerId}/${entry.modelId}` === model.currentValue,
  );
  return { entries, preferredSelection: preferred ? selectionForOmpEntry(preferred) : null };
}

export function selectionForOmpEntry(entry: OmpModelCatalogEntry): ModelSelection {
  // 默认档位是原生事实，不能像旧 GUI 一样擅自选择最高档。
  const reasoningLevel = entry.defaultThoughtLevel;
  return {
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  };
}

export function findOmpCatalogEntry(
  catalog: OmpModelCatalog | null,
  providerId: string | undefined,
  modelId: string | undefined,
): OmpModelCatalogEntry | undefined {
  return catalog?.entries.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}

export function buildOmpModelSelectGroups(catalog: OmpModelCatalog | null): ModelSelectGroup[] {
  const groups = new Map<string, ModelSelectGroup>();
  for (const entry of catalog?.entries ?? []) {
    let group = groups.get(entry.providerId);
    if (!group) {
      group = { key: `omp-provider:${entry.providerId}`, label: entry.providerName, items: [] };
      groups.set(entry.providerId, group);
    }
    group.items.push({
      key: `${group.key}:${entry.modelId}`,
      value: encodeCustomModelValue(entry.providerId, entry.modelId),
      name: entry.modelName,
    });
  }
  return [...groups.values()];
}

export function ompThoughtOptionForEntry(
  entry: OmpModelCatalogEntry | undefined,
): ZCodeConfigOption | null {
  if (!entry?.thoughtLevels?.length) return null;
  return {
    id: "thought_level",
    name: entry.modelName,
    category: "thought_level",
    type: "select",
    currentValue: entry.defaultThoughtLevel ?? "",
    options: entry.thoughtLevels.map((level) => ({ value: level, name: level })),
  };
}

export function useOmpModelCatalog(
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string | null,
  enabled = true,
) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // 明确目标身份，不借当前 tab 推断，避免同路径 local/remote 目录串域。
  const configOptions = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.configOptions ?? EMPTY_CONFIG_OPTIONS,
  );
  const status = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.configOptionsStatus ?? "idle",
  );
  const storageScope = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftStorageScope ?? null,
  );
  const commandCount = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.slashCommands.length ?? 0,
  );
  const hydrationKey = JSON.stringify([workspaceKey, storageScope]);
  const service = useZCodeSessionService(workspacePath, remoteSessionId, workspaceIdentity);
  const taskService = useZCodeTaskService(workspacePath, remoteSessionId, workspaceIdentity);
  useEffect(() => {
    if (!enabled || !workspacePath) return;
    // 先接 Host 已接受的 workspace-config（含迟订阅重放），再发 presentation prepare。
    // Bug 原因：重启恢复 session 后首次 startDraft 会绑定 profile scope 并清空目录；
    // 常驻 picker 若不重订阅，就永远收不到 Host 已接受目录的迟订阅重放。
    let active = true;
    const subscription = taskService.onDynamicWorkspaceEvent({ workspacePath, workspaceIdentity })((
      event,
    ) => {
      if (!active) return;
      const store = useZCodeSessionStore.getState();
      // 原因：Host 的命令目录与模型目录是独立事件，漏消费会让新草稿永久缺少内置命令。
      if (event.type === "workspace_slash_commands_update") {
        store.setSlashCommands(workspacePath, event.commands, workspaceIdentity);
        return;
      }
      if (event.type !== "workspace_config_options_update") return;
      store.setConfigOptions(workspacePath, event.configOptions, workspaceIdentity);
      if (event.configOptions.some((option) => option.id === "model")) {
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
      }
    });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [enabled, workspacePath, workspaceIdentity, storageScope, taskService]);
  useEffect(() => {
    if (!enabled || !workspacePath) return;
    const store = useZCodeSessionStore.getState();
    const initial = store.getWorkspaceState(workspacePath, workspaceIdentity);
    const modelsReady =
      initial.configOptionsStatus === "ready" &&
      initial.configOptions?.some((option) => option.id === "model");
    // 原因：task → draft 会清空命令但保留模型；模型 ready 不能替代命令目录已加载。
    if ((modelsReady && commandCount > 0) || workspaceCatalogHydrationFlights.has(hydrationKey))
      return;
    if (!modelsReady) store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    // 首次写 loading 才创建 workspace；比较必须基于这个已创建 owner 的数组引用。
    const baseline = store.getWorkspaceState(workspacePath, workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: ZCODE_AGENT_PROVIDER,
      zcodeSessionService: service,
    })
      .then((result) => {
        const latest = useZCodeSessionStore.getState();
        const current = latest.getWorkspaceState(workspacePath, workspaceIdentity);
        // 旧 scope 的 presentation 不得在 profile 切换后回写新 owner。
        if ((current.draftStorageScope ?? null) !== storageScope) return;
        // 水合先发、原生事件后到时，迟到读取不能覆盖较新的目录。
        if (!modelsReady && current.configOptions === baseline.configOptions) {
          latest.setConfigOptions(workspacePath, result.configOptions ?? [], workspaceIdentity);
        }
        // mode-only 的 readPresentation 完成不代表模型已到；原生空模型项才是权威空态。
        const hydrated = latest.getWorkspaceState(workspacePath, workspaceIdentity);
        if (hydrated.configOptions?.some((option) => option.id === "model")) {
          latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        }
        if (current.slashCommands === baseline.slashCommands) {
          latest.setSlashCommands(workspacePath, result.slashCommands ?? [], workspaceIdentity);
        }
      })
      .catch((error: unknown) => {
        if (
          (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .draftStorageScope ?? null) !== storageScope
        )
          return;
        if (!modelsReady) {
          useZCodeSessionStore
            .getState()
            .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        }
        logger.warn(`[omp-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(hydrationKey);
      });
    workspaceCatalogHydrationFlights.set(hydrationKey, flight);
  }, [
    enabled,
    hydrationKey,
    workspacePath,
    workspaceIdentity,
    storageScope,
    service,
    commandCount,
  ]);
  const catalog = useMemo(() => readOmpModelCatalog(configOptions), [configOptions]);
  const modelGroups = useMemo(() => buildOmpModelSelectGroups(catalog), [catalog]);
  return {
    configOptions,
    status,
    loading: status === "loading",
    error: status === "error",
    catalog,
    modelGroups,
    modelOption: configOptions.find(
      (option) =>
        option.id === "model" && option.type === "select" && Boolean(option.options?.length),
    ),
  };
}
