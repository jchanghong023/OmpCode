#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产（omp 换核后）：
//   1. 构建 packages/omp-agent 单文件 bundle（dist/omp-agent.cjs，esbuild）；
//   2. 暂存到 bundled-agents/<platform>/glm/omp-agent.cjs（stage-omp-agent-bundle.mjs）；
//   3. 下载内嵌 omp release 二进制到同目录 omp/（fetch-omp-release.mjs）。
//
// 旧 zcode-cli bundle、官方插件 runtime 与内置技能包不再随包分发（FORK.md 已知差异：
// 插件/技能面由 omp 自身体系承担）。electron-builder 把 glm 目录整目录拷进 resources/glm。
//
// dev 链（scripts/build-desktop-agent-cli.mjs）复用同一暂存实现。

import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-omp-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

console.log("[prepare:agent-bundle] building omp-agent bundle ...");
runCommand(process.execPath, [resolve(repoRoot, "packages/omp-agent/scripts/bundle.mjs")], {
  cwd: repoRoot,
  env: process.env,
});

stageAgentBundle({ repoRoot, platformKey });

runCommand(process.execPath, [resolve(desktopRoot, "scripts/fetch-omp-release.mjs")], {
  cwd: repoRoot,
  env: process.env,
});

console.log("[prepare:agent-bundle] done (omp-agent.cjs + embedded omp binary staged)");
