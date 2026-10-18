import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { exists, gitText } from "./test-gates-process.mjs";

const pnpm = (id, args, extra = {}) => ({ id, command: "pnpm", args, kind: "check", ...extra });
const node = (id, args, extra = {}) => ({ id, command: "node", args, kind: "check", ...extra });

const staticPlan = (all) => [
  pnpm("typecheck", ["typecheck", "--stopBuildOnErrors"], { kind: "compile" }),
  pnpm("lint", ["lint"]),
  pnpm("formal-proof-typecheck", ["--filter", "@zcode/formal-proof", "typecheck"], {
    kind: "compile",
  }),
  pnpm("formal-proof-lint", ["--filter", "@zcode/formal-proof", "lint"]),
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
    "agentInterventionProjection",
    "coldStoreProjection",
    "conversationRecovery",
    "frameAssembler",
    "mockModel",
    "mockServer",
    "ompAskAnswers",
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
    "topicFlowControl",
    "topicWireBudget",
    "v4InteractionAck",
  ],
  services: [
    "offlineDataBackup",
    "settingDataDirectoryInfo",
    "ompTaskIdMigration",
    "zcodeProtocolClientRejectionTiming",
    "zcodeTaskIdMigrationEvent",
    "zcodeTaskIndexRekeyDelta",
    // 上游原有测试不参加 Fork 精简，仍由两级门禁执行。
    "importedClaudeRecovery",
    "nonCliAcpRetirement",
    "providerConfigMigration",
    "serviceLoggerRuntime",
    "ompDiagnosticLog",
    "workspaceFileIndex",
  ],
  shared: ["editorPrefill", "ompPaths", "offlineDataRoots", "taskIdMigration", "feedbackPrivacy"],
  client: ["websocketDisconnect"],
  server: ["remoteConnectionStore"],
  web: ["oauthRedirect"],
  ui: [
    "composerProfileStorage",
    "conversationRecoveryBudget",
    "ompAskPresentation",
    "ompAttachmentRejection",
    "ompComposerModelSync",
    "ompInteractionContentSummary",
    "ompModelCatalog",
    "ompNativeCommandRouting",
    "ompNativeDraftAttachments",
    "ompProjectIndexCommands",
    "ompOrchestrationCommands",
    "ompPresentationIdentity",
    "ompQueuedInputRows",
    "ompVirtualWriteSummary",
    "ompWorkspaceConfigOptions",
    "nonCliAcpRetirement",
  ],
};

