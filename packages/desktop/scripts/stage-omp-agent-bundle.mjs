// Agent bundle 的暂存动作：把 packages/omp-agent/dist/omp-agent.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现（历史教训：dev 跑旧暂存产物导致
// agent 侧改动静默不生效）。内嵌 omp 二进制的下载/暂存由 fetch-omp-release.mjs
// 在同目录的 omp/ 子目录完成，本文件只负责 JS bundle。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "packages/omp-agent/dist/omp-agent.cjs";
export const AGENT_BUNDLE_ENTRY = "omp-agent.cjs";

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, AGENT_BUNDLE_ENTRY),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 重建 glm 下的 omp-agent.cjs 与 meta（不整删 glm 目录：fetch-omp-release.mjs
 * 已下载的 omp/ 子目录需要跨重复构建复用）。清空 bundle 文件本身即可。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  mkdirSync(glmDir, { recursive: true });
  rmSync(stagedBundlePath, { force: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: AGENT_BUNDLE_ENTRY,
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
