import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { ompAvailableCommandsFrameSchema } from "./ompFrames.js";

/** omp 的命令目录是可执行技能的唯一事实源；TUI 发现页还包含禁用和遮蔽项。 */
export function skillCatalogOfCommands(commands: unknown): ZCodeSkillReferenceCatalogEntry[] {
  const parsed = ompAvailableCommandsFrameSchema.safeParse({
    type: "available_commands_update",
    commands,
  });
  if (!parsed.success) {
    throw new Error("invalid omp available commands catalog");
  }
  const skills: ZCodeSkillReferenceCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const command of parsed.data.commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice("skill:".length).trim();
    if (!name || /[\s/]/u.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({
      id: `omp:skill:${name}`,
      name,
      description: command.description ?? "",
      scope: "omp",
      enabled: true,
    });
  }
  return skills;
}
