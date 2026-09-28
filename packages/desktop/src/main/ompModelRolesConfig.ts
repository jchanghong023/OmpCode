import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMap, parseDocument, stringify, YAMLMap } from "yaml";
import { resolveOmpAgentDir } from "./ompProfiles.js";

export interface OmpModelRole {
  role: string;
  value: string;
}

export function resolveOmpModelRolesConfigPath(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  // omp profile 同时决定角色配置、模型目录和会话历史的用户根。
  return join(resolveOmpAgentDir(home, env), "config.yml");
}

type ReadResult = { success: true; roles: OmpModelRole[] } | { success: false; error: string };
type WriteResult = { success: true; backupPath?: string } | { success: false; error: string };

function parseConfig(raw: string) {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) throw new Error("omp_config_parse_failed");
  const node = doc.get("modelRoles", true);
  if (node !== undefined && !isMap(node)) throw new Error("omp_model_roles_invalid");
  return { doc, roles: node as YAMLMap | undefined };
}

export async function readOmpModelRolesConfig(configPath: string): Promise<ReadResult> {
  try {
    const { roles } = parseConfig(await readFile(configPath, "utf8"));
    const list: OmpModelRole[] = [];
    for (const pair of roles?.items ?? []) {
      const role = String(pair.key?.toJSON() ?? "");
      const rawValue = pair.value?.toJSON();
      const value = Array.isArray(rawValue)
        ? rawValue.every((entry) => typeof entry === "string")
          ? rawValue.join(",")
          : null
        : typeof rawValue === "string"
          ? rawValue
          : null;
      if (!role || value === null) throw new Error("omp_model_roles_invalid");
      list.push({ role, value });
    }
    return { success: true, roles: list };
  } catch (error) {
    // 首次使用 omp 时 config.yml 尚不存在，内建角色仍需要显示供用户选择。
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { success: true, roles: [] };
    }
    return { success: false, error: configError(error) };
  }
}

export async function writeOmpModelRolesConfig(
  configPath: string,
  updates: readonly OmpModelRole[],
): Promise<WriteResult> {
  const tempPath = join(dirname(configPath), `.omp-config-${randomUUID()}.tmp`);
  try {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const doc = parseDocument("");
      const roles = new YAMLMap();
      for (const { role, value } of updates) roles.set(role, value);
      doc.set("modelRoles", roles);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(tempPath, doc.toString(), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const handle = await open(tempPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // 配置可能在读取后由 omp 创建；原子链接只在目标仍不存在时成功，绝不覆盖它。
      await link(tempPath, configPath);
      return { success: true };
    }
    const { doc, roles } = parseConfig(raw);
    const map = roles ?? new YAMLMap();
    const replacements: { start: number; end: number; value: string }[] = [];
    let changedCount = 0;
    let requiresSerialization = !roles;
    for (const { role, value } of updates) {
      // omp 允许 model ID 内含冒号（如 :free）；这里把值当原文保存。
      const existing = roles?.items.find((pair) => pair.key?.toJSON() === role);
      const previous = existing?.value?.toJSON();
      if (previous === value || (Array.isArray(previous) && previous.join(",") === value)) {
        continue;
      }
      changedCount += 1;
      if (!existing) requiresSerialization = true;
      else if (existing.value?.range) {
        replacements.push({
          start: existing.value.range[0],
          end: existing.value.range[1],
          value: stringify(value).trimEnd(),
        });
      } else requiresSerialization = true;
      map.set(role, value);
    }
    if (changedCount === 0) return { success: true };
    if (!roles) doc.set("modelRoles", map);
    // 仅改已有 role 时按 YAML 节点范围替换标量，避免重排其他配置的格式和注释。
    const next = requiresSerialization
      ? doc.toString()
      : replacements
          .sort((left, right) => right.start - left.start)
          .reduce(
            (text, item) => text.slice(0, item.start) + item.value + text.slice(item.end),
            raw,
          );
    if (next === raw) return { success: true };

    const backupPath = `${configPath}.bak-${Date.now()}-${randomUUID()}`;
    await copyFile(configPath, backupPath);
    const mode = (await stat(configPath)).mode;
    await writeFile(tempPath, next, { encoding: "utf8", mode });
    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, configPath);
    return { success: true, backupPath };
  } catch (error) {
    return { success: false, error: configError(error) };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function configError(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "omp_config_missing";
  }
  if (error instanceof Error && error.message.startsWith("omp_")) return error.message;
  return "omp_config_io_failed";
}
