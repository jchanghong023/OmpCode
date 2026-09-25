import type { ModelSelection } from "@zcode/shared/model-selection";
import { highestOmpThoughtLevel, type OmpModelCatalogEntry } from "./ompModelCatalog.js";

export interface ParsedOmpRoleValue {
  modelPart: string;
  levelSuffix: string | null;
}

/** omp 模型 ID 可以含冒号；只有目录中存在的模型 + 档位组合才拆后缀。 */
export function parseOmpRoleValue(
  value: string,
  catalog: readonly OmpModelCatalogEntry[],
): ParsedOmpRoleValue {
  const modelParts = new Map(catalog.map((entry) => [`${entry.providerId}/${entry.modelId}`, entry]));
  if (modelParts.has(value)) return { modelPart: value, levelSuffix: null };
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator >= value.length - 1) {
    return { modelPart: value, levelSuffix: null };
  }
  const modelPart = value.slice(0, separator);
  const levelSuffix = value.slice(separator + 1);
  if (modelParts.get(modelPart)?.thoughtLevels?.includes(levelSuffix)) {
    return { modelPart, levelSuffix };
  }
  return { modelPart: value, levelSuffix: null };
}

export function selectOmpRoleModelValue(
  currentValue: string,
  modelPart: string,
  catalog: readonly OmpModelCatalogEntry[],
): string {
  const entry = catalog.find((candidate) => `${candidate.providerId}/${candidate.modelId}` === modelPart);
  if (!entry) return currentValue;
  const level = highestOmpThoughtLevel(entry);
  return level ? `${modelPart}:${level}` : modelPart;
}

export function selectOmpRoleLevelValue(
  currentValue: string,
  level: string,
  catalog: readonly OmpModelCatalogEntry[],
): string {
  const { modelPart } = parseOmpRoleValue(currentValue, catalog);
  const entry = catalog.find((candidate) => `${candidate.providerId}/${candidate.modelId}` === modelPart);
  if (!entry || (level && !entry.thoughtLevels?.includes(level))) return currentValue;
  return level ? `${modelPart}:${level}` : modelPart;
}

export function ompRoleValueToSelection(
  value: string,
  catalog: readonly OmpModelCatalogEntry[],
): ModelSelection | null {
  const parsed = parseOmpRoleValue(value, catalog);
  const slash = parsed.modelPart.indexOf("/");
  if (slash <= 0 || slash >= parsed.modelPart.length - 1) return null;
  const entry = catalog.find(
    (candidate) => `${candidate.providerId}/${candidate.modelId}` === parsed.modelPart,
  );
  const reasoningLevel = parsed.levelSuffix ?? highestOmpThoughtLevel(entry);
  return {
    providerId: parsed.modelPart.slice(0, slash),
    modelId: parsed.modelPart.slice(slash + 1),
    options: reasoningLevel ? { reasoningLevel } : undefined,
  };
}
