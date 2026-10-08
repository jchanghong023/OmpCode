import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { resolveOmpProfileFromEnv } from "../omp-profile.js";

export function resolveOmpConfigRoot(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  // 根因：OMP 新增根目录覆盖后，应用仍只读 PI_CONFIG_DIR，导致配置与冷历史指向旧目录。
  // 按 OMP resolveAbsoluteDir 展开 ~ 并忽略相对值，不能把它绑定到当前 workspace。
  let root = env.OMP_CONFIG_ROOT?.trim();
  if (root === "~") root = home;
  else if (root?.startsWith("~/") || root?.startsWith("~\\")) root = home + root.slice(1);
  if (root && isAbsolute(root)) return normalize(root);
  return resolve(home, env.PI_CONFIG_DIR?.trim() || ".omp");
}

export function resolveOmpAgentDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const root = resolveOmpConfigRoot(home, env);
  const profile = resolveOmpProfileFromEnv(env);
  return profile === "default" ? join(root, "agent") : join(root, "profiles", profile, "agent");
}
