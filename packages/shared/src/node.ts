/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
import { webcrypto } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

// Node 18 默认不暴露全局 WebCrypto；只在 Node 入口补齐，避免浏览器入口引入 Node builtin。
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    enumerable: true,
    get: () => webcrypto,
  });
}

/** OmpCode 应用根独立于 OMP 自身配置；不修改传给 OMP 的原始环境。 */
export function resolveOmpCodeDataRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homePath: string = env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    homedir(),
): string {
  const value = env.OMP_CONFIG_ROOT?.trim();
  const expanded =
    value === "~"
      ? homePath
      : value?.startsWith("~/") || value?.startsWith("~\\")
        ? join(homePath, value.slice(2))
        : value;
  // 原因：相对路径、空值及含 NUL 的路径不能成为随 cwd 漂移的持久化事实。
  return expanded && !expanded.includes("\0") && isAbsolute(expanded)
    ? join(dirname(normalize(expanded)), `${basename(normalize(expanded))}_ompcode`)
    : join(homePath, ".ompcode");
}
export { acquireFileLock } from "./node/atomicFileLock.js";
export { createNodeNetworkCapture, withoutNetworkCapture } from "./node/networkCapture.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
