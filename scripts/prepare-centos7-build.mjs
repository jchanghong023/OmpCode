#!/usr/bin/env node
// W1 构建双轨：CentOS 7 构建态切换脚本（幂等）。
//
// 需求依据：docs/requirements/centos7-release.md「Electron 选型」——仓库 manifest 与 lockfile
// 按 Windows 基线维护（Electron 44.x）；CentOS 7 发布流水线在构建任务内把桌面依赖临时切换为
// Electron 28.3.3 与 Node 18 兼容运行时依赖精确版本，并同时启用 `__OMPCODE_CENTOS7_DESKTOP__`
// 发布构建标记。版本切换只发生在 CentOS 7 构建任务的工作区内，「CI 工作区内的临时改写不回传
// 仓库」：本脚本绝不提交、绝不 push，恢复走 `restore`（git checkout）或人工 `git checkout --`
// packages/desktop/package.json，保证「不切换时 Windows 构建零变化」可被验证。
//
// 用法：
//   node scripts/prepare-centos7-build.mjs apply     # 切换到 CentOS 7 构建态（默认子命令）
//   node scripts/prepare-centos7-build.mjs restore   # 还原 Windows 基线（git checkout 该 manifest）
//   node scripts/prepare-centos7-build.mjs status    # 报告当前工作区构建态（不修改任何文件）
//
// 切换内容（唯一被改写的文件是 packages/desktop/package.json）：
//   1. devDependencies.electron -> 精确 28.3.3（glibc 2.17 上官方二进制可用的最后版本；
//      实测 29.4.6 需 GLIBC_2.18、30.5.1 需 GLIBC_2.25）。
//   2. dependencies 内运行时依赖 -> Node 18 兼容精确版本清单（下方常量，固化自
//      experiment/centos7-no-proot 分支 pnpm-lock.yaml 的 packages/desktop importer 解析值，
//      已剥离 peer 依赖后缀）。workspace:* 依赖保持不变。
//   3. 写入载体字段 ompCodeCentos7Desktop: true——packages/desktop/vite.config.ts 经
//      packages/desktop/scripts/centos7-build-flag.mjs 读取它来决定 `__OMPCODE_CENTOS7_DESKTOP__`
//      define 的注入值；Windows 基线不含该字段，define 恒为 false。
//
// Electron 打包版本不再依赖第二个钉死值：packages/desktop/electron-builder.config.js 动态读取
// 本脚本切换的 manifest devDependencies.electron，避免配置与 manifest 漂移。

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isCentos7DesktopBuild } from "../packages/desktop/scripts/centos7-build-flag.mjs";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const desktopManifestPath = resolve(repoRoot, "packages/desktop/package.json");

// CentOS 7 构建任务钉住的 Electron 精确版本（docs/requirements/centos7-release.md「Electron 选型」）。
export const CENTOS7_ELECTRON_VERSION = "28.3.3";

// __OMPCODE_CENTOS7_DESKTOP__ 构建标记在 manifest 内的载体字段，与 centos7-build-flag.mjs 保持一致。
export const CENTOS7_DESKTOP_MANIFEST_FIELD = "ompCodeCentos7Desktop";

// Node 18 兼容运行时依赖精确清单（不含 Electron，Electron 见 CENTOS7_ELECTRON_VERSION）。
// 唯一来源：experiment/centos7-no-proot 的 pnpm-lock.yaml 中 packages/desktop importer 的
// resolved version，剥离 `版本(peer@x.y.z)` 形态的后缀后固化于此；后续依赖升级必须重新从
// 该分支或新的 Node 18 兼容验证结论中提取，不得凭记忆改写。
export const CENTOS7_PINNED_RUNTIME_DEPENDENCIES = Object.freeze({
  "@arms/rum-electron": "0.0.3",
  "@babel/runtime": "7.29.7",
  "@fiahfy/icns": "0.0.7",
  "@larksuiteoapi/node-sdk": "1.74.0",
  "@lydell/node-pty-linux-arm64": "1.2.0-beta.15",
  "@lydell/node-pty-linux-x64": "1.2.0-beta.15",
  "@opentelemetry/api": "1.9.1",
  "@opentelemetry/exporter-metrics-otlp-proto": "0.222.0",
  "@opentelemetry/exporter-trace-otlp-proto": "0.222.0",
  "@opentelemetry/resources": "2.11.0",
  "@opentelemetry/sdk-metrics": "2.11.0",
  "@opentelemetry/sdk-trace-base": "2.11.0",
  "better-sqlite3": "9.6.0",
  "electron-updater": "6.8.9",
  "module-details-from-path": "1.0.4",
  "node-forge": "1.4.0",
  "node-pty": "1.1.0",
  "playwright-core": "1.63.0",
  "react": "19.3.0",
  "react-dom": "19.3.0",
  "semver": "7.8.5",
  "ssh2": "1.17.0",
  "undici": "6.23.0",
  "ws": "8.21.3",
  "yaml": "2.9.1",
  "yauzl": "3.4.0",
  "yazl": "3.3.1",
});

function log(message) {
  console.log(`[prepare-centos7-build] ${message}`);
}

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function serializeManifest(manifest, eol) {
  // 字符串值内的换行在 JSON 中总是转义形态，按行替换 EOL 不会破坏内容。
  return `${JSON.stringify(manifest, null, 2).replaceAll("\n", eol)}${eol}`;
}

