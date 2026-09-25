import type { ZCodeConfigOption } from "@zcode/shared";

/**
 * omp 模型目录由 workspace-config topic 拥有；旧 presentation 恢复只提供 mode。
 * 两个异步来源先后不定，后到的一方只覆盖自己携带的配置项。
 */
export function mergeOmpWorkspaceConfigOptions(
  existing: readonly ZCodeConfigOption[],
  incoming: readonly ZCodeConfigOption[],
): ZCodeConfigOption[] {
  const byId = new Map(existing.map((option) => [option.id, option]));
  for (const option of incoming) byId.set(option.id, option);
  const ordered: ZCodeConfigOption[] = [];
  for (const id of ["model", "thought_level", "mode"]) {
    const option = byId.get(id);
    if (option) {
      ordered.push(option);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}
