#!/usr/bin/env node
// W1 构建双轨：CentOS 7 构建态切换脚本（幂等）。
//
// 需求依据：docs/requirements/centos7-release.md「Electron 选型」——仓库 manifest 与 lockfile
// 按 Windows 基线维护（Electron 44.x）；CentOS 7 发布流水线在构建任务内把桌面依赖临时切换为
// Electron 28.3.3 与 Node 18 兼容运行时依赖精确版本，并同时启用 `__OMPCODE_CENTOS7_DESKTOP__`
// 发布构建标记。版本切换只发生在 CentOS 7 构建任务的工作区内，「CI 工作区内的临时改写不回传
// 仓库」，本脚本绝不提交、绝不 push，恢复走 `restore`（git checkout）或人工 `git checkout --`，
// 保证「不切换时 Windows 构建零变化」可被验证。
//
// 用法：
//   node scripts/prepare-centos7-build.mjs apply     # 切换到 CentOS 7 构建态（默认子命令）
//   node scripts/prepare-centos7-build.mjs restore   # 还原 Windows 基线（git checkout 相关 manifest）
//   node scripts/prepare-centos7-build.mjs status    # 报告当前工作区构建态（不修改任何文件）
//
// 切换内容（被改写的文件是 packages/{desktop,services,server}/package.json）：
//   1. desktop devDependencies.electron -> 精确 28.3.3（glibc 2.17 上官方二进制可用的最后版本；
//      实测 29.4.6 需 GLIBC_2.18、30.5.1 需 GLIBC_2.25）。
//   2. desktop dependencies 内运行时依赖 -> Node 18 兼容精确版本清单（下方常量，固化自
//      experiment/centos7-no-proot 分支 lockfile 解析值，已剥离 peer 依赖后缀）。
//      workspace:* 依赖保持不变。services/server 仅钉 undici（见 MANIFEST_TARGETS 注释）。
//   3. desktop 写入载体字段 ompCodeCentos7Desktop: true——packages/desktop/vite.config.ts 经
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
  // 当前 updater 闭包已使用此版本；显式声明不改变原有 Node 18 运行时选型。
  "builder-util-runtime": "9.7.0",
  "electron-updater": "6.8.9",
  "module-details-from-path": "1.0.4",
  "node-forge": "1.4.0",
  "node-pty": "1.1.0",
  "playwright-core": "1.63.0",
  react: "19.3.0",
  "react-dom": "19.3.0",
  semver: "7.8.5",
  ssh2: "1.17.0",
  undici: "6.23.0",
  ws: "8.21.3",
  yaml: "2.9.1",
  yauzl: "3.4.0",
  yazl: "3.3.1",
  // 与现有 shared/protocol 验证闭包相同，只补齐 desktop 的直接依赖声明。
  zod: "4.6.5",
});

const DESKTOP_MANIFEST_PATH = "packages/desktop/package.json";
const SERVICES_MANIFEST_PATH = "packages/services/package.json";
const SERVER_MANIFEST_PATH = "packages/server/package.json";

// 各 manifest 的切换规则（C1 金丝雀实证 2026-09：仅钉 desktop 的 undici 不够——services 的
// ^8.11.2 在 --no-frozen-lockfile 解析中胜出并被 electron-builder 打进 app.asar，undici 8.x
// 的 webidl 模块在 Electron 28/Node 18.18 下加载期引用 Node 20+ 才有的全局 File 直接崩溃
// （`ReferenceError: File is not defined`，主进程初始化中断、窗口无法创建）。experiment
// 分支当年能运行，正是因为 desktop/services/server 三处全部钉 6.23.0，无版本歧义。
// services/server 只钉 undici，其余依赖不在本脚本职责内。）
const MANIFEST_TARGETS = [
  {
    path: DESKTOP_MANIFEST_PATH,
    pinAllRuntimeDependencies: true,
    pinElectron: true,
    injectBuildFlag: true,
  },
  {
    path: SERVICES_MANIFEST_PATH,
    pinRuntimeDependencyNames: ["undici"],
  },
  {
    path: SERVER_MANIFEST_PATH,
    pinRuntimeDependencyNames: ["undici"],
  },
];

function resolveManifestPath(relativePath) {
  return resolve(repoRoot, relativePath);
}

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

function readManifest(relativePath) {
  return JSON.parse(readFileSync(resolveManifestPath(relativePath), "utf8"));
}

function isWorkspaceSpec(spec) {
  return typeof spec === "string" && (spec.startsWith("workspace:") || spec.startsWith("link:"));
}

function isCentos7AppliedManifest(manifest) {
  // 载体字段是切换态的签名（只在 desktop manifest 注入）：restore 仅在签名存在时执行，
  // 防止把用户与脚本无关的未提交 manifest 改动误当成本脚本的临时改写一并 checkout 丢弃。
  return manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] === true;
}

