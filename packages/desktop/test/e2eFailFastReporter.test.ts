import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Context, Test } from "mocha";
import { testFnWrapper } from "@wdio/utils";
import { resolve } from "node:path";
import {
  createWindowsE2EShardPlan,
  executeWindowsE2EShardPlan,
} from "../scripts/run-windows-e2e-shards.mjs";

const diagnostics = vi.hoisted(() => ({
  stopUICoverage: vi.fn(async () => {}),
  recordTestResult: vi.fn(),
}));

// 修复原因：只隔离诊断 IO；真实 WDIO wrapper、afterTest、首错通知和父级取消链全部保留。
vi.mock("./e2e/reporting/e2e-reporting.js", () => ({
  createE2EReporter: vi.fn(() => diagnostics),
}));

const prefix = "zcode-e2e-failure:invocation-123:";

async function createReporter() {
  // Exercise a fresh process-local first-failure latch after resetModules; a static
  // import would retain the previous test's module instance instead of this boundary.
  const module = await import("./e2e/reporting/e2e-fail-fast-reporter.js");
  return { ...module, reporter: new module.default() };
}

function captureNotifications() {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    write,
    read: () =>
      write.mock.calls.map(([line]) => {
        expect(typeof line).toBe("string");
        const text = String(line);
        expect(text.startsWith(prefix)).toBe(true);
        expect(text.split("\n")).toHaveLength(2);
        return JSON.parse(text.slice(prefix.length));
      }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ZCODE_E2E_FAIL_FAST_PREFIX", prefix);
  diagnostics.stopUICoverage.mockReset().mockResolvedValue(undefined);
  diagnostics.recordTestResult.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("E2E fail-fast reporter", () => {
  it("keeps peers alive for a real WDIO dynamic skip but cancels immediately on an assertion", async () => {
    vi.stubEnv("ZCODE_E2E_RUN_ID", "wrapper-skip-regression");
    vi.stubEnv("ZCODE_E2E_PACKAGED_APP_PATH", process.execPath);
    const originalEnv = { ...process.env };
    // 配置在模块加载时捕获环境，静态导入不能覆盖每个用例独立的首错锁和 run id。
    const { config } = await import("../wdio.conf");
    const afterTest = config.afterTest;
    if (typeof afterTest !== "function") throw new Error("WDIO afterTest hook is missing");
    const plan = createWindowsE2EShardPlan({
      args: [],
      desktopDir: resolve("packages/desktop"),
      env: { ZCODE_E2E_RUN_ID: "wrapper-peers", ZCODE_E2E_SHARD_TOTAL: "2" },
      platform: "win32",
      repoRoot: resolve("."),
    });
    const started = Promise.withResolvers<void>();
    const children: Array<{
      complete: PromiseWithResolvers<{ exitCode: number }>;
      terminate: Mock;
      onFailure: (failure: { kind: string; title: string; error: string }) => void;
    }> = [];
    let workerPrefix = "";
    const output = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      const text = String(line);
      if (workerPrefix && text.startsWith(workerPrefix)) {
        children[0]!.onFailure(JSON.parse(text.slice(workerPrefix.length)));
      }
      return true;
    });
    const execution = executeWindowsE2EShardPlan(plan, {
      spawnStep: (step) => {
        if (step.kind === "build") return { exitCode: 0 };
        workerPrefix = step.env.ZCODE_E2E_FAIL_FAST_PREFIX;
        vi.stubEnv("ZCODE_E2E_FAIL_FAST_PREFIX", workerPrefix);
        const complete = Promise.withResolvers<{ exitCode: number }>();
        const terminate = vi.fn(() => complete.resolve({ exitCode: 1 }));
        children.push({ complete, terminate, onFailure: step.onFailure });
        if (children.length === 2) started.resolve();
        return { result: complete.promise, terminate };
      },
      summaryExists: () => true,
      writeManifest: vi.fn(),
      printManifest: vi.fn(),
    });
    // 在发出首错前就接住父级拒绝，防止测试自身制造未处理 rejection。
    const outcome = execution.then(
      (manifest) => ({ manifest, error: undefined }),
      (error: unknown) => ({ manifest: undefined, error }),
    );
    await started.promise;
    const runTest = (title: string, specFn: (this: Context) => void) => {
      const context = new Context();
      context.runnable(new Test(title, specFn));
      return testFnWrapper.call(
        context,
        "Test",
        { specFn, specFnArgs: [] },
        { beforeFn: [], beforeFnArgs: () => [] },
        {
          afterFn: [afterTest],
          afterFnArgs: () => [{ title, fullTitle: title }, context],
        },
        "0-0",
        0,
      );
    };
    try {
      await expect(
        runTest("legal dynamic skip", function () {
          this.skip();
        }),
      ).rejects.toMatchObject({ message: "sync skip; aborting execution" });
      expect(output).not.toHaveBeenCalled();
      expect(children.every((child) => child.terminate.mock.calls.length === 0)).toBe(true);

      await runTest("continues after skip", () => {});
      // 真正断言失败必须先同步通知，不能等永不完成的诊断采集再取消其他分片。
      diagnostics.stopUICoverage.mockImplementation(() => new Promise<void>(() => {}));
      await expect(
        runTest("genuine assertion", () => {
          expect(1).toBe(2);
        }),
      ).rejects.toThrow();
      expect(children.every((child) => child.terminate.mock.calls.length === 1)).toBe(true);
      expect(output).toHaveBeenCalledOnce();
      expect(String(output.mock.calls[0]![0])).toContain('"title":"genuine assertion"');
      expect((await outcome).error).toMatchObject({
        manifest: { firstFailure: { kind: "test", title: "genuine assertion" } },
      });
    } finally {
      for (const child of children) child.complete.resolve({ exitCode: 0 });
      await outcome;
      process.env = originalEnv;
    }
  });

  it("writes the real test:fail event synchronously with the original error and worker id", async () => {
    const { reporter, hasReportedE2EFailure } = await createReporter();
    const output = captureNotifications();
    reporter.emit("runner:start", { cid: "0-2" });
    reporter.emit("test:fail", {
      fullTitle: "session resumes its conversation",
      error: new Error("original assertion\nexpected 2, received 1"),
    });
    expect(output.read()).toEqual([
      {
        kind: "test",
        title: "session resumes its conversation",
        error: "original assertion\nexpected 2, received 1",
        cid: "0-2",
      },
    ]);
    expect(hasReportedE2EFailure()).toBe(true);
    expect(reporter.isSynchronised).toBe(true);
  });

  it.each([
    { error: new Error("root preflight failed") },
    { errors: [{ message: "root preflight failed" }] },
  ])("reports hook:end errors before teardown", async (failure) => {
    const { reporter } = await createReporter();
    const output = captureNotifications();
    reporter.emit("hook:end", { title: '"before all" hook', cid: "0-1", ...failure });
    expect(output.read()).toEqual([
      { kind: "hook", title: '"before all" hook', error: "root preflight failed", cid: "0-1" },
    ]);
  });

  it("retains only the first failure across early hooks and later WDIO events", async () => {
    const { reporter, notifyE2EFailure } = await createReporter();
    const output = captureNotifications();
    expect(
      notifyE2EFailure({
        kind: "prepare",
        title: "beforeSession",
        error: new Error("setup broke"),
      }),
    ).toBe(true);
    reporter.emit("hook:end", { title: "root hook", error: new Error("setup broke") });
    reporter.emit("test:fail", { title: "later", error: new Error("cancelled") });
    reporter.emit("runner:end", { failures: 1, error: "worker cancelled" });
    expect(output.read()).toEqual([
      { kind: "prepare", title: "beforeSession", error: "setup broke" },
    ]);
  });

  it("reports the original session initiation failure on runner:end", async () => {
    const { reporter } = await createReporter();
    const output = captureNotifications();
    reporter.emit("runner:start", { cid: "0-3" });
    reporter.emit("runner:end", { failures: 1, error: "session not created: driver refused" });
    expect(output.read()).toEqual([
      {
        kind: "runner",
        title: "runner failure",
        error: "session not created: driver refused",
        cid: "0-3",
      },
    ]);
  });

  it("does not silently swallow an unexpected test retry failure", async () => {
    const { reporter } = await createReporter();
    const output = captureNotifications();
    reporter.emit("test:retry", { title: "unexpected retry", error: { message: "first attempt" } });
    expect(output.read()).toEqual([
      { kind: "test", title: "unexpected retry", error: "first attempt" },
    ]);
  });

  it("ignores successful and skipped events and error-free hooks", async () => {
    const { reporter, hasReportedE2EFailure } = await createReporter();
    const output = captureNotifications();
    reporter.emit("runner:start", { cid: "0-0" });
    for (const event of ["test:pass", "test:skip", "test:pending", "test:end"]) {
      reporter.emit(event, { title: "not failed" });
    }
    reporter.emit("hook:end", { title: "successful hook", errors: [] });
    reporter.emit("runner:end", { failures: 0 });
    expect(output.write).not.toHaveBeenCalled();
    expect(hasReportedE2EFailure()).toBe(false);
  });

  it("is inert without a supervisor prefix, preserving standalone diagnostics", async () => {
    vi.stubEnv("ZCODE_E2E_FAIL_FAST_PREFIX", "");
    const { reporter, hasReportedE2EFailure } = await createReporter();
    const output = captureNotifications();
    reporter.emit("test:fail", { title: "standalone failure", error: new Error("failed") });
    expect(output.write).not.toHaveBeenCalled();
    expect(hasReportedE2EFailure()).toBe(false);
  });

  it("bounds title and error while escaping embedded newlines into one JSON line", async () => {
    const { reporter } = await createReporter();
    const output = captureNotifications();
    reporter.emit("runner:error", { title: "t\n".repeat(2000), error: "e\n".repeat(10000) });
    const [notification] = output.read();
    expect(notification.title).toBe("t\n".repeat(512));
    expect(notification.error).toBe("e\n".repeat(4096));
  });
});