function readDesktopManifest() {
  return JSON.parse(readFileSync(desktopManifestPath, "utf8"));
}

function isWorkspaceSpec(spec) {
  return typeof spec === "string" && (spec.startsWith("workspace:") || spec.startsWith("link:"));
}

function isCentos7AppliedManifest(manifest) {
  // 载体字段是切换态的签名：apply 只在字段存在时才有资格被 restore 还原，
  // 防止把用户与脚本无关的未提交 manifest 改动误当成本脚本的临时改写一并 checkout 丢弃。
  return manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] === true;
}

function applyState() {
  const originalContent = readFileSync(desktopManifestPath, "utf8");
  const eol = detectEol(originalContent);
  const manifest = JSON.parse(originalContent);
  const changes = [];
  const warnings = [];

  // 1. Electron 切到精确 28.3.3。
  const currentElectron = manifest.devDependencies?.electron;
  if (currentElectron !== CENTOS7_ELECTRON_VERSION) {
    manifest.devDependencies.electron = CENTOS7_ELECTRON_VERSION;
    changes.push(`devDependencies.electron: ${String(currentElectron)} -> ${CENTOS7_ELECTRON_VERSION}`);
  }

  // 2. 运行时依赖切到 Node 18 兼容精确版。需求要求全精确版本保证 --no-frozen-lockfile
  //    构建可重现；清单外依赖无法证明 Node 18 兼容，保留原样并告警，由人工/W2 依赖审计补清单。
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (isWorkspaceSpec(spec)) {
      continue;
    }
    const pinned = CENTOS7_PINNED_RUNTIME_DEPENDENCIES[name];
    if (pinned === undefined) {
      warnings.push(
        `dependencies.${name}=${String(spec)} 不在 Node 18 兼容精确清单内，已保留原样，需人工确认兼容性`,
      );
      continue;
    }
    if (spec !== pinned) {
      manifest.dependencies[name] = pinned;
      changes.push(`dependencies.${name}: ${String(spec)} -> ${pinned}`);
    }
  }

  // 3. 注入 __OMPCODE_CENTOS7_DESKTOP__ 构建标记载体字段。
  if (manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] !== true) {
    manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] = true;
    changes.push(`${CENTOS7_DESKTOP_MANIFEST_FIELD}: true（vite define 注入源）`);
  }

  if (changes.length > 0) {
    writeFileSync(desktopManifestPath, serializeManifest(manifest, eol), "utf8");
    for (const change of changes) {
      log(`switched: ${change}`);
    }
  } else {
    log("already in CentOS 7 build state; no changes (idempotent)");
  }
  for (const warning of warnings) {
    console.warn(`[prepare-centos7-build][warn] ${warning}`);
  }
  log(`done: packages/desktop/package.json electron=${CENTOS7_ELECTRON_VERSION}, ${CENTOS7_DESKTOP_MANIFEST_FIELD}=true`);
  return 0;
}

async function resolveRepoRootFromGit() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot });
  return stdout.trim();
}

async function restoreState() {
  const manifest = readDesktopManifest();
  if (!isCentos7AppliedManifest(manifest)) {
    log("workspace is not in CentOS 7 build state (manifest 载体字段不存在)；未做任何修改");
    return 0;
  }

  const gitRoot = await resolveRepoRootFromGit();
  if (resolve(gitRoot) !== resolve(repoRoot)) {
    throw new Error(`git 仓库根 (${gitRoot}) 与脚本仓库根 (${repoRoot}) 不一致，拒绝还原`);
  }

  // 恢复能力按任务卡设计为 git checkout：临时改写绝不进入提交。
  await execFileAsync("git", ["checkout", "--", "packages/desktop/package.json"], { cwd: repoRoot });

  const { stdout: leftover } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--", "packages/desktop/package.json"],
    { cwd: repoRoot },
  );
  if (leftover.trim()) {
    throw new Error(`还原后 packages/desktop/package.json 仍有本地改动，请人工检查：${leftover.trim()}`);
  }
  log("restored: packages/desktop/package.json 已回到 Windows 基线（与 HEAD 一致）");
  return 0;
}

async function statusState() {
  const manifest = readDesktopManifest();
  const applied = isCentos7AppliedManifest(manifest);
  const electronVersion = manifest.devDependencies?.electron;
  const defineValue = isCentos7DesktopBuild();
  const unpinnedRuntimeDeps = Object.entries(manifest.dependencies ?? {})
    .filter(([name, spec]) => !isWorkspaceSpec(spec) && CENTOS7_PINNED_RUNTIME_DEPENDENCIES[name] !== spec)
    .map(([name, spec]) => `${name}@${String(spec)}`);

  log(JSON.stringify(
    {
      state: applied ? "centos7" : "windows-baseline",
      electron: electronVersion,
      centos7ElectronTarget: CENTOS7_ELECTRON_VERSION,
      viteDefineValue: defineValue,
      unpinnedRuntimeDependencies: unpinnedRuntimeDeps,
    },
    null,
    2,
  ));
  return 0;
}

async function main() {
  const command = process.argv[2] ?? "apply";
  switch (command) {
    case "apply":
      process.exitCode = applyState();
      break;
    case "restore":
      process.exitCode = await restoreState();
      break;
    case "status":
      process.exitCode = await statusState();
      break;
    default:
      console.error(`[prepare-centos7-build] 未知子命令: ${command}（可用: apply | restore | status）`);
      process.exitCode = 1;
  }
}

await main();
