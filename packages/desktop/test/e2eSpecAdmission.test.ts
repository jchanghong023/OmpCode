import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigParser, FileSystemPathService } from "@wdio/config/node";
import { resolve } from "node:path";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";

import {
  FORK_DEFERRED_E2E_SPECS,
  FORK_TEMPORARY_E2E_EXCLUDES,
  hasRequiredSshE2EEnvironment,
  isTemporarilyExcludedFormalSpec,
  MANUAL_REVIEW_SPEC_GLOB,
  resolveDeferredFormalSpecExcludes,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

// 修复原因：回归必须经过真实 WDIO 配置和 CLI 合并；仅隔离报告落盘，不替换选择策略。
vi.mock("./e2e/reporting/e2e-reporting.js", () => ({
  createE2EReporter: vi.fn(() => ({})),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function scheduleThroughWdioCli(spec?: string) {
  vi.resetModules();
  vi.stubEnv("ZCODE_E2E_RUN_ID", "spec-admission-regression");
  vi.stubEnv("ZCODE_E2E_PACKAGED_APP_PATH", process.execPath);
  vi.stubEnv("ZCODE_E2E_SPEC", "");
  // CLI 路径相对调用者 cwd 解析；使用 desktop 的绝对路径，避免把不存在的根目录文件当成排除成功。
  const cli = {
    ...(spec ? { spec: [resolve("packages/desktop", spec).replaceAll("\\", "/")] } : {}),
    exclude: [resolve("packages/desktop/test/e2e/smoke.test.ts").replaceAll("\\", "/")],
  };
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  process.argv = [
    process.execPath,
    "wdio",
    "run",
    "wdio.conf.ts",
    ...(cli.spec?.length ? ["--spec", cli.spec[0]!] : []),
    "--exclude",
    cli.exclude[0]!,
  ];
  try {
    // 配置在模块加载时读取 argv/env；仅让 WDIO 文件加载器交给 Vitest 处理 TS，配置本身不替换。
    const paths = new FileSystemPathService();
    vi.spyOn(paths, "loadFile").mockImplementation(() => import("../wdio.conf"));
    const parser = new ConfigParser(resolve("packages/desktop/wdio.conf.ts"), cli, paths);
    await parser.initialize(cli);
    const configuredCapabilities = parser.getCapabilities();
    const capabilities = Array.isArray(configuredCapabilities)
      ? configuredCapabilities
      : Object.values(configuredCapabilities ?? {});
    return capabilities
      .flatMap((capability) =>
        parser.getSpecs(capability["wdio:specs"], capability["wdio:exclude"]).flat(),
      )
      .map((path) => path.replaceAll("\\", "/"));
  } finally {
    process.argv = originalArgv;
    process.env = originalEnv;
  }
}

const deferredSpecs = [
  ...[
    "background",
    "goal-run-cases",
    "guarded",
    "tool-cross-product",
    "bash-direct-output",
    "compact-auto",
    "anthropic-reasoning-history-replay",
    "model-provider-restart-recovery",
    "model-provider-turbo-switch",
    "model-provider-turbo-recovery",
    "model-provider-settings-transition",
    "bot-continuous-worker",
    "bot-channel-worker",
    "bot-topic-worker",
    "configurable-data-directory",
  ].map((name) => `./test/e2e/conversation-session/conversation-session-${name}.test.ts`),
  "./test/e2e/bots/feishu-channel-mention.test.ts",
  "./test/e2e/bots/feishu-streaming-card-lifecycle.test.ts",
  "./test/e2e/bots/feishu-provider-interactions.test.ts",
  "./test/e2e/automations-create-manage.test.ts",
  "./test/e2e/automations-custom-monthly-interval.test.ts",
  "./test/e2e/automations-custom-yearly-schedule.test.ts",
  "./test/e2e/off-peak-create-manage.test.ts",
];

describe("desktop E2E environment-gated formal spec admission", () => {
  it("includes all restored and native OMP cases in the real WDIO default selection", async () => {
    vi.stubEnv("ZCODE_AGENT_SERVER_COMMAND", process.execPath);
    const scheduled = await scheduleThroughWdioCli();
    for (const spec of [
      "omp-app-server.e2e.ts",
      "omp-subagents.e2e.ts",
      "omp-workflows.e2e.ts",
      "omp-permissions.e2e.ts",
      "omp-management.e2e.ts",
      "omp-team.e2e.ts",
      "omp-indexes.e2e.ts",
      "omp-profiles.e2e.ts",
      "conversation-session/conversation-session-model-switch-restore-repro.test.ts",
      "conversation-session/conversation-session-v4-mention.test.ts",
    ]) {
      expect(scheduled.some((file) => file.endsWith(`/test/e2e/${spec}`))).toBe(true);
    }
  });

  it.each([
    "conversation-session/conversation-session-model-switch-restore-repro.test.ts",
    "conversation-session/conversation-session-v4-mention.test.ts",
    "omp-permissions.e2e.ts",
    "omp-management.e2e.ts",
    "omp-team.e2e.ts",
    "omp-indexes.e2e.ts",
    "omp-profiles.e2e.ts",
  ])("admits exact restored/native --spec %s through WDIO", async (spec) => {
    vi.stubEnv("ZCODE_AGENT_SERVER_COMMAND", process.execPath);
    const scheduled = await scheduleThroughWdioCli(`./test/e2e/${spec}`);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatch(new RegExp(`/test/e2e/${spec.replaceAll(".", "\\.")}$`, "u"));
  });

  it("keeps a hard-excluded CLI spec excluded after an unrelated CLI exclude replaces config excludes", async () => {
    const scheduled = await scheduleThroughWdioCli("./test/e2e/browser-tab-residency.test.ts");
    expect(scheduled).toEqual([]);
  });

  it("keeps deferred specs excluded after a broad CLI spec and unrelated CLI exclude", async () => {
    const scheduled = await scheduleThroughWdioCli("./test/e2e/**/*.test.ts");
    expect(scheduled.some((spec) => spec.endsWith("/smoke.test.ts"))).toBe(false);
    for (const spec of [...FORK_TEMPORARY_E2E_EXCLUDES, ...FORK_DEFERRED_E2E_SPECS]) {
      const excluded = resolveE2EScheduledSpecFiles({
        baseDir: resolve("packages/desktop"),
        specs: [spec],
        exclude: [],
      });
      for (const candidate of excluded) {
        expect(scheduled.some((file) => file.endsWith(`/${candidate}`))).toBe(false);
      }
    }
  });

  it("excludes every manual-review domain from the default recursive glob", () => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(scheduled).toContain("test/e2e/smoke.test.ts");
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
  });

  it.each(["bots", "settings", "feedback"])(
    "keeps explicit %s candidates discoverable",
    (domain) => {
      const scheduled = resolveE2EScheduledSpecFiles({
        baseDir: resolve("packages/desktop"),
        specs: [`./test/e2e/${domain}/manual-review/**/*.test.ts`],
        exclude: [],
      });
      expect(scheduled.length).toBeGreaterThan(0);
      expect(scheduled.every((spec) => spec.includes(`/${domain}/manual-review/`))).toBe(true);
    },
  );

  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts",
    );
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toEqual([]);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });

  it("applies temporary exclusions to recursive discovery while retaining protocol scenarios", () => {
    const baseDir = resolve("packages/desktop");
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir,
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [
        MANUAL_REVIEW_SPEC_GLOB,
        ...FORK_TEMPORARY_E2E_EXCLUDES,
        ...resolveDeferredFormalSpecExcludes({ requestedSpecs: [] }),
        ...resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
      ],
    });
    const excludedCandidates = resolveE2EScheduledSpecFiles({
      baseDir,
      specs: FORK_TEMPORARY_E2E_EXCLUDES,
      exclude: [],
    });
    expect(scheduled.filter((spec) => excludedCandidates.includes(spec))).toEqual([]);
    for (const spec of ["bots/bot-runtime-authority.test.ts"]) {
      expect(scheduled).toContain(`test/e2e/${spec}`);
    }
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
    expect(scheduled.some((spec) => spec.includes("conversation-session-ssh-remote"))).toBe(false);
  });

  it.each([
    "./test/e2e/**/*.test.ts",
    "./test/e2e/conversation-session/*.test.ts",
    "./test/e2e/**/*.test.ts".replaceAll("/", "\\"),
  ])("defers heavy, provider, Bot and automation specs under broad request %s", (pattern) => {
    const baseDir = resolve("packages/desktop");
    const candidates = resolveE2EScheduledSpecFiles({
      baseDir,
      specs: [pattern.replaceAll("\\", "/")],
      exclude: [],
    });
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir,
      specs: [pattern.replaceAll("\\", "/")],
      exclude: resolveDeferredFormalSpecExcludes({ requestedSpecs: [pattern] }),
    });
    const expectedDeferredSpecs = pattern.includes("conversation-session")
      ? deferredSpecs.filter((spec) => spec.includes("/conversation-session/"))
      : deferredSpecs;
    for (const spec of expectedDeferredSpecs) {
      expect(candidates).toContain(spec.slice(2));
      expect(scheduled).not.toContain(spec.slice(2));
    }
  });

  it.each(deferredSpecs)(
    "admits only the exact deferred target %s, including Windows requests",
    (target) => {
      for (const request of [
        target,
        target.replaceAll("/", "\\"),
        resolve("packages/desktop", target),
        `C:\\repo\\packages\\desktop\\${target.slice(2).replaceAll("/", "\\")}`,
      ]) {
        const scheduled = resolveE2EScheduledSpecFiles({
          baseDir: resolve("packages/desktop"),
          specs: ["./test/e2e/**/*.test.ts"],
          exclude: [
            ...FORK_TEMPORARY_E2E_EXCLUDES,
            ...resolveDeferredFormalSpecExcludes({ requestedSpecs: [request] }),
          ],
        });
        expect(scheduled.filter((spec) => FORK_DEFERRED_E2E_SPECS.includes(`./${spec}`))).toEqual([
          target.slice(2),
        ]);
      }
    },
  );

  it.each([
    "./test/e2e/conversation-session/conversation-session-background.test.ts.extra",
    "./test/e2e/conversation-session/conversation-session-background-followup.test.ts",
    "./test/e2e/other/conversation-session-background.test.ts",
    "conversation-session-background.test.ts",
    "./test/e2e/conversation-session/conversation-session-background*.test.ts",
  ])("does not unblock deferred specs for prefix or similar-basename request %s", (request) => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: resolveDeferredFormalSpecExcludes({ requestedSpecs: [request] }),
    });
    for (const spec of deferredSpecs) {
      expect(scheduled).not.toContain(spec.slice(2));
    }
  });

  it.each([
    "browser-tab-residency.test.ts",
    "settings/coding-plan-entitlement-presentation.test.ts",
    "ui-shell/marketing-touch-delivery.test.ts",
    "workspace-file-tree/workspace-file-tree-shared-search.test.ts",
    "workspace-agent-warmup-lifecycle.test.ts",
    "resource-manager-storage.test.ts",
    "infrastructure/session-lifecycle.test.ts",
    "settings/settings-subagent-create-edit-persistence.test.ts",
    ...[
      "assistant-preview-cards",
      "hooks-lifecycle",
      "v4-composer-toolbar",
      "ask-user-question-keyboard-default-focus",
      "side-chat-reminder",
      "plugin-reference",
      "v4-plan-shortcut",
      "v4-attachment",
      "v4-attachment-layout",
      "v4-load-older",
      "v4-input-control",
      "v4-scroll",
      "v4-turn-navigator",
      "native-search-setting",
      "plan-approval-primary-submit",
      "markdown-table-layout",
      "markdown-preview-selection",
      "v4-video-preview",
      "markdown-table-enhanced-scroll",
      "task-title-marquee",
      "highspeed-card",
      "highspeed-card-draw-miss",
      "tool-detail-toggle-stability",
      "terminal-expanded-details-and-status",
      "composer-compression",
      "mention-selection",
      "pasted-image-path-edge-cases",
      "model-trajectory-viewer",
      "model-switch-image-strip",
      "composer-provider-identity",
      "toolsearch-local",
      "toolsearch-cli",
      "toolsearch-lifecycle",
      "toolsearch-compact",
      "toolsearch-recording",
      "toolsearch-settings",
    ].map((name) => `conversation-session/conversation-session-${name}.test.ts`),
  ])("rejects explicit temporarily excluded spec %s, including Windows paths", (spec) => {
    const path = `./test/e2e/${spec}`;
    const baseDir = resolve("packages/desktop");
    expect(resolveE2EScheduledSpecFiles({ baseDir, specs: [path], exclude: [] })).toEqual([
      `test/e2e/${spec}`,
    ]);
    for (const request of [path, resolve(baseDir, path)]) {
      expect(
        resolveE2EScheduledSpecFiles({
          baseDir,
          specs: [request],
          exclude: [
            ...FORK_TEMPORARY_E2E_EXCLUDES,
            ...resolveDeferredFormalSpecExcludes({ requestedSpecs: [request] }),
          ],
        }),
      ).toEqual([]);
    }
    expect(isTemporarilyExcludedFormalSpec(path)).toBe(true);
    expect(isTemporarilyExcludedFormalSpec(path.replaceAll("/", "\\"))).toBe(true);
    expect(
      isTemporarilyExcludedFormalSpec(
        `C:\\repo\\packages\\desktop\\test\\e2e\\${spec.replaceAll("/", "\\")}`,
      ),
    ).toBe(true);
  });

  it("does not broaden temporary exclusions into OMP app-server or adjacent protocol paths", () => {
    for (const spec of [
      "omp-app-server.e2e.ts",
      "conversation-session/conversation-session-bot-continuous-worker.test.ts",
      "conversation-session/conversation-session-compact-auto.test.ts",
      "conversation-session/conversation-session-send-message-resume-stop.test.ts",
      "off-peak-create-manage.test.ts",
      "conversation-session/conversation-session-toolsearch.test.ts",
      "bots/bot-runtime-authority.test.ts",
      "browser-tab-residency-followup.test.ts",
    ]) {
      expect(isTemporarilyExcludedFormalSpec(`./test/e2e/${spec}`)).toBe(false);
      expect(
        isTemporarilyExcludedFormalSpec(
          `C:\\repo\\packages\\desktop\\test\\e2e\\${spec.replaceAll("/", "\\")}`,
        ),
      ).toBe(false);
    }
  });
});
