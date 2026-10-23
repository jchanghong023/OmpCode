import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createWindowsE2EShardPlan,
  executeWindowsE2EShardPlan,
  listDefaultFormalE2ESpecs,
  partitionE2ESpecsByWeight,
  resolveWindowsE2EShardTotal,
} from "../scripts/run-windows-e2e-shards.mjs";
import {
  FORK_DEFERRED_E2E_SPECS,
  FORK_TEMPORARY_E2E_EXCLUDES,
  isTemporarilyExcludedFormalSpec,
  resolveDeferredFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";
import { spawnCancellableStep } from "../scripts/e2e-step-process.mjs";

const repoRoot = resolve("C:/repo");
const desktopDir = join(repoRoot, "packages/desktop");

function createPlan(overrides: Record<string, unknown> = {}) {
  return createWindowsE2EShardPlan({
    args: [],
    desktopDir,
    env: { ZCODE_E2E_RUN_ID: "local-full", ZCODE_E2E_SHARD_TOTAL: "2" },
    platform: "win32",
    repoRoot,
    ...overrides,
  });
}

describe("Windows E2E shard runner", () => {
  it("derives disjoint paths from automatic run IDs while preserving an explicit run ID", () => {
    const timestamp = new Date("2026-07-11T00:30:00.123Z");
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);

    try {
      const firstPlan = createPlan({
        // 修复原因：默认 full run 已改为单 shard；路径隔离断言必须显式进入并发分片场景。
        env: { ZCODE_E2E_SHARD_TOTAL: "2" },
        processId: 4242,
        runIdEntropy: "entropy-a",
        runIdTimestamp: timestamp,
      });
      const secondPlan = createPlan({
        env: { ZCODE_E2E_SHARD_TOTAL: "2" },
        processId: 4242,
        runIdEntropy: "entropy-b",
        runIdTimestamp: timestamp,
      });

      expect(firstPlan.runId).not.toBe(secondPlan.runId);
      for (const key of [
        "ZCODE_E2E_HOME_DIR",
        "ZCODE_E2E_ARTIFACT_DIR",
        "ZCODE_E2E_NETWORK_CAPTURE_DIR",
      ] as const) {
        const firstPaths = new Set(firstPlan.children.map((child) => child.env[key]));
        const secondPaths = new Set(secondPlan.children.map((child) => child.env[key]));
        expect([...firstPaths].filter((path) => secondPaths.has(path))).toEqual([]);
      }

      const explicitPlan = createPlan({
        env: { ZCODE_E2E_RUN_ID: "explicit-compatible-run" },
        processId: 4242,
        runIdEntropy: "ignored-entropy",
        runIdTimestamp: timestamp,
      });
      expect(explicitPlan.runId).toBe("explicit-compatible-run");
    } finally {
      vi.useRealTimers();
    }
  });

  it("plans a default full Windows run as a single shard", () => {
    const plan = createPlan({
      env: { ZCODE_E2E_RUN_ID: "default-single" },
    });
    expect(plan.shardTotal).toBe(1);
    expect(plan.children).toHaveLength(1);
    expect(plan.children[0]?.args.some((arg) => arg.startsWith("--shard"))).toBe(false);
    expect(plan.children[0]?.env.ZCODE_E2E_HOME_DIR).toBe(
      join(desktopDir, ".e2e-home-default-single"),
    );
  });

  it("lists the default formal specs without manual-review or live provider cases", () => {
    const specs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"));

    // Bug 根因：formal case 由目录动态发现，固定总数会让新增或删除合法 case 误伤 pre-push。
    // 用稳定的 smoke 包含关系确认发现结果非空，其余断言只校验默认集合的语义边界。
    expect(specs).toContain("./test/e2e/smoke.test.ts");
    expect(specs).not.toContain("./test/e2e/upstream-provider.test.ts");
    expect(specs.some((spec) => spec.includes("/manual-review/"))).toBe(false);
    expect(specs.some((spec) => spec.includes("conversation-session-ssh-remote"))).toBe(false);
    expect(specs.filter(isTemporarilyExcludedFormalSpec)).toEqual([]);
    expect(specs).not.toContain("./test/e2e/browser-tab-residency.test.ts");
    expect(specs).not.toContain("./test/e2e/container-boot.test.ts");
    expect(specs).not.toContain("./test/e2e/infrastructure/session-lifecycle.test.ts");
    const deferredCandidates = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: FORK_DEFERRED_E2E_SPECS,
      exclude: [],
    });
    for (const spec of FORK_DEFERRED_E2E_SPECS) {
      expect(deferredCandidates).toContain(spec.slice(2));
      expect(specs).not.toContain(spec);
    }
    const ompSpecs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"), {
      ZCODE_AGENT_SERVER_COMMAND: "omp app-server",
    });
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
      expect(ompSpecs).toContain(`./test/e2e/${spec}`);
    }
    expect(ompSpecs.filter(isTemporarilyExcludedFormalSpec)).toEqual([]);

    const sshSpecs = listDefaultFormalE2ESpecs(resolve(process.cwd(), "packages/desktop"), {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    });
    expect(sshSpecs).toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote-connection-p0.test.ts",
    );
  });

  it.each(
    [
      "./test/e2e/conversation-session/conversation-session-compact-auto.test.ts",
      "./test/e2e/conversation-session/conversation-session-bot-continuous-worker.test.ts",
      "./test/e2e/bots/feishu-provider-interactions.test.ts",
      "./test/e2e/automations-create-manage.test.ts",
      "./test/e2e/off-peak-create-manage.test.ts",
    ].flatMap((target) =>
      ["CLI separate", "CLI equals", "environment", "Windows environment"].map((source) => ({
        target,
        source,
      })),
    ),
  )(
    "forwards exact deferred $source request $target without admitting other deferred specs",
    ({ source, target }) => {
      const request =
        source === "Windows environment"
          ? `C:\\repo\\packages\\desktop\\${target.slice(2).replaceAll("/", "\\")}`
          : target;
      const args =
        source === "CLI separate"
          ? ["--spec", request]
          : source === "CLI equals"
            ? [`--spec=${request}`]
            : [];
      const plan = createPlan({
        args,
        env: {
          ZCODE_E2E_SHARD_TOTAL: "4",
          ...(source.endsWith("environment") ? { ZCODE_E2E_SPEC: request } : {}),
        },
      });
      expect(plan.shardTotal).toBe(1);
      const child = plan.children[0]!;
      let forwardedRequest: string;
      if (source.endsWith("environment")) {
        expect(child.env.ZCODE_E2E_SPEC).toBe(request);
        forwardedRequest = child.env.ZCODE_E2E_SPEC!;
      } else if (source === "CLI separate") {
        const specIndex = child.args.indexOf("--spec");
        expect(specIndex).toBeGreaterThanOrEqual(0);
        forwardedRequest = child.args[specIndex + 1]!;
        expect(forwardedRequest).toBe(request);
      } else {
        expect(child.args).toContain(`--spec=${request}`);
        forwardedRequest = child.args.find((arg) => arg.startsWith("--spec="))!.slice(7);
      }
      const scheduled = resolveE2EScheduledSpecFiles({
        baseDir: resolve("packages/desktop"),
        specs: ["./test/e2e/**/*.test.ts"],
        exclude: [
          ...FORK_TEMPORARY_E2E_EXCLUDES,
          ...resolveDeferredFormalSpecExcludes({ requestedSpecs: [forwardedRequest] }),
        ],
      });
      expect(scheduled.filter((spec) => FORK_DEFERRED_E2E_SPECS.includes(`./${spec}`))).toEqual([
        target.slice(2),
      ]);
    },
  );

  it("uses deterministic LPT weights and a fallback for new specs", () => {
    const buckets = partitionE2ESpecsByWeight(
      ["./a.test.ts", "./b.test.ts", "./c.test.ts", "./new.test.ts"],
      2,
      {
        defaultWeightMs: 40,
        weights: {
          "./a.test.ts": 100,
          "./b.test.ts": 80,
          "./c.test.ts": 20,
        },
      },
    );

    expect(buckets).toEqual([
      { estimatedWeightMs: 120, specs: ["./a.test.ts", "./c.test.ts"] },
      { estimatedWeightMs: 120, specs: ["./b.test.ts", "./new.test.ts"] },
    ]);
  });

  it("passes weighted spec groups explicitly instead of native contiguous shards", () => {
    const weightedSpecBuckets = [
      { estimatedWeightMs: 100, specs: ["./test/e2e/smoke.test.ts"] },
      {
        estimatedWeightMs: 90,
        specs: ["./test/e2e/conversation-session/conversation-session-compact-auto.test.ts"],
      },
    ];
    const plan = createPlan({ weightedSpecBuckets });

    expect(plan.distributionKind).toBe("historical-lpt");
    expect(plan.children.map((child) => child.env.ZCODE_E2E_SPEC)).toEqual([
      "./test/e2e/smoke.test.ts",
      "./test/e2e/conversation-session/conversation-session-compact-auto.test.ts",
    ]);
    expect(
      plan.children.every((child) => child.args.every((arg) => !arg.startsWith("--shard"))),
    ).toBe(true);
  });

  it("plans two isolated shards for an explicit two-shard run", () => {
    const plan = createPlan();

    expect(plan.shardTotal).toBe(2);
    expect(plan.children).toHaveLength(2);
    expect(plan.children.map((child) => child.shardId)).toEqual(["1/2", "2/2"]);
    expect(plan.children.map((child) => child.args.at(-1))).toEqual(["--shard=1/2", "--shard=2/2"]);

    for (const key of [
      "ZCODE_E2E_HOME_DIR",
      "ZCODE_E2E_RUN_ID",
      "ZCODE_E2E_ARTIFACT_DIR",
      "ZCODE_E2E_NETWORK_CAPTURE_DIR",
    ] as const) {
      expect(new Set(plan.children.map((child) => child.env[key])).size).toBe(2);
    }

    for (const child of plan.children) {
      expect(child.env.ZCODE_E2E_SKIP_BUILD).toBe("1");
      expect(child.env.ZCODE_E2E_SKIP_AGENT_BUILD).toBe("1");
      expect(child.summaryPath).toBe(join(child.artifactDir, "summary.json"));
    }
  });

  it("keeps every default HOME disjoint across concurrent runner run IDs", () => {
    const firstPlan = createPlan({
      // 修复原因：覆盖 env 会同时移除 createPlan 默认的 shard 数，需保留显式分片前提。
      env: {
        ZCODE_E2E_RUN_ID: "concurrent-run-a",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });
    const secondPlan = createPlan({
      env: {
        ZCODE_E2E_RUN_ID: "concurrent-run-b",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });
    const firstHomes = new Set(firstPlan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR));
    const secondHomes = new Set(secondPlan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR));

    expect([...firstHomes].filter((home) => secondHomes.has(home))).toEqual([]);
    expect([...firstHomes].every((home) => home.includes("concurrent-run-a"))).toBe(true);
    expect([...secondHomes].every((home) => home.includes("concurrent-run-b"))).toBe(true);
  });

  it("preserves an explicit HOME for a single-child run", () => {
    const explicitHomeRoot = resolve("C:/e2e-homes/single");
    const plan = createPlan({
      env: {
        ZCODE_E2E_HOME_DIR: explicitHomeRoot,
        ZCODE_E2E_RUN_ID: "explicit-single-home-run",
      },
    });

    expect(plan.shardTotal).toBe(1);
    expect(plan.children[0]?.env.ZCODE_E2E_HOME_DIR).toBe(explicitHomeRoot);
  });

  it("adds run and shard identity below an explicit sharded HOME base", () => {
    const explicitHomeRoot = resolve("C:/e2e-homes");
    const plan = createPlan({
      env: {
        ZCODE_E2E_HOME_DIR: explicitHomeRoot,
        ZCODE_E2E_RUN_ID: "explicit-home-run",
        ZCODE_E2E_SHARD_TOTAL: "2",
      },
    });

    expect(plan.children.map((child) => child.env.ZCODE_E2E_HOME_DIR)).toEqual([
      join(explicitHomeRoot, "explicit-home-run", "shard-1-of-2"),
      join(explicitHomeRoot, "explicit-home-run", "shard-2-of-2"),
    ]);
  });

  it("builds desktop and agent once before starting both children concurrently", async () => {
    const plan = createPlan();
    expect(plan.buildSteps[1]?.env.ZCODE_DESKTOP_AGENT_BUILD_MODE).toBe("turbo");
    const events: string[] = [];
    const childResolvers: Array<(result: { exitCode: number }) => void> = [];

    const execution = executeWindowsE2EShardPlan(plan, {
      now: (() => {
        let value = 1_000;
        return () => (value += 50);
      })(),
      summaryExists: () => true,
      spawnStep: vi.fn(async (step) => {
        events.push(`start:${step.id}`);
        if (step.kind === "build") {
          events.push(`finish:${step.id}`);
          return { exitCode: 0 };
        }
        return await new Promise<{ exitCode: number }>((resolveChild) => {
          childResolvers.push(resolveChild);
        });
      }),
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });

    await vi.waitFor(() => expect(childResolvers).toHaveLength(2));
    expect(events).toEqual([
      "start:build-desktop",
      "finish:build-desktop",
      "start:build-agent",
      "finish:build-agent",
      "start:shard-1-of-2",
      "start:shard-2-of-2",
    ]);

    childResolvers[1]?.({ exitCode: 0 });
    childResolvers[0]?.({ exitCode: 0 });
    const manifest = await execution;
    expect(manifest.wallDurationMs).toBe(50);
    expect(manifest.children.map((child) => child.exitCode)).toEqual([0, 0]);
  });

  it.each([
    {
      label: "targeted CLI",
      args: ["--spec=./test/e2e/smoke.test.ts", "--shards=10"],
      env: { ZCODE_E2E_SHARD_TOTAL: "4" },
    },
    {
      label: "targeted env",
      args: ["--shards=10"],
      env: {
        ZCODE_E2E_SPEC: "./test/e2e/smoke.test.ts",
        ZCODE_E2E_SHARD_TOTAL: "4",
      },
    },
    {
      label: "capture",
      args: ["--shards=10"],
      env: { E2E_PROVIDER_HTTP_MODE: "capture", ZCODE_E2E_SHARD_TOTAL: "4" },
    },
    {
      label: "manual review",
      args: ["--shards=10"],
      env: { ZCODE_E2E_MANUAL_REVIEW: "1", ZCODE_E2E_SHARD_TOTAL: "4" },
    },
  ])("keeps $label runs single despite explicit shard overrides", ({ args, env }) => {
    const plan = createPlan({ args, env });
    expect(plan.shardTotal).toBe(1);
    expect(plan.children).toHaveLength(1);
  });

  it("keeps non-Windows runs single by default", () => {
    expect(resolveWindowsE2EShardTotal({ args: [], env: {}, platform: "darwin" })).toBe(1);
  });

  it("validates explicit overrides and strips the runner-only option", () => {
    const plan = createPlan({
      args: ["--logLevel=warn", "--shards=3", "--mochaOpts.timeout=9000"],
      env: { ZCODE_E2E_SHARD_TOTAL: "4", ZCODE_E2E_RUN_ID: "override" },
    });

    expect(plan.shardTotal).toBe(3);
    expect(plan.wdioArgs).toEqual(["--logLevel=warn", "--mochaOpts.timeout=9000"]);
    expect(plan.children.map((child) => child.args.at(-1))).toEqual([
      "--shard=1/3",
      "--shard=2/3",
      "--shard=3/3",
    ]);
    expect(() =>
      resolveWindowsE2EShardTotal({ args: ["--shards=0"], env: {}, platform: "win32" }),
    ).toThrow("positive integer");
    expect(() =>
      resolveWindowsE2EShardTotal({
        args: [],
        env: { ZCODE_E2E_SHARD_TOTAL: "two" },
        platform: "win32",
      }),
    ).toThrow("positive integer");
  });

  it("does not reshard a native WDIO shard from any override", () => {
    expect(
      resolveWindowsE2EShardTotal({
        args: ["--shard=1/2"],
        env: { ZCODE_E2E_SHARD_TOTAL: "4" },
        platform: "win32",
      }),
    ).toBe(1);
    expect(
      resolveWindowsE2EShardTotal({
        args: ["--shard=1/2", "--shards=3"],
        env: { ZCODE_E2E_SHARD_TOTAL: "4" },
        platform: "win32",
      }),
    ).toBe(1);
  });

  it("validates all successful summaries and writes one complete manifest", async () => {
    const plan = createPlan();
    const summaryExists = vi.fn((_path: string) => true);
    const writeManifest = vi.fn();
    const manifest = await executeWindowsE2EShardPlan(plan, {
      spawnStep: async () => ({ exitCode: 0 }),
      summaryExists,
      writeManifest,
      printManifest: vi.fn(),
    });
    expect(manifest.children.map((child) => child.exitCode)).toEqual([0, 0]);
    expect(manifest).not.toHaveProperty("firstFailure");
    expect(summaryExists.mock.calls).toEqual(plan.children.map((child) => [child.summaryPath]));
    expect(writeManifest).toHaveBeenCalledOnce();
  });

  it.each([
    ["nonzero exit", { exitCode: 7 }, true, "exited with code 7"],
    ["signal", { exitCode: 1, signal: "SIGABRT" }, true, "terminated by signal SIGABRT"],
    ["start rejection", new Error("spawn pnpm EAGAIN"), true, "spawn pnpm EAGAIN"],
    ["missing summary", { exitCode: 0 }, false, "missing shard summary"],
  ] as const)(
    "cancels a pending peer immediately after %s without retry",
    async (_, result, hasSummary, error) => {
      const plan = createPlan();
      const writeManifest = vi.fn();
      const printManifest = vi.fn();
      const peer = Promise.withResolvers<{ exitCode: number; signal?: string }>();
      const terminatePeer = vi.fn(() => peer.resolve({ exitCode: 1, signal: "SIGTERM" }));
      const spawnStep = vi.fn((step) => {
        if (step.kind === "build") return { exitCode: 0 };
        if (step.shardIndex === 1) {
          return result instanceof Error ? Promise.reject(result) : result;
        }
        return {
          result: peer.promise,
          terminate: terminatePeer,
        };
      });

      await expect(
        executeWindowsE2EShardPlan(plan, {
          spawnStep,
          summaryExists: () => hasSummary,
          writeManifest,
          printManifest,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(error),
        manifest: {
          firstFailure: { shardId: "1/2", error: expect.stringContaining(error) },
          children: [
            expect.objectContaining({
              exitCode: result instanceof Error ? 1 : result.exitCode || 1,
            }),
            expect.objectContaining({ cancelled: true, signal: "SIGTERM" }),
          ],
        },
      });
      expect(terminatePeer).toHaveBeenCalledOnce();
      expect(spawnStep.mock.calls.filter(([step]) => step.kind === "child")).toHaveLength(2);
      expect(writeManifest).toHaveBeenCalledOnce();
      expect(printManifest).toHaveBeenCalledOnce();
    },
  );

  it.each(["test", "hook", "runner", "prepare"])(
    "terminates the emitting child and peer on a live %s failure before either result settles",
    async (kind) => {
      const plan = createPlan();
      const steps: Array<{ onFailure: (payload: unknown) => void; env: Record<string, string> }> =
        [];
      const closes: Array<(result: { exitCode: number; signal?: string }) => void> = [];
      const terminates: Mock[] = [];
      const writeManifest = vi.fn();
      const execution = executeWindowsE2EShardPlan(plan, {
        spawnStep: (step) => {
          if (step.kind === "build") return { exitCode: 0 };
          steps.push(step);
          const terminate = vi.fn();
          terminates.push(terminate);
          const childClose = Promise.withResolvers<{ exitCode: number; signal?: string }>();
          closes.push(childClose.resolve);
          return {
            result: childClose.promise,
            terminate,
          };
        },
        summaryExists: vi.fn(() => false),
        writeManifest,
        printManifest: vi.fn(),
      });
      await vi.waitFor(() => expect(steps).toHaveLength(2));
      expect(steps[0]?.env.ZCODE_E2E_FAIL_FAST_PREFIX).toBe(
        steps[1]?.env.ZCODE_E2E_FAIL_FAST_PREFIX,
      );
      expect(steps[0]?.env.ZCODE_E2E_FAIL_FAST_PREFIX).toBeTruthy();
      steps[0]?.onFailure({
        kind,
        title: "original failing case",
        error: "original failure",
        cid: "0-0",
      });
      // 不释放 result，仍须同步取消；manifest 只等 close，不等完整 summary。
      expect(terminates.every((terminate) => terminate.mock.calls.length === 1)).toBe(true);
      expect(writeManifest).not.toHaveBeenCalled();
      steps[1]?.onFailure({
        kind: "runner",
        title: "cancelled worker",
        error: "secondary failure",
      });
      closes.forEach((close) => close({ exitCode: 1, signal: "SIGTERM" }));
      await expect(execution).rejects.toMatchObject({
        message: "original failing case original failure",
        manifest: {
          firstFailure: {
            kind,
            title: "original failing case",
            error: "original failure",
            cid: "0-0",
          },
          children: [
            expect.objectContaining({ cancelled: true, error: "original failure" }),
            expect.objectContaining({ cancelled: true }),
          ],
        },
      });
      expect(steps).toHaveLength(2);
    },
  );

  it("handles a synchronous failure during start and never schedules later children", async () => {
    const plan = createPlan();
    const terminate = vi.fn();
    const spawnStep = vi.fn((step) => {
      if (step.kind === "build") return { exitCode: 0 };
      step.onFailure({ kind: "prepare", title: "startup", error: "prepare failed" });
      return { result: Promise.resolve({ exitCode: 1 }), terminate };
    });
    await expect(
      executeWindowsE2EShardPlan(plan, {
        spawnStep,
        summaryExists: () => false,
        writeManifest: vi.fn(),
        printManifest: vi.fn(),
      }),
    ).rejects.toMatchObject({
      manifest: {
        firstFailure: { title: "startup", error: "prepare failed" },
        children: [
          expect.anything(),
          expect.objectContaining({ cancelled: true, error: "cancelled before start" }),
        ],
      },
    });
    expect(terminate).toHaveBeenCalledOnce();
    expect(spawnStep.mock.calls.filter(([step]) => step.kind === "child")).toHaveLength(1);
  });

  it("records build failure in a partial manifest without starting any child", async () => {
    const spawnStep = vi.fn(() => ({ exitCode: 2 }));
    await expect(
      executeWindowsE2EShardPlan(createPlan(), {
        spawnStep,
        summaryExists: () => false,
        writeManifest: vi.fn(),
        printManifest: vi.fn(),
      }),
    ).rejects.toMatchObject({
      manifest: {
        firstFailure: { kind: "prepare", error: "exited with code 2" },
        children: [
          expect.objectContaining({ cancelled: true }),
          expect.objectContaining({ cancelled: true }),
        ],
      },
    });
    expect(spawnStep).toHaveBeenCalledOnce();
  });

  it("gives each invocation a new failure prefix even with the same explicit run ID", async () => {
    const prefixes: string[] = [];
    for (let invocation = 0; invocation < 2; invocation += 1) {
      await executeWindowsE2EShardPlan(createPlan(), {
        spawnStep: (step) => {
          if (step.kind === "child") prefixes.push(step.env.ZCODE_E2E_FAIL_FAST_PREFIX);
          return { exitCode: 0 };
        },
        summaryExists: () => true,
        writeManifest: vi.fn(),
        printManifest: vi.fn(),
      });
    }
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(prefixes[2]).toBe(prefixes[3]);
    expect(prefixes[0]).not.toBe(prefixes[2]);
  });

  it.each(["direct", ...(process.platform === "win32" ? ["cmd"] : [])])(
    "passes literal regex and spaced paths to a real %s child",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "zcode argv transport "));
      const script = join(root, "argv child.cjs");
      const capture = join(root, "received argv.json");
      const args = [
        "--mochaOpts.grep",
        "^(?!.*全局组置顶;全局->项目搬文件).*",
        "--dir",
        "C:\\Z Code\\workspace\\",
        "^&|<>()*",
        "",
        "plain",
      ];
      try {
        writeFileSync(
          script,
          "require('node:fs').writeFileSync(process.env.ZCODE_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));",
        );
        // 用真实 cmd shim 复现 pnpm 的 shell:true 路径，不依赖安装的 pnpm 或 WDIO。
        writeFileSync(
          join(root, "argv-child.cmd"),
          '@echo off\r\n"%ZCODE_ARGV_NODE%" "%~dp0argv child.cjs" %*\r\n',
        );
        const execution = spawnCancellableStep({
          command: mode === "cmd" ? "argv-child.cmd" : process.execPath,
          args: mode === "cmd" ? args : [script, ...args],
          cwd: root,
          env: {
            ...process.env,
            ZCODE_ARGV_NODE: process.execPath,
            ZCODE_ARGV_CAPTURE: capture,
          },
        });
        try {
          await expect(execution.result).resolves.toMatchObject({ exitCode: 0 });
          expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(args);
        } finally {
          execution.terminate();
          await execution.result;
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("parses owned structured chunks live and terminates the emitting descendant tree", async () => {
    const prefix = "owned-failure:";
    const payload = { kind: "hook", title: "before hook 中文", error: "hook failed", cid: "0-0" };
    const onFailure = vi.fn(() => execution.terminate());
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const workerSource = `
      const bytes = Buffer.from(${JSON.stringify(prefix + JSON.stringify(payload) + "\n")});
      const split = bytes.indexOf(Buffer.from("中文")) + 1;
      process.stderr.write(bytes.subarray(0, split));
      setImmediate(() => process.stderr.write(bytes.subarray(split)));
      // Real process-tree integration: keep the descendant alive until group/taskkill cancellation.
      setInterval(() => {}, 1000);
    `;
    const execution = spawnCancellableStep({
      command: process.execPath,
      args: [
        "-e",
        `
        process.stdout.write('foreign-failure:{"kind":"test","title":"foreign","error":"ignore"}\\n');
        process.stdout.write('owned-failure:not-json\\n');
        process.stderr.write('owned-failure:{"kind":"unknown","title":"invalid","error":"ignore"}\\n');
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(workerSource)}], {
          stdio: ['ignore', 'inherit', 'inherit']
        });
      `,
      ],
      cwd: process.cwd(),
      env: { ...process.env, ZCODE_E2E_FAIL_FAST_PREFIX: prefix },
      onFailure,
    });
    try {
      await execution.result;
      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith(payload);
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "foreign-failure:",
      );
      expect(errorOutput.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
        "owned-failure:",
      );
    } finally {
      execution.terminate();
      await execution.result;
      output.mockRestore();
      errorOutput.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "reclaims a completed shard's reparented real runtime without killing a neighboring invocation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "zcode orphan closure "));
      const home = join(root, ".e2e-home-current");
      const otherHome = `${home}-other`;
      const worker = join(root, "worker.cjs");
      const wrapper = join(root, "wrapper.cjs");
      const ownedPidPath = join(root, "owned.pid");
      const unrelatedPidPath = join(root, "unrelated.pid");
      mkdirSync(home);
      mkdirSync(otherHome);
      writeFileSync(
        worker,
        `
        require('node:fs').writeFileSync(process.argv[2], String(process.pid));
        // 独立真实后代持续存活至 OS 回收；fake timer 无法覆盖跨进程退出。
        setInterval(() => {}, 1000);
      `,
      );
      writeFileSync(
        wrapper,
        `
        const child = require('node:child_process').spawn(process.execPath,
          [${JSON.stringify(worker)}, ${JSON.stringify(ownedPidPath)}, '--cwd', ${JSON.stringify(home)}],
          { detached: true, stdio: 'ignore', cwd: ${JSON.stringify(home)} });
        child.unref();
      `,
      );
      const unrelated = spawn(process.execPath, [worker, unrelatedPidPath, "--cwd", otherHome], {
        cwd: otherHome,
        stdio: "ignore",
      });
      const unrelatedExit = Promise.withResolvers<void>();
      unrelated.once("close", unrelatedExit.resolve);
      const plan = createPlan();
      plan.buildSteps = [];
      let completedShard:
        | { result: Promise<unknown>; terminate: () => void | Promise<void> }
        | undefined;
      let failPeer: (() => void) | undefined;
      const peerResult = Promise.withResolvers<{ exitCode: number }>();
      const run = executeWindowsE2EShardPlan(plan, {
        summaryExists: () => true,
        writeManifest: vi.fn(),
        printManifest: vi.fn(),
        spawnStep: (step) => {
          if (step.shardIndex === 1) {
            completedShard = spawnCancellableStep({
              ...step,
              command: process.execPath,
              args: [wrapper],
              cwd: root,
              env: { ...process.env, ...step.env, ZCODE_E2E_HOME_DIR: home },
            });
            return completedShard;
          }
          failPeer = () => {
            step.onFailure({ kind: "test", title: "peer failed", error: "original failure" });
            peerResult.resolve({ exitCode: 1 });
          };
          return { result: peerResult.promise, terminate: vi.fn() };
        },
      });
      // 附加拒绝观察器但不吞掉后面的断言，避免首错到断言之间产生 unhandled rejection。
      const failedRun = run.catch((error) => error);
      let ownedPid: number | undefined;
      try {
        await completedShard!.result;
        await vi.waitFor(() => {
          expect(existsSync(ownedPidPath)).toBe(true);
          expect(existsSync(unrelatedPidPath)).toBe(true);
        });
        ownedPid = Number(readFileSync(ownedPidPath, "utf8"));
        expect(() => process.kill(ownedPid!, 0)).not.toThrow();
        // 确保 runTrackedStep 已完成；首错必须仍清理它，不只清理 active wrapper。
        const nextTurn = Promise.withResolvers<void>();
        setImmediate(nextTurn.resolve);
        await nextTurn.promise;
        failPeer!();
        const failure = await failedRun;
        expect(failure).toMatchObject({
          manifest: { firstFailure: { title: "peer failed", error: "original failure" } },
        });
        expect(failure.manifest.cleanupErrors).toBeUndefined();
        await vi.waitFor(() => expect(() => process.kill(ownedPid!, 0)).toThrow());
        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      } finally {
        failPeer?.();
        try {
          await completedShard?.terminate();
          await failedRun;
        } finally {
          if (ownedPid) {
            try {
              process.kill(ownedPid, "SIGKILL");
            } catch {
              /* 已由自有回收屏障清理。 */
            }
          }
          unrelated.kill("SIGKILL");
          await unrelatedExit.promise;
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it("terminates active shards on a parent signal and reports the interrupted run", async () => {
    const plan = createPlan();
    const signalSource = new EventEmitter();
    const childResolvers = new Map<
      number,
      (result: { exitCode: number; signal?: string }) => void
    >();
    const terminates: Array<ReturnType<typeof vi.fn>> = [];

    const execution = executeWindowsE2EShardPlan(plan, {
      now: () => 2_000,
      summaryExists: () => true,
      signalSource,
      spawnStep: (step) => {
        if (step.kind === "build") return Promise.resolve({ exitCode: 0 });
        const terminate = vi.fn(() => {
          childResolvers.get(step.shardIndex)?.({ exitCode: 1, signal: "SIGTERM" });
        });
        terminates.push(terminate);
        return {
          result: new Promise<{ exitCode: number; signal?: string }>((resolveChild) => {
            childResolvers.set(step.shardIndex, resolveChild);
          }),
          terminate,
        };
      },
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });

    await vi.waitFor(() => expect(childResolvers.size).toBe(2));
    signalSource.emit("SIGTERM");

    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("parent received SIGTERM"),
      manifest: expect.objectContaining({ interruptedBySignal: "SIGTERM" }),
    });
    expect(terminates).toHaveLength(2);
    expect(terminates.every((terminate) => terminate.mock.calls.length === 1)).toBe(true);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("separates the single-shard default from the fixed 10-shard performance entry", () => {
    const desktopPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "packages/desktop/package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    const rootPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };

    expect(desktopPackage.scripts["pretest:e2e"]).toBe(
      "pnpm --filter @zcode/e2e-report build:node",
    );
    expect(desktopPackage.scripts["test:e2e"]).toBe("node scripts/run-windows-e2e-shards.mjs");
    expect(rootPackage.scripts["test:e2e"]).toBe("pnpm --filter @zcode/desktop test:e2e");
    expect(desktopPackage.scripts["test:e2e:windows:sharded"]).toBe("pnpm test:e2e -- --shards=10");
    expect(rootPackage.scripts["test:e2e:windows:sharded"]).toBe(
      "pnpm --filter @zcode/desktop test:e2e:windows:sharded",
    );
  });
});
