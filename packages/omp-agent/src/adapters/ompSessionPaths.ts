import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveOmpProfileFromEnv } from "@zcode/shared/omp-profile";
import {
  isOfflineShmEnabled,
  resolveOmpAgentDir,
  resolveOmpCodeDataRootFromEnv,
} from "@zcode/shared/node";
import { logger } from "./logger.js";
import { safeErrorSummary } from "./hostRequestDiagnostics.js";

/**
 * omp sessions 目录解析（S1-3，对齐 omp DirResolver XDG 规则，v18.4.8+fork.278
 * packages/utils/src/dirs.ts）。platform/home/exists 注入仅供 UT；生产路径与本函数唯一。
 * omp 精确条件（已按 git show 核对）：
 * - 仅 linux/darwin 参与 XDG，win32 不受影响；
 * - 仅 $XDG_DATA_HOME（data 类别；sessions 归 data）非空时参与，无 trim；
 * - 默认 profile 锚定 $XDG_DATA_HOME/omp，命名 profile 锚定 $XDG_DATA_HOME/omp/profiles/<profile>，
 *   且锚点目录必须真实存在；有效 OMP_CONFIG_ROOT 或 offline shm 禁用 XDG。
 * - XDG 生效时扁平化 agent/ 前缀：sessions 目录直接挂在锚点下（$XDG_DATA_HOME/omp/sessions）。
 * PI_CODING_AGENT_DIR 覆盖会关闭 omp 的 XDG 分支，但本适配层历来未消费该变量，维持现状不扩 scope。
 */
export function ompSessionsRoot(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists: (path: string) => boolean;
  hostname?: string;
  uid?: number;
}): string {
  const { env, platform, home, exists } = options;
  const profile = resolveOmpProfileFromEnv(env);
  // OMP offline 已将活动数据切到 shm，不能探测旧 XDG/NFS 锚点或恢复旧根。
  if (isOfflineShmEnabled(env, platform)) {
    const agent = resolveOmpAgentDir(home, env, {
      platform,
      hostname: options.hostname,
      uid: options.uid,
    });
    return `${agent}/sessions`;
  }
  const xdgDataHome = env.XDG_DATA_HOME;
  if (
    (platform === "linux" || platform === "darwin") &&
    xdgDataHome &&
    !resolveOmpCodeDataRootFromEnv(home, env)
  ) {
    const appRoot = join(xdgDataHome, "omp");
    const anchor = profile === "default" ? appRoot : join(appRoot, "profiles", profile);
    if (exists(anchor)) {
      return join(anchor, "sessions");
    }
  }
  return join(resolveOmpAgentDir(home, env), "sessions");
}

export function sessionsRoot(env: NodeJS.ProcessEnv): string {
  return ompSessionsRoot({
    env,
    platform: process.platform,
    home: homedir(),
    exists: (path) => existsSync(path),
  });
}

async function resolveEquivalentPath(value: string): Promise<string> {
  const startedAt = Date.now();
  try {
    return await realpath(value);
  } catch (error) {
    logger.debug("路径规范化失败，沿用原路径", {
      event: "omp.store.realpath.fallback",
      stage: "realpath",
      elapsedMs: Date.now() - startedAt,
      ...safeErrorSummary(error),
    });
    return value;
  }
}

export async function encodeSessionDirName(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const resolvedCwd = resolve(cwd);
  // OMP 会把自己的 TMPDIR 映射到 profile 根/tmp；不能用 GUI 的临时根编码核心历史。
  const tempRoot = isOfflineShmEnabled(env)
    ? join(dirname(resolveOmpAgentDir(homedir(), env)), "tmp")
    : tmpdir();
  const [canonicalCwd, canonicalHome, canonicalTemp] = await Promise.all([
    resolveEquivalentPath(resolvedCwd),
    resolveEquivalentPath(homedir()),
    resolveEquivalentPath(tempRoot),
  ]);
  const homeRelative = relative(canonicalHome, canonicalCwd);
  const tempRelative = relative(canonicalTemp, canonicalCwd);
  const withinHome =
    homeRelative === "" || (!homeRelative.startsWith("..") && !isAbsolute(homeRelative));
  const withinTemp =
    tempRelative === "" || (!tempRelative.startsWith("..") && !isAbsolute(tempRelative));
  // Bug 根因：Windows 的临时目录通常位于用户目录内；omp 优先使用临时目录编码，
  // 此处原先优先匹配用户目录，导致重启后找不到真实会话文件及子代理记录。
  if (withinTemp) {
    return encodeRelative("-tmp", tempRelative);
  }
  if (withinHome) return encodeRelative("-", homeRelative);
  return `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelative(prefix: string, relativePath: string): string {
  const encoded = relativePath.replace(/[/\\:]/g, "-");
  if (!encoded) {
    return prefix;
  }
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}