export async function fullPlan() {
  // 无失败率统计时按风险层次排序；静态错误先阻止昂贵的真实核、GUI 和分发准备。
  const stages = [
    ...staticPlan(true).map((stage) => ({ ...stage, parallelGroup: "static" })),
    node("gate-entry-selftest", ["scripts/test-gates.mjs", "--self-test"], {
      kind: "test",
      parallelGroup: "offline-core",
    }),
    node("license-graph-tests", ["--test", "scripts/third-party-npm.test.mjs"], {
      kind: "test",
      parallelGroup: "offline-core",
    }),
    pnpm(
      "offline-desktop-core-tests",
      ["exec", "tsx", "--test", "packages/desktop/test/offlineDesktop.test.ts"],
      { kind: "test", parallelGroup: "offline-core" },
    ),
  ];
  for (const [name, files] of Object.entries(coreTests))
    stages.push(
      pnpm(
        `${name}-core-tests`,
        [
          "exec",
          "tsx",
          ...(name === "ui" ? ["--tsconfig", "packages/ui/tsconfig.json"] : []),
          "--test",
          "--test-reporter=tap",
          "--test-concurrency=2",
          ...files.map((file) => `packages/${name}/test/${file}.test.ts`),
          ...(name === "ui"
            ? [
                "packages/ui/test/fallbackToolPresentation.test.tsx",
                "packages/ui/test/rpcUiElicitation.test.tsx",
                "packages/ui/test/toolContentPresentation.test.tsx",
                "packages/ui/test/dataDirectoryInfo.test.tsx",
              ]
            : []),
        ],
        { kind: "test", parallelGroup: "offline-core" },
      ),
    );
  stages.push(
    node("adapter-build", ["packages/omp-agent/scripts/bundle.mjs"], {
      kind: "compile",
      // 修复依据：bundle 只调用 esbuild，不运行 OMP；安装门控仅属于真实核心/GUI。
      parallelGroup: "adapter-compile",
    }),
    node(
      "adapter-stage",
      [
        "--input-type=module",
        "--eval",
        "import { stageAgentBundle } from './packages/desktop/scripts/stage-omp-agent-bundle.mjs'; stageAgentBundle({ repoRoot: process.cwd(), platformKey: `${process.platform}-${process.arch}` });",
      ],
      { parallelGroup: "adapter-staging" },
    ),
    // 真实核优先暴露协议/会话错误，只等待 adapter 构建和 staging，不等待 GUI 或打包。
    pnpm(
      "adapter.e2e.test.ts",
      [
        "exec",
        "tsx",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=2",
        "packages/omp-agent/test/adapter.e2e.test.ts",
        "packages/omp-agent/test/adapterRuntime.e2e.test.ts",
        "packages/omp-agent/test/nativeControl.e2e.test.ts",
      ],
      { kind: "test", realOmp: true, parallelGroup: "real-omp" },
    ),
    pnpm(
      "real-omp.e2e.test.ts",
      [
        "exec",
        "tsx",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=2",
        "packages/omp-agent/test/real-omp.e2e.test.ts",
        "packages/omp-agent/test/realOmpNativeCache.test.ts",
        "packages/omp-agent/test/conversationEngineStatus.test.ts",
        "packages/omp-agent/test/ompCommandOutputHistory.test.ts",
        "packages/omp-agent/test/ompLocalAttachmentInput.test.ts",
        "packages/services/test/ompConcurrentStartup.test.ts",
      ],
      { kind: "test", realOmp: true, parallelGroup: "real-omp" },
    ),
    pnpm(
      "real-omp-registry-tests",
      [
        "exec",
        "tsx",
        "--test",
        "--test-reporter=tap",
        "--test-concurrency=2",
        "packages/omp-agent/test/nativeCommandFirstIdentity.test.ts",
        "packages/omp-agent/test/sessionLifecycleGates.test.ts",
        "packages/omp-agent/test/sessionRegistry.identity.test.ts",
        "packages/omp-agent/test/sessionRegistryAliases.test.ts",
        "packages/omp-agent/test/sessionRegistryConcurrency.test.ts",
      ],
      { kind: "test", realOmp: true, parallelGroup: "real-omp" },
    ),
    node("desktop-build-metadata", ["packages/desktop/scripts/build-metadata.mjs"]),
    ...[
      ["desktop-main-host-preload-build", "@zcode/desktop", ["tsup"]],
      ["desktop-renderer-build", "@zcode/desktop", ["vite", "build", "--no-emptyOutDir"]],
    ].map(([id, name, args]) =>
      pnpm(id, ["--filter", name, "exec", ...args], {
        kind: "compile",
        parallelGroup: "local-compiles",
        env: { NODE_ENV: "production", ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
      }),
    ),
    // 根因：Electron 缺失时 require 会下载并解压；并发 GUI 可覆盖正在启动的 exe，触发 EBUSY。
    // 由门禁先完成共享运行时准备，再并行启动消费者；下载计费，已有安装和缓存保持复用。
    node("electron-runtime-prepare", [
      "--input-type=module",
      "--eval",
      "import { createRequire } from 'node:module'; import { resolve } from 'node:path'; const require = createRequire(resolve('packages/desktop/package.json')); console.log(`Electron runtime prepared: ${require('electron')}`);",
    ]),
    node(
      "components-tool-content",
      ["packages/desktop/test/toolContentPresentation.components.e2e.mjs"],
      { kind: "test", electron: true, parallelGroup: "isolated-runtime" },
    ),
    node(
      "components-omp-product-tools",
      ["packages/desktop/test/ompProductTools.components.e2e.mjs"],
      { kind: "test", electron: true, parallelGroup: "isolated-runtime" },
    ),
    node(
      "offline-desktop-windows-smoke",
      ["packages/desktop/test/offlineDesktop.windows-smoke.mjs"],
      { kind: "test", electron: true, parallelGroup: "isolated-runtime" },
    ),
  );
  const guiSuites = [
    { file: "ompStartup.gui.e2e.mjs", suite: "startup", phases: ["live"] },
    { file: "ompReviewedDefects.gui.e2e.mjs", suite: "identity", phases: ["live", "recovery"] },
    {
      file: "ompConversationAcceptance.gui.e2e.mjs",
      suite: "conversation",
      phases: ["live", "recovery"],
    },
    {
      file: "ompModelsAcceptance.gui.e2e.mjs",
      suite: "models",
      phases: ["live", "profile", "default"],
    },
    { file: "ompAgentsAcceptance.gui.e2e.mjs", suite: "agents", phases: ["live", "recovery"] },
    { file: "ompNativeAcceptance.gui.e2e.mjs", suite: "native", phases: ["live", "recovery"] },
    {
      file: "ompInteractionsAcceptance.gui.e2e.mjs",
      suite: "interactions",
      phases: ["live", "recovery"],
    },
  ];
  // 同一 suite 的后续阶段跨过进程退出屏障；不同根的 live/恢复仍有界并行。
  for (let phaseIndex = 0; phaseIndex < 3; phaseIndex++)
    for (const { file, suite, phases } of guiSuites) {
      const phase = phases[phaseIndex];
      if (!phase) continue;
      stages.push(
        node(`gui:${file}:${phase}`, [`packages/desktop/test/${file}`], {
          kind: "test",
          parallelGroup: phaseIndex === 0 ? "isolated-runtime" : `gui-recovery-${phaseIndex}`,
          fixture: true,
          file,
          suite,
          phase,
          realOmp: true,
        }),
      );
    }
  stages.push(
    ...[
      ["web-renderer-build", "@zcode/web", ["vite", "build", "--no-emptyOutDir"]],
      ["formal-proof-build", "@zcode/formal-proof", ["vite", "build", "--no-emptyOutDir"]],
      ["model-option-map-build", "@zcode/model-option-map", ["tsc"]],
      ["server-http-build", "@zcode/server", ["tsup"]],
      ["server-cli-build", "@zcode/server-cli", ["tsup"]],
    ].map(([id, name, args]) =>
      pnpm(id, ["--filter", name, "exec", ...args], {
        kind: "compile",
        parallelGroup: "distribution-compiles",
        env: { NODE_ENV: "production", ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" },
      }),
    ),
    pnpm("server-remote-build-validation", ["--filter", "@zcode/server", "build:remote"], {
      parallelGroup: "local-assets",
    }),
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
  );
  return stages;
}

export async function slowPlan() {
  // 项目禁止 Linux/WSL；当前 Windows 本地覆盖与 full 完全一致，不重复执行 full。
  return await fullPlan();
}
