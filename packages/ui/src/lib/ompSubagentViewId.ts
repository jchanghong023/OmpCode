// Fork（omp-project-mode.md）：omp 子代理只读详情的合成地址 `omp-subagent:<id>@<parent>`。
// 与 omp-agent 端 buildOmpSubagentViewId/parseOmpSubagentViewId 保持同一文法。

export function parseOmpSubagentViewIdOf(
  viewId: string,
): { parentSessionId: string; subagentId: string } | null {
  if (!viewId.startsWith("omp-subagent:")) return null;
  const rest = viewId.slice("omp-subagent:".length);
  const at = rest.lastIndexOf("@");
  if (at <= 0 || at >= rest.length - 1) return null;
  return { subagentId: rest.slice(0, at), parentSessionId: rest.slice(at + 1) };
}