function applyState() {
  const changes = [];
  const warnings = [];

  for (const target of MANIFEST_TARGETS) {
    const originalContent = readFileSync(resolveManifestPath(target.path), "utf8");
    const eol = detectEol(originalContent);
    const manifest = JSON.parse(originalContent);
    const targetChanges = [];

    if (target.pinElectron) {
      // desktop：Electron 切到精确 28.3.3。
      const currentElectron = manifest.devDependencies?.electron;
      if (currentElectron !== CENTOS7_ELECTRON_VERSION) {
        manifest.devDependencies.electron = CENTOS7_ELECTRON_VERSION;
        targetChanges.push(
          `devDependencies.electron: ${String(currentElectron)} -> ${CENTOS7_ELECTRON_VERSION}`,
        );
      }
    }

    // 运行时依赖切到 Node 18 兼容精确版。需求要求全精确版本保证 --no-frozen-lockfile
    // 构建可重现；desktop 全量钉清单并告警清单外依赖，services/server 仅钉指定依赖
    //（当前为 undici），其余依赖不属于本脚本职责、不告警。
    const onlyNames = target.pinAllRuntimeDependencies
      ? null
      : new Set(target.pinRuntimeDependencyNames ?? []);
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (isWorkspaceSpec(spec)) {
        continue;
      }
      if (!target.pinAllRuntimeDependencies && !onlyNames.has(name)) {
        continue;
      }
      const pinned = CENTOS7_PINNED_RUNTIME_DEPENDENCIES[name];
      if (pinned === undefined) {
        warnings.push(
          `${target.path} dependencies.${name}=${String(spec)} 不在 Node 18 兼容精确清单内，已保留原样，需人工确认兼容性`,
        );
        continue;
      }
      if (spec !== pinned) {
        manifest.dependencies[name] = pinned;
        targetChanges.push(`dependencies.${name}: ${String(spec)} -> ${pinned}`);
      }
    }

    if (target.injectBuildFlag && manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] !== true) {
      // 注入 __OMPCODE_CENTOS7_DESKTOP__ 构建标记载体字段（desktop 专属）。
      manifest[CENTOS7_DESKTOP_MANIFEST_FIELD] = true;
      targetChanges.push(`${CENTOS7_DESKTOP_MANIFEST_FIELD}: true（vite define 注入源）`);
    }

    if (targetChanges.length > 0) {
      writeFileSync(resolveManifestPath(target.path), serializeManifest(manifest, eol), "utf8");
      for (const change of targetChanges) {
        changes.push(`${target.path}: ${change}`);
      }
    }
  }

  if (changes.length > 0) {
    for (const change of changes) {
      log(`switched: ${change}`);
    }
  } else {
    log("already in CentOS 7 build state; no changes (idempotent)");
  }
  for (const warning of warnings) {
    console.warn(`[prepare-centos7-build][warn] ${warning}`);
  }
  log(
    `done: desktop electron=${CENTOS7_ELECTRON_VERSION} + ${CENTOS7_DESKTOP_MANIFEST_FIELD}=true; services/server undici=${CENTOS7_PINNED_RUNTIME_DEPENDENCIES.undici}`,
  );
  return 0;
}

async function resolveRepoRootFromGit() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

async function restoreState() {
  const desktopManifest = readManifest(DESKTOP_MANIFEST_PATH);
  if (!isCentos7AppliedManifest(desktopManifest)) {
    log("workspace is not in CentOS 7 build state (desktop manifest 载体字段不存在)；未做任何修改");
    return 0;
  }

  const gitRoot = await resolveRepoRootFromGit();
  if (resolve(gitRoot) !== resolve(repoRoot)) {
    throw new Error(`git 仓库根 (${gitRoot}) 与脚本仓库根 (${repoRoot}) 不一致，拒绝还原`);
  }

  const manifestPaths = MANIFEST_TARGETS.map((target) => target.path);

  // 恢复能力按任务卡设计为 git checkout：临时改写绝不进入提交。desktop 签名在，
  // 三处被本脚本切换的 manifest 一并还原。
  await execFileAsync("git", ["checkout", "--", ...manifestPaths], {
    cwd: repoRoot,
  });

  const { stdout: leftover } = await execFileAsync(
    "git",
    ["status", "--porcelain", "--", ...manifestPaths],
    { cwd: repoRoot },
  );
  if (leftover.trim()) {
    throw new Error(`还原后仍有本地改动，请人工检查：${leftover.trim()}`);
  }
  log(`restored: ${manifestPaths.join("、")} 已回到 Windows 基线（与 HEAD 一致）`);
  return 0;
}

async function statusState() {
  const manifest = readManifest(DESKTOP_MANIFEST_PATH);
  const applied = isCentos7AppliedManifest(manifest);
  const electronVersion = manifest.devDependencies?.electron;
  const defineValue = isCentos7DesktopBuild();
  const unpinnedRuntimeDeps = Object.entries(manifest.dependencies ?? {})
    .filter(
      ([name, spec]) =>
        !isWorkspaceSpec(spec) && CENTOS7_PINNED_RUNTIME_DEPENDENCIES[name] !== spec,
    )
    .map(([name, spec]) => `${name}@${String(spec)}`);
  const pinnedUndici = CENTOS7_PINNED_RUNTIME_DEPENDENCIES.undici;

  log(
    JSON.stringify(
      {
        state: applied ? "centos7" : "windows-baseline",
        electron: electronVersion,
        centos7ElectronTarget: CENTOS7_ELECTRON_VERSION,
        viteDefineValue: defineValue,
        undici: {
          services: readManifest(SERVICES_MANIFEST_PATH).dependencies?.undici,
          server: readManifest(SERVER_MANIFEST_PATH).dependencies?.undici,
          centos7Target: pinnedUndici,
        },
        unpinnedRuntimeDependencies: unpinnedRuntimeDeps,
      },
      null,
      2,
    ),
  );
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
      console.error(
        `[prepare-centos7-build] 未知子命令: ${command}（可用: apply | restore | status）`,
      );
      process.exitCode = 1;
  }
}

await main();
