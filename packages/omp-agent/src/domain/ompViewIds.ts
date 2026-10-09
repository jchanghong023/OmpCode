// 子代理只读详情的 UI 地址（omp-core-integration.md）：`omp-subagent:<subagentId>@<parentSessionId>`。

const OMP_SUBAGENT_VIEW_PREFIX = "omp-subagent:";
export function buildOmpSubagentViewId(parentSessionId: string, subagentId: string): string {
  return `${OMP_SUBAGENT_VIEW_PREFIX}${subagentId}@${parentSessionId}`;
}
export function parseOmpSubagentViewId(
  viewId: string,
): { parentSessionId: string; subagentId: string } | null {
  if (!viewId.startsWith(OMP_SUBAGENT_VIEW_PREFIX)) return null;
  const rest = viewId.slice(OMP_SUBAGENT_VIEW_PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at <= 0 || at >= rest.length - 1) return null;
  return { subagentId: rest.slice(0, at), parentSessionId: rest.slice(at + 1) };
}
