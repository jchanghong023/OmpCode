import { writeSync } from "node:fs";
import {
  budgetExpired,
  cancelCommands,
  logGateProgress,
  startBudget,
  stopAll,
} from "./test-gates-process.mjs";
import { createGateClock, gateBudget } from "./test-gates-clock.mjs";

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
  let heartbeat;
  let phase = "idle";
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
    clearInterval(heartbeat);
    const timing = clock.read();
    const budgetMode = level === "fastcheck" ? "non-compilation" : "wall-clock";
    if (
      budgetExpired() ||
      (timed &&
        limitSeconds !== null &&
        timing[budgetMode === "wall-clock" ? "total" : "budgeted"] >= limitSeconds)
    )
      terminal = { status: "TIMEOUT", exitCode: 124 };
    const targets = (extra.stages ?? runDetails.stages ?? []).flatMap(
      (stage) => stage.targets ?? [],
    );
    const successful = targets.filter((target) => target.status === "PASS");
    const cache = {
      required: runDetails.requiredTargets ?? [],
      executedSuccessful: successful.filter((target) => !target.cached).map((target) => target.id),
      cachedSuccessful: successful.filter((target) => target.cached).map((target) => target.id),
      incomplete: (runDetails.requiredTargets ?? []).filter(
        (id) => !successful.some((target) => target.id === id),
      ),
    };
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
      cache,
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
    if (status === "FAIL" || status === "CANCELLED") timer?.beginTerminalCleanup();
    finishDetails = extra;
    const endCleanup = clock.enter("check");
    phase = "cleanup";
    logGateProgress(clock, "cleanup-start", phase);
    cancelCommands();
    finishing = (async () => {
      try {
        await stopAll(clock);
        // 失败/取消不等待挂起的用例或 verify；只能等待真正拥有的进程树。
        if (status === "PASS") await activeWork;
        await cleanup?.();
        logGateProgress(clock, "cleanup-complete", phase);
      } catch (error) {
        logGateProgress(clock, "cleanup-failed", phase);
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
      () => {
        logGateProgress(clock, "timeout", phase);
        return terminate("TIMEOUT", 124);
      },
      level,
      () => {
        force("TIMEOUT", 124);
        logGateProgress(clock, "forced-exit", phase);
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
    async run(operation, details = {}, verify) {
      if (!authorized && ["fulltest", "slowtest"].includes(level))
        return finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
      if (finishing) return finishing;
      const records = [];
      runDetails = { ...details, stages: records };
      phase = "stages";
      heartbeat = setInterval(() => logGateProgress(clock, "progress", phase), 15_000);
      heartbeat.unref();
      let firstFailure;
      const failedEarly = new Promise((resolve) => {
        firstFailure = resolve;
      });
      const onFailure = (record) => {
        if (records.some((entry) => entry.status === "FAIL")) return;
        const index = records.findIndex((entry) => entry.id === record.id);
        if (index === -1) records.push(record);
        else records[index] = record;
        cancelCommands();
        firstFailure();
      };
      try {
        // The caller owns a simple serial risk-group/GUI-phase loop; Bazel alone
        // owns target admission, concurrency, dependency barriers and timing.
        activeWork = Promise.resolve().then(() => operation(records, onFailure));
        await Promise.race([activeWork, failedEarly]);
        if (finishing) return finishing;
        const allPassed = () =>
          records.length > 0 && records.every((record) => record.status === "PASS");
        if (allPassed() && verify) {
          phase = "verify";
          activeWork = Promise.resolve().then(() => verify(records));
          await activeWork;
        }
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
        // 原因：CI Linux 曾报 EISDIR 但无堆栈，无法定位读取点；随首异常报告堆栈一次，
        // 不含凭据，只含代码位置与路径，便于精确定位环境差异。
        return finish("FAIL", 1, { reason: error.message, stack: error.stack });
      }
    },
  };
}
