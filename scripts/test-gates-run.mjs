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
  const handlers = new Map();
  const force = (status, exitCode) => {
    if (terminal?.status !== "TIMEOUT") terminal = { status, exitCode };
    cancelCommands();
  };
  const finish = (status, exitCode, extra = {}) => {
    if (status === "TIMEOUT" || status === "CANCELLED") force(status, exitCode);
    if (finishing) return finishing;
    // Cleanup always counts, including stopping a still-active compile stage.
    const endCleanup = clock.enter("check");
    timer?.cancel();
    cancelCommands();
    finishing = (async () => {
      try {
        await stopAll();
        try {
          await activeWork;
        } catch (error) {
          extra = { ...extra, reason: error.message };
          status = "FAIL";
          exitCode = 1;
        }
        await stopAll();
        try {
          await cleanup?.();
        } catch (error) {
          extra = { ...extra, cleanupError: error.message };
          status = "FAIL";
          exitCode = 1;
        }
      } finally {
        endCleanup();
        for (const [signal, handler] of handlers) process.off(signal, handler);
      }
      const timing = clock.read();
      if (budgetExpired() || (timed && limitSeconds !== null && timing.budgeted >= limitSeconds))
        terminal = { status: "TIMEOUT", exitCode: 124 };
      const report = {
        ...(level === "slowtest"
          ? {
              wsl: {
                status: "SKIPPED_NOT_APPLICABLE",
                reason:
                  "Windows gate policy excludes Linux/WSL validation; no applicable extension exists",
              },
            }
          : {}),
        ...extra,
        ...timing,
        limitSeconds,
        status: terminal?.status ?? status,
        level,
        exitCode: terminal?.exitCode ?? exitCode,
      };
      console.log(
        `${level}: ${report.status} total=${report.total.toFixed(1)}s ` +
          `compile_excluded=${report.compileExcluded.toFixed(1)}s ` +
          `budgeted=${report.budgeted.toFixed(1)}s ` +
          `limit=${limitSeconds === null ? "n/a" : limitSeconds.toFixed(1)}s`,
      );
      console.log(JSON.stringify(report));
      return report;
    })();
    return finishing;
  };
  for (const signal of signals) {
    const handler = () => {
      force("CANCELLED", 130);
      void finish("CANCELLED", 130).then((report) => {
        process.exitCode = report.exitCode;
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  // fastcheck 无需授权；不能因没有 full/slow 的授权标志而遗漏其硬预算定时器。
  if (timed && (authorized || level === "fastcheck") && limitSeconds !== null)
    timer = startBudget(
      limitSeconds,
      clock,
      async () => {
        force("TIMEOUT", 124);
        const report = await finish("TIMEOUT", 124);
        process.exitCode = report.exitCode;
      },
      level,
    );
  return {
    clock,
    finish,
    async run(stages, operation, extra = {}) {
      if (!authorized && ["fulltest", "slowtest"].includes(level))
        return finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
      if (finishing) return finishing;
      try {
        activeWork = runStages(stages, operation, 3, clock);
        const records = await activeWork;
        if (finishing) return finishing;
        activeWork = Promise.resolve(typeof extra === "function" ? extra(records) : extra);
        const details = await activeWork;
        if (finishing) return finishing;
        const passed =
          records.length === stages.length && records.every((record) => record.status === "PASS");
        const failed = records.some((record) => record.status === "FAIL");
        return finish(
          passed ? "PASS" : failed ? "FAIL" : "UNVERIFIED — REQUIRED ENVIRONMENT UNAVAILABLE",
          passed ? 0 : 1,
          { ...details, stages: records },
        );
      } catch (error) {
        // The caught promise has settled; cleanup must not rethrow it before reporting.
        activeWork = undefined;
        return finish("FAIL", 1, { reason: error.message });
      }
    },
  };
}
