// dev 链的 agent 运行时准备（omp 换核后）：构建 omp-agent bundle、暂存进
// bundled-agents/<host-platform>/glm，并确保内嵌 omp 二进制就位（下载有缓存）。
// 与打包链（packages/desktop/scripts/prepare-omp-agent-bundle.mjs）共用同一暂存实现，
// dev 不可能跑陈旧 agent。
//
// 旧 zcode-cli 的构建链（turbo/tsc/esbuild 与官方插件 runtime）已随换核移除。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-omp-agent-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

console.log("[build-desktop-agent-cli] building omp-agent bundle ...");
runCommand(process.execPath, [resolve(repoRoot, "packages/omp-agent/scripts/bundle.mjs")], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

stageAgentBundle({
  repoRoot,
  platformKey: `${process.platform}-${process.arch}`,
});

runCommand(process.execPath, [resolve(repoRoot, "packages/desktop/scripts/fetch-omp-release.mjs")], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
