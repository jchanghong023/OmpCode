// omp 换核（FORK.md）：composer 模型选择的事实源是 workspace-config topic 下发的
// omp 模型目录（`omp --mode rpc-ui` 的 get_available_models 投影，value = `provider/model`），
// 不再是 ZCode 账号侧 GLM 目录。本文件把 configOptions 的模型项解析成选择器分组与
// 选择收敛逻辑；UI 形态与官方完全一致，仅数据源换成 omp。

import type { ModelSelection } from "@zcode/shared/model-selection";
import type { SessionConfigState, WorkspaceConfigOption } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

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

/** omp 按由低到高返回 efforts；`off` 只在没有思考档位时才是最高可用值。 */
export function highestOmpThoughtLevel(entry: OmpModelCatalogEntry | undefined): string | undefined {
  return entry?.thoughtLevels?.filter((level) => level !== "off").at(-1)
    ?? entry?.thoughtLevels?.at(-1);
}

/** 已有会话的有效模型来自该会话投影；旧核心可能只提供 provider/model/thought。 */
export function ompSessionConfigToSelection(
  config: Partial<SessionConfigState> | null | undefined,
): ModelSelection | undefined {
  if (config?.modelSelection) return config.modelSelection;
  const providerId = config?.provider?.trim();
  const modelId = config?.model?.trim();
  if (!providerId || !modelId) return undefined;
  const reasoningLevel = config?.thought?.trim();
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function parseProviderModelValue(value: string): { providerId: string; modelId: string } | null {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= value.length - 1) {
    return null;
  }
  return { providerId: value.slice(0, slashIndex), modelId: value.slice(slashIndex + 1) };
}

/** 无目录（topic 未就绪/无模型）返回 null；调用方保持原选择并按加载态展示。 */
export function readOmpModelCatalog(
  configOptions: readonly WorkspaceConfigOption[] | null | undefined,
): OmpModelCatalog | null {
  const modelOption = configOptions?.find(
    (option) => option.id === "model" && option.type === "select",
  );
  const optionValues = modelOption?.options ?? [];
  if (!modelOption || optionValues.length === 0) {
    return null;
  }
  const entries: OmpModelCatalogEntry[] = [];
  for (const optionValue of optionValues) {
    const parsed = parseProviderModelValue(optionValue.value);
    if (!parsed) continue;
    entries.push({
      providerId: optionValue.modelProviderId?.trim() || parsed.providerId,
      providerName: optionValue.modelProviderName?.trim() || parsed.providerId,
      modelId: parsed.modelId,
      modelName: optionValue.name?.trim() || parsed.modelId,
      thoughtLevels: optionValue.modelThoughtLevels,
      defaultThoughtLevel: optionValue.modelDefaultThoughtLevel,
    });
  }
  if (entries.length === 0) {
    return null;
  }
  const preferred = parseProviderModelValue(String(modelOption.currentValue ?? ""));
  const preferredEntry = preferred
    ? entries.find(
        (entry) => entry.providerId === preferred.providerId && entry.modelId === preferred.modelId,
      )
    : undefined;
  const preferredThoughtLevel = highestOmpThoughtLevel(preferredEntry);
  return {
    entries,
    preferredSelection: preferredEntry
      ? {
          providerId: preferredEntry.providerId,
          modelId: preferredEntry.modelId,
          ...(preferredThoughtLevel
            ? { options: { reasoningLevel: preferredThoughtLevel } }
            : {}),
        }
      : null,
  };
}

/**
 * 语义对齐上游 resolveDraftInitialModelSelection：模型身份失效 → 清空并标记 invalidated；
 * 档位缺失/失效 → 保留身份清档位；无 recent → omp 目录缺省（preferred）。
 */
export function resolveOmpModelSelection(
  catalog: OmpModelCatalog,
  recent: ModelSelection | null,
): { readonly selection: ModelSelection | null; readonly invalidated: boolean } {
  if (!recent) {
    return { selection: catalog.preferredSelection, invalidated: false };
  }
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.providerId === recent.providerId && candidate.modelId === recent.modelId,
  );
  if (!entry) {
    return { selection: null, invalidated: true };
  }
  const reasoning = recent.options?.reasoningLevel;
  if (reasoning === undefined || !(entry.thoughtLevels ?? []).includes(reasoning)) {
    return {
      selection: { providerId: recent.providerId, modelId: recent.modelId },
      invalidated: true,
    };
  }
  return { selection: recent, invalidated: false };
}

export function buildOmpModelSelectGroups(catalog: OmpModelCatalog): ModelSelectGroup[] {
  const groups: ModelSelectGroup[] = [];
  const groupIndexByProviderId = new Map<string, number>();
  for (const entry of catalog.entries) {
    let groupIndex = groupIndexByProviderId.get(entry.providerId);
    if (groupIndex === undefined) {
      groups.push({
        key: `omp-provider:${entry.providerId}`,
        label: entry.providerName,
        items: [],
      });
      groupIndex = groups.length - 1;
      groupIndexByProviderId.set(entry.providerId, groupIndex);
    }
    groups[groupIndex]!.items.push({
      key: `omp-provider:${entry.providerId}:${entry.modelId}`,
      value: encodeCustomModelValue(entry.providerId, entry.modelId),
      name: entry.modelName,
    });
  }
  return groups;
}

export function findOmpCatalogEntry(
  catalog: OmpModelCatalog | null,
  providerId: string | undefined,
  modelId: string | undefined,
): OmpModelCatalogEntry | undefined {
  if (!providerId || !modelId) return undefined;
  return catalog?.entries.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}

/** 思考档位选项（ZCodeConfigOption 形态，供 thought picker 直接消费）。 */
export function ompThoughtOptionForEntry(
  entry: OmpModelCatalogEntry | undefined,
): WorkspaceConfigOption | null {
  if (!entry || !entry.thoughtLevels || entry.thoughtLevels.length === 0) {
    return null;
  }
  return {
    id: "thought_level",
    name: entry.modelName,
    type: "select",
    currentValue: entry.defaultThoughtLevel ?? entry.thoughtLevels[0] ?? "",
    options: entry.thoughtLevels.map((level) => ({ value: level, name: level })),
  };
}
