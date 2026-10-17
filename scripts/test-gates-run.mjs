import { writeSync } from "node:fs";
import {
  budgetExpired,
  cancelCommands,
  createGateClock,
  gateBudget,
  runStages,
  startBudget,
  stopAll,
} from "./test-gates-process.mjs";

export function createGateRun({
  level,
  limitSeconds = ["fastcheck", "fulltest", "slowtest"].includes(level) ? gateBudget(level) : null,
  clock = createGateClock(),
  authorized = true,
  signals = ["SIGINT", "SIGTERM"],
  timed = true,
  cleanup,
}) {
  if (limitSeconds !== null) gateBudget(level, limitSeconds);
  let timer;
  let finishing;
  let activeWork;
  let terminal;
  let runDetails = {};
  let finishDetails = {};
  let reported;
  const handlers = new Map();
  const force = (status, exitCode) => {
    if (terminal?.status !== "TIMEOUT") terminal = { status, exitCode };
    cancelCommands();
  };
  const report = (status, exitCode, extra = {}) => {
    if (reported) return reported;
    const timing = clock.read();
    const budgetMode = level === "fastcheck" ? "non-compilation" : "wall-clock";
    if (
      budgetExpired() ||
      (timed &&
        limitSeconds !== null &&
        timing[budgetMode === "wall-clock" ? "total" : "budgeted"] >= limitSeconds)
    )
      terminal = { status: "TIMEOUT", exitCode: 124 };
    reported = {
      ...(level === "slowtest"
        ? {
            wsl: {
              status: "SKIPPED_NOT_APPLICABLE",
              reason:
                "Windows gate policy excludes Linux/WSL validation; no applicable extension exists",
            },
          }
        : {}),
      ...runDetails,
      ...extra,
      ...timing,
      budgetMode,
      limitSeconds,
      status: terminal?.status ?? status,
      level,
      exitCode: terminal?.exitCode ?? exitCode,
    };
    // 硬退出不能丢失管道中尚未 flush 的最终计时及原失败证据。
    writeSync(
      1,
      `${level}: ${reported.status} total=${timing.total.toFixed(1)}s ` +
        `compile_excluded=${timing.compileExcluded.toFixed(1)}s ` +
        `budgeted=${timing.budgeted.toFixed(1)}s ` +
        `limit=${limitSeconds === null ? "n/a" : limitSeconds.toFixed(1)}s\n` +
        `${JSON.stringify(reported)}\n`,
    );
    return reported;
  };
  const finish = (status, exitCode, extra = {}) => {
    if (status === "TIMEOUT" || status === "CANCELLED") force(status, exitCode);
    if (finishing) return finishing;
    finishDetails = extra;
    const endCleanup = clock.enter("check");
    cancelCommands();
    finishing = (async () => {
      try {
        await stopAll(clock);
        // 失败/取消不等待挂起的用例或 verify；只能等待真正拥有的进程树。
        if (status === "PASS") await activeWork;
        await cleanup?.();
      } catch (error) {
        finishDetails = { ...finishDetails, cleanupError: error.message };
        status = "FAIL";
        exitCode = 1;
      } finally {
        endCleanup();
        for (const [event, handler] of handlers) process.off(event, handler);
      }
      const result = report(status, exitCode, finishDetails);
      // 原先在 finish 开始就撤销定时器，清理 Promise 挂起后再无截止。
      timer?.cancel();
      return result;
    })();
    return finishing;
  };
  const terminate = async (status, exitCode, extra) => {
    force(status, exitCode);
    const result = await finish(status, exitCode, extra);
    process.exit(result.exitCode);
  };
  for (const signal of signals) {
    const handler = () => {
      void terminate("CANCELLED", 130);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    const handler = (error) => {
      void terminate("FAIL", 1, { reason: error?.stack ?? String(error) });
    };
    handlers.set(event, handler);
    process.once(event, handler);
  }
  if (timed && (authorized || level === "fastcheck") && limitSeconds !== null)
    timer = startBudget(
      limitSeconds,
      clock,
      () => terminate("TIMEOUT", 124),
      level,
      () => {
        force("TIMEOUT", 124);
        report("TIMEOUT", 124, {
          ...finishDetails,
          reason:
            finishDetails.reason ?? "Hard deadline reached; pending work or cleanup was terminated",
        });
      },
    );
  return {
    clock,
    finish,
    async run(stages, operation, details = {}, verify) {
      if (!authorized && ["fulltest", "slowtest"].includes(level))
        return finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
      if (finishing) return finishing;
      runDetails = details;
      try {
        activeWork = runStages(stages, operation, 3, clock);
        const records = await activeWork;
        if (finishing) return finishing;
        const allPassed = () =>
          records.length === stages.length && records.every((record) => record.status === "PASS");
        activeWork = Promise.resolve(allPassed() ? verify?.(records) : undefined);
        await activeWork;
        if (finishing) return finishing;
        const passed = allPassed();
        const failed = records.some((record) => record.status === "FAIL");
        return finish(
          passed ? "PASS" : failed ? "FAIL" : "UNVERIFIED — REQUIRED ENVIRONMENT UNAVAILABLE",
          passed ? 0 : 1,
          { stages: records },
        );
      } catch (error) {
        activeWork = undefined;
        return finish("FAIL", 1, { reason: error.message });
      }
    },
  };
}
