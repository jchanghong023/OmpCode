import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { exists, gitText } from "./test-gates-process.mjs";

const pnpm = (id, args, extra = {}) => ({ id, command: "pnpm", args, kind: "check", ...extra });
const node = (id, args, extra = {}) => ({ id, command: "node", args, kind: "check", ...extra });

const staticPlan = (all) => [
  pnpm("typecheck", ["typecheck"], { kind: "compile" }),
  pnpm("lint", ["lint"]),
  pnpm(all ? "architecture-all" : "architecture-changed", [
    "architecture:check",
    ...(all ? [] : ["--changed"]),
  ]),
  ...(all
    ? [pnpm("format-all", ["fmt:check"]), pnpm("unused-dependencies-exports", ["knip"])]
    : []),
];

export async function installedOmp() {
  const candidates = [process.env.OMP_RPC_BINARY_PATH];
  if (process.platform === "win32") {
    candidates.push(
      join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "omp/omp.exe"),
    );
  }
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (directory)
      candidates.push(join(directory, process.platform === "win32" ? "omp.exe" : "omp"));
  }
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return candidate;
  return undefined;
}

export async function fastPlan() {
  const changed = [
    ...new Set([
      ...(await gitText(["diff", "--name-only", "-z", "HEAD"])).split("\0"),
      ...(await gitText(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
    ]),
  ].filter((name) => /\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|css|html)$/u.test(name));
  const formatFiles = [];
  for (const name of changed) if (await exists(name)) formatFiles.push(name);
  // 修复：pnpm exec 在 Windows 会经 cmd 转发；大量文件超过 8191 字符时还未检查就失败。
  // 为命令前缀、引号和工具路径保留余量，分批检查完整名单，不放宽 60 秒计费预算。
  const formatBatches = [];
  let batch = [];
  let argumentLength = 0;
  for (const name of formatFiles) {
    if (argumentLength + name.length + 3 > 6000 && batch.length) {
      formatBatches.push(batch);
      batch = [];
      argumentLength = 0;
    }
    batch.push(name);
    argumentLength += name.length + 3;
  }
  if (batch.length) formatBatches.push(batch);
  return [
    ...staticPlan(false),
    ...formatBatches.map((files, index) =>
      pnpm(index ? `format-changed-${index + 1}` : "format-changed", [
        "exec",
        "oxfmt",
        "--check",
        ...files,
      ]),
    ),
  ].map((stage) => ({ ...stage, parallelGroup: "static" }));
}

const coreTests = {
  "omp-agent": [
    "adapter.e2e",
    "coldStoreProjection",
    "conversationEngineStatus",
    "conversationRecovery",
    "frameAssembler",
    "ompCommandOutputHistory",
    "ompCustomMessages",
    "ompExecutionHistory",
    "ompInteractionMapping",
    "ompInteractionProxy",
    "ompProjectorInterruptedToolRow",
    "ompStore",
    "projectionToolCallIndex",
    "projectionTurnLifecycle",
    "promptResultSemantics",
    "protocolServerConcurrency",
    "queueReconciliation",
    "sessionLifecycleGates",
    "sessionRegistry.identity",
    "sessionRegistryAliases",
    "sessionRegistryConcurrency",
    "topicFlowControl",
    "topicWireBudget",
    "v4InteractionAck",
  ],
  services: [
    "ompConcurrentStartup",
    "ompTaskIdMigration",
    "zcodeProtocolClientRejectionTiming",
    "zcodeTaskIdMigrationEvent",
    "zcodeTaskIndexRekeyDelta",
    // 上游原有测试不参加 Fork 精简，仍由两级门禁执行。
    "importedClaudeRecovery",
    "nonCliAcpRetirement",
    "providerConfigMigration",
  ],
  shared: ["editorPrefill", "ompPaths", "taskIdMigration"],
  client: ["websocketDisconnect"],
  server: ["remoteConnectionStore"],
  ui: [
    "conversationRecoveryBudget",
    "ompAttachmentRejection",
    "ompComposerModelSync",
    "ompModelCatalog",
    "ompNativeCommandRouting",
    "ompPresentationIdentity",
    "ompQueuedInputRows",
    "ompVirtualWriteSummary",
    "ompWorkspaceConfigOptions",
    "nonCliAcpRetirement",
  ],
};

export async function fullPlan() {
  const stages = [
    ...staticPlan(true),
    node("gate-entry-selftest", ["scripts/test-gates.mjs", "--self-test"], { kind: "test" }),
    pnpm("formal-proof-typecheck", ["--filter", "@zcode/formal-proof", "typecheck"]),
  ].map((stage) => ({ ...stage, parallelGroup: "offline-core" }));
  for (const [name, files] of Object.entries(coreTests))
    stages.push(
      pnpm(
        `${name}-core-tests`,
        [
          "exec",
          "tsx",
          ...(name === "ui" ? ["--tsconfig", "packages/ui/tsconfig.json"] : []),
          "--test",
          "--test-concurrency=2",
          ...files.map((file) => `packages/${name}/test/${file}.test.ts`),
          ...(name === "ui"
            ? [
                "packages/ui/test/fallbackToolPresentation.test.tsx",
                "packages/ui/test/rpcUiElicitation.test.tsx",
                "packages/ui/test/toolContentPresentation.test.tsx",
              ]
            : []),
        ],
        { kind: "test", parallelGroup: "offline-core" },
      ),
    );
  stages.push(
    node("desktop-build-metadata", ["packages/desktop/scripts/build-metadata.mjs"]),
    node("adapter-build", ["packages/omp-agent/scripts/bundle.mjs"], {
      kind: "compile",
      // 修复依据：bundle 只调用 esbuild，不运行 OMP；安装门控仅属于真实核心/GUI。
      parallelGroup: "local-compiles",
    }),
    ...[
      ["desktop-main-host-preload-build", "@zcode/desktop", ["tsup"]],
      ["desktop-renderer-build", "@zcode/desktop", ["vite", "build", "--no-emptyOutDir"]],
      ["web-renderer-build", "@zcode/web", ["vite", "build", "--no-emptyOutDir"]],
      ["formal-proof-build", "@zcode/formal-proof", ["vite", "build", "--no-emptyOutDir"]],
      ["model-option-map-build", "@zcode/model-option-map", ["tsc"]],
      ["server-http-build", "@zcode/server", ["tsup"]],
      ["server-cli-build", "@zcode/server-cli", ["tsup"]],
    ].map(([id, name, args]) =>
      pnpm(id, ["--filter", name, "exec", ...args], {
        kind: "compile",
        parallelGroup: "local-compiles",
        env: { NODE_ENV: "production", ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
      }),
    ),
    pnpm("server-remote-build-validation", ["--filter", "@zcode/server", "build:remote"], {
      parallelGroup: "local-assets",
    }),
    node(
      "adapter-stage",
      [
        "--input-type=module",
        "--eval",
        "import { stageAgentBundle } from './packages/desktop/scripts/stage-omp-agent-bundle.mjs'; stageAgentBundle({ repoRoot: process.cwd(), platformKey: `${process.platform}-${process.arch}` });",
      ],
      { parallelGroup: "local-assets" },
    ),
    node("embedded-omp-assets", ["packages/desktop/scripts/fetch-omp-release.mjs"], {
      parallelGroup: "local-assets",
      env: { OMP_RELEASE_SKIP: "0", ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
    }),
    node("native-search-assets", ["scripts/prepare-native-search-tools.mjs"], {
      parallelGroup: "local-assets",
      env: { ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
    }),
    pnpm(
      "desktop-windows-unpacked-packaging",
      [
        "--filter",
        "@zcode/desktop",
        "exec",
        "electron-builder",
        "--config",
        "electron-builder.config.js",
        "--win",
        "--x64",
        "--dir",
        "--publish",
        "never",
      ],
      {
        packaging: true,
        env: { NODE_ENV: "production", ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
      },
    ),
    // 根因：Electron 缺失时 require 会下载并解压；并发 GUI 可覆盖正在启动的 exe，触发 EBUSY。
    // 由门禁先完成共享运行时准备，再并行启动消费者；下载计费，已有安装和缓存保持复用。
    node("electron-runtime-prepare", [
      "--input-type=module",
      "--eval",
      "import { createRequire } from 'node:module'; import { resolve } from 'node:path'; const require = createRequire(resolve('packages/desktop/package.json')); console.log(`Electron runtime prepared: ${require('electron')}`);",
    ]),
    // 构建和 staging 共享产物，先完成；之后真实 OMP、组件和 GUI 各自使用独立沙箱。
    pnpm(
      "real-omp.e2e.test.ts",
      ["exec", "tsx", "--test", "packages/omp-agent/test/real-omp.e2e.test.ts"],
      { kind: "test", realOmp: true, parallelGroup: "isolated-runtime" },
    ),
    node(
      "components-tool-content",
      ["packages/desktop/test/toolContentPresentation.components.e2e.mjs"],
      { kind: "test", electron: true, parallelGroup: "isolated-runtime" },
    ),
  );
  for (const [file, phases] of [
    ["ompStartup.gui.e2e.mjs", ["live"]],
    ["ompReviewedDefects.gui.e2e.mjs", ["live"]],
  ])
    for (const phase of phases)
      stages.push(
        node(`gui:${file}:${phase}`, [`packages/desktop/test/${file}`], {
          kind: "test",
          parallelGroup: "isolated-runtime",
          fixture: true,
          file,
          phase,
          realOmp: true,
        }),
      );
  // recovery 复用 identity live 的持久化根目录，必须跨过 live 和进程清理屏障。
  stages.push(
    node(
      "gui:ompReviewedDefects.gui.e2e.mjs:recovery",
      ["packages/desktop/test/ompReviewedDefects.gui.e2e.mjs"],
      {
        kind: "test",
        fixture: true,
        file: "ompReviewedDefects.gui.e2e.mjs",
        phase: "recovery",
        realOmp: true,
      },
    ),
  );
  return stages;
}

export async function slowPlan() {
  // 项目禁止 Linux/WSL；当前 Windows 本地覆盖与 full 完全一致，不重复执行 full。
  return await fullPlan();
}
