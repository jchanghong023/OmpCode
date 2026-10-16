import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { resolveOmpProfileFromEnv } from "../omp-profile.js";
import {
  isOfflineShmEnabled,
  resolveOfflineDataRoots,
  type OfflineDataRootOptions,
} from "./offlineDataRoots.js";

export function resolveOmpConfigRoot(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  options: OfflineDataRootOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const override = resolveOmpConfigRootOverride(home, env, paths);
  if (override) return override;
  // Linux offline 与 OMP offline-root.js 的原始根计算完全一致；其余平台保留旧解析。
  return isOfflineShmEnabled(env, platform)
    ? paths.join(home, env.PI_CONFIG_DIR || ".omp")
    : paths.resolve(home, env.PI_CONFIG_DIR?.trim() || ".omp");
}

function resolveOmpConfigRootOverride(
  home: string,
  env: NodeJS.ProcessEnv,
  paths: typeof posix,
): string | undefined {
  // 根因：OMP 新增根目录覆盖后，应用仍只读 PI_CONFIG_DIR，导致配置与冷历史指向旧目录。
  // 按 OMP resolveAbsoluteDir 展开 ~ 并忽略相对值，不能把它绑定到当前 workspace。
  let root = env.OMP_CONFIG_ROOT?.trim();
  if (root === "~") root = home;
  else if (root?.startsWith("~/") || root?.startsWith("~\\")) root = home + root.slice(1);
  if (root && paths.isAbsolute(root)) return paths.normalize(root);
  return undefined;
}

export function resolveOmpRuntimeRoot(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  options: OfflineDataRootOptions = {},
): string {
  const persistentRoot = resolveOmpConfigRoot(home, env, options);
  return (
    resolveOfflineDataRoots(persistentRoot, "omp", { ...options, env })?.runtimeRoot ??
    persistentRoot
  );
}

/** 应用持久身份不随 shm 活动路径变化，PI_CONFIG_DIR 不参与应用根解析。 */
export function resolveOmpCodePersistentRoot(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  options: OfflineDataRootOptions = {},
): string {
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  const root = resolveOmpConfigRootOverride(home, env, paths);
  return root ? `${paths.resolve(root)}_ompcode` : paths.join(home, ".ompcode");
}

/** 离线默认根也必须映射；非离线保留原先无覆盖时的 undefined 契约。 */
export function resolveOmpCodeDataRootFromEnv(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  options: OfflineDataRootOptions = {},
): string | undefined {
  const persistentRoot = resolveOmpCodePersistentRoot(home, env, options);
  const offline = resolveOfflineDataRoots(persistentRoot, "ompcode", { ...options, env });
  if (offline) return offline.runtimeRoot;
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return resolveOmpConfigRootOverride(home, env, paths) ? persistentRoot : undefined;
}

export function resolveOmpAgentDir(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  options: OfflineDataRootOptions = {},
): string {
  const root = resolveOmpRuntimeRoot(home, env, options);
  const profile = resolveOmpProfileFromEnv(env);
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return profile === "default"
    ? paths.join(root, "agent")
    : paths.join(root, "profiles", profile, "agent");
}
