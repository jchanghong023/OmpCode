// omp available_commands 目录 → workspace-config slashCommands 的纯投影。
// app 层（serverApp 热刷新）与 adapters 层（workspaceConfig 目录加载）共用，故置于 domain。

import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { ompAvailableCommandsFrameSchema } from "./ompFrames.js";

/** omp available_commands_update / get_available_commands 的命令数组 → slashCommands 投影。 */
export function normalizeOmpSlashCommands(
  commands: unknown,
): WorkspaceConfigState["slashCommands"] {
  if (!Array.isArray(commands)) {
    return [];
  }
  const output: WorkspaceConfigState["slashCommands"] = [];
  for (const entry of commands) {
    const parsed = ompAvailableCommandsFrameSchema.shape.commands.element.safeParse(entry);
    if (!parsed.success || parsed.data.name.trim().length === 0) {
      continue;
    }
    const command = parsed.data;
    // omp 的 skill 命令已由技能目录投影到单独的候选区；重复放入普通命令区会显示两次。
    if (command.source === "skill") continue;
    output.push({
      name: command.name,
      description: command.description ?? "",
      ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
      source: command.source === "builtin" ? ("builtin" as const) : ("custom" as const),
    });
  }
  return output;
}

/** get_available_commands 响应载荷（{commands} 包装）→ slashCommands 投影。 */
export function slashCommandsOfResponse(data: unknown): WorkspaceConfigState["slashCommands"] {
  const payload = typeof data === "object" && data !== null ? data : {};
  const parsed = ompAvailableCommandsFrameSchema.safeParse({
    ...payload,
    type: "available_commands_update",
  });
  return parsed.success ? normalizeOmpSlashCommands(parsed.data.commands) : [];
}
