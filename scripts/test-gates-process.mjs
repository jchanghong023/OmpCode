import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { immediateTestArguments } from "./test-gates-test-reporter.mjs";
import { gateBudget } from "./test-gates-clock.mjs";
import { cleanupOwnedProcesses } from "./test-gates-process-cleanup.mjs";

export function windowsSystemToolPath(executable) {
  // PATH 搜索在短截止场景中实测耗尽清理余量；直接定位当前 Windows 的系统工具。
  // Worker 的 env 副本区分大小写；Bazel 传入 SYSTEMROOT，不能沿用主线程的大小写别名。
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "SYSTEMROOT");
  if (!key) throw new Error("Windows SystemRoot is required for native gate tools");
  return join(process.env[key], "System32", executable);
}

const activeChildren = new Set();
const activeGateIO = new Set();
const stoppingTrees = new WeakMap();
const commandLabels = new WeakMap();
const bazelClients = new WeakMap();
const label = (value) =>
  String(value ?? "unlabelled")
    .replace(/[^a-zA-Z0-9_.:/-]/gu, "_")
    .slice(0, 160);
const diagnostic = (text) => writeSync(1, `[gate] ${text} epochMillis=${Date.now()}\n`);

export function logGateProgress(clock, event, phase = "stages") {
  const timing = clock.read();
  const children =
    [...activeChildren]
      .map((child) => `${commandLabels.get(child) ?? "unlabelled"}:${child.pid ?? "pending"}`)
      .join(",") || "none";
  diagnostic(
    `${label(event)} phase=${label(phase)} pid=${children} ` +
      `total=${timing.total.toFixed(1)}s budgeted=${timing.budgeted.toFixed(1)}s`,
  );
}
let commandsCancelled = false;
let budgetTimedOut = false;

export const budgetExpired = () => budgetTimedOut;
// 文件 IO 与子进程共用此取消事实，避免取消后仍准入新的产物复制。
export const commandsAreCancelled = () => commandsCancelled;

export function trackGateIO(promise) {
  activeGateIO.add(promise);
  // finally 会产生另一个可能无人处理的拒绝 Promise；双方只撤销登记，错误仍归调用者。
  const settled = () => activeGateIO.delete(promise);
  promise.then(settled, settled);
  return promise;
}

let deadlineWorker;
let deadlineState;
let ownedProcessAdmission = false;
const markOwnedProcessAdmission = () => {
  ownedProcessAdmission = true;
  if (deadlineState && Atomics.compareExchange(deadlineState, 6, 0n, 1n) === 2n)
    throw new Error("Gate deadline sealed process admission");
};
export function watchBudgetTargets(paths) {
  if (paths.length) markOwnedProcessAdmission();
  deadlineWorker?.postMessage({ paths });
  return () => deadlineWorker?.postMessage({ paths: [] });
}

// 测试与资源准备共用跳过判据，任何执行器都不能把未验证输出当作通过。
export const skipSignalPattern = /# SKIP|(?:#|ℹ) skipped [1-9]|\[UNVERIFIED|requires .*; skipped/u;

// 仅保留调用方登记的附加工作进程清理；Bazel server 不属于进程注册表。
const extraTreeKillers = new Set();
export const registerTreeKiller = (killer) => {
  markOwnedProcessAdmission();
  extraTreeKillers.add(killer);
  return () => extraTreeKillers.delete(killer);
};

const elapsed = (start) => ((performance.now() - start) / 1000).toFixed(1);

function stopTrees(children) {
  const pending = children.filter(
    (child) => activeChildren.has(child) && !stoppingTrees.has(child),
  );
  if (pending.length) {
    const stopping = stopOwnedTrees(pending);
    for (const child of pending) stoppingTrees.set(child, stopping);
  }
  return Promise.all(children.map((child) => stoppingTrees.get(child)));
}

async function stopOwnedTrees(children) {
  const started = performance.now();
  const pids = children.map((child) => child.pid ?? "pending").join(",");
  diagnostic(`tree-cleanup-start pid=${pids}`);
  try {
    const closed = children.map((child) => new Promise((done) => child.once("close", done)));
    const running = children.filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null,
    );
    if (running.length)
      await cleanupOwnedProcesses(
        running.map((child) => ({
          pid: child.pid,
          outputBase: bazelClients.get(child),
        })),
        {
          powershell:
            process.platform === "win32"
              ? windowsSystemToolPath("WindowsPowerShell/v1.0/powershell.exe")
              : undefined,
        },
      );
    await Promise.all(closed);
    diagnostic(`tree-cleanup-complete pid=${pids} seconds=${elapsed(started)}`);
  } catch (error) {
    diagnostic(
      `tree-cleanup-failed method=owned-processes pid=${pids} code=${label(error.code ?? "unknown")} exit=${error.exitCode ?? "n/a"} seconds=${elapsed(started)}`,
    );
    throw error;
  }
}

export async function stopAll(clock) {
  // 首诊断到达时编译阶段尚未退出，taskkill 等待曾被误算为纯编译；清理必须显式计费。
  // 复用门禁时钟的活跃区间计数，和超时/finish 的清理重叠也只计同一段墙钟时间。
  const endCleanup = clock?.enter("check");
  // 首失败先接管附加工作清理；客户端 close 会触发阶段 finally 注销。
  const cancelledTreeKillers = commandsCancelled ? [...extraTreeKillers] : [];
  // Node copy/chmod 无法随子进程终止；先接管已准入 IO，不能只等待可能挂起的阶段任务。
  const admittedIO = [...activeGateIO];
  try {
    const [trees] = await Promise.allSettled([stopTrees([...activeChildren])]);
    // 取消只收口本轮已准入工作进程；正常或异常退出都不能接管 Bazel server。
    // 单个清理器同步抛错也不能阻止其他已接管清理，保留原始错误。
    const results = await Promise.allSettled(cancelledTreeKillers.map(async (killer) => killer()));
    const failure =
      trees.status === "rejected" ? trees : results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  } finally {
    try {
      // 只收口不可取消 IO，不将其拒绝改写成取消结果或覆盖原清理失败。
      await Promise.allSettled(admittedIO);
    } finally {
      endCleanup?.();
    }
  }
}

export async function stopCommand(child) {
  await stopTrees([child]);
  // Ownership ends on close, after all pipe output and stage cleanup settle.
}

export function cancelCommands() {
  commandsCancelled = true;
}

export function startBudget(limitSeconds, clock, onTimeout, level = "fastcheck", onHardTimeout) {
  gateBudget(level, limitSeconds);
  if (!clock?.read || !clock?.subscribe || !clock?.compileOnly)
    throw new Error("startBudget requires a gate clock");
  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 7);
  const state = new BigInt64Array(shared);
  deadlineState = state;
  Atomics.store(state, 6, ownedProcessAdmission ? 1n : 0n);
  const publish = () => {
    const timing = clock.read();
    Atomics.add(state, 4, 1n);
    Atomics.store(state, 0, BigInt(Math.round(timing.total * 1000)));
    Atomics.store(state, 1, BigInt(Math.round(timing.compileExcluded * 1000)));
    Atomics.store(state, 2, clock.compileOnly() ? 1n : 0n);
    Atomics.store(state, 3, process.hrtime.bigint() / 1_000_000n);
    Atomics.add(state, 4, 1n);
  };
  publish();
  const watchdog = new Worker(new URL("./test-gates-watchdog.mjs", import.meta.url), {
    workerData: {
      shared,
      level,
      limitSeconds,
      startedAt: Number(process.hrtime.bigint() / 1_000_000n) - clock.read().total * 1000,
      pid: process.pid,
    },
  });
  deadlineWorker = watchdog;
  watchdog.unref();
  const publishing = setInterval(publish, 50);
  publishing.unref();
  const unpublish = clock.subscribe(publish);
  const wallClock = level !== "fastcheck";
  const used = () => clock.read()[wallClock ? "total" : "budgeted"];
  const paused = () => !wallClock && clock.compileOnly();
  // 提前清理与硬截止独立；full/slow 按总墙钟，硬截止保留到报告完成。
  const cleanupAt = limitSeconds - Math.min(5, limitSeconds * 0.5);
  let softTimer;
  let hardTimer;
  let expiring = false;
  let cancelled = false;
  let terminalCleanup = false;
  const expire = () => {
    if (cancelled || expiring || terminalCleanup) return;
    if (paused() || used() < cleanupAt) return schedule();
    expiring = true;
    budgetTimedOut = true;
    cancelCommands();
    logGateProgress(clock, "budget-expiring");
    // 不先 await stopAll：所属进程关闭或 cleanup 挂起不能阻塞终态通知。
    void onTimeout();
  };
  const forceExit = () => {
    if (cancelled) return;
    if (paused() || used() < limitSeconds) return schedule();
    budgetTimedOut = true;
    cancelCommands();
    logGateProgress(clock, "hard-deadline");
    onHardTimeout?.();
    cleanupOwnedProcesses(
      [...activeChildren]
        .filter((child) => child.pid && child.exitCode === null && child.signalCode === null)
        .map((child) => ({
          pid: child.pid,
          outputBase: bazelClients.get(child),
        })),
      {
        powershell:
          process.platform === "win32"
            ? windowsSystemToolPath("WindowsPowerShell/v1.0/powershell.exe")
            : undefined,
        detached: true,
      },
    );
    process.exit(124);
  };
  const schedule = () => {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    if (cancelled || paused()) return;
    const elapsed = used();
    if (!expiring && !terminalCleanup)
      softTimer = setTimeout(expire, Math.max(0, (cleanupAt - elapsed) * 1000));
    hardTimer = setTimeout(forceExit, Math.max(0, (limitSeconds - elapsed) * 1000));
  };
  const unsubscribe = clock.subscribe(schedule);
  schedule();
  return {
    beginTerminalCleanup() {
      // 已确认失败/取消正在收尾，预留点不是新超时；硬截止与独立监督仍保留。
      if (expiring) return;
      terminalCleanup = true;
      Atomics.store(state, 5, 1n);
      clearTimeout(softTimer);
    },
    cancel() {
      cancelled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      unsubscribe();
      clearInterval(publishing);
      unpublish();
      if (deadlineWorker === watchdog) {
        deadlineWorker = undefined;
        deadlineState = undefined;
      }
      void watchdog.terminate();
    },
  };
}

export function startCommand(command, args = [], options = {}) {
  if (commandsCancelled) throw new Error("Gate cancelled; refusing to start another process");
  let executable = command;
  if (command === "node") executable = process.execPath;
  if (command === "pnpm") {
    const entry = process.env.npm_execpath;
    if (!entry || !/pnpm\.(?:c?js)$/u.test(entry)) {
      throw new Error("Run the gate through pnpm (npm_execpath must identify pnpm's JS entry)");
    }
    executable = process.execPath;
    args = [entry, ...args];
  }
  // 必须先发布再 spawn；主线程随后即使阻塞，watchdog 也不能漏掉刚准入的后代。
  markOwnedProcessAdmission();
  // info/version 等客户端不拥有动作；仅显式 build/test 准入可收回 server 下的本轮 worker。
  const outputBase =
    options.bazel && args.some((arg) => arg === "build" || arg === "test")
      ? args.find((arg) => arg.startsWith("--output_base="))?.slice("--output_base=".length)
      : undefined;
  if (outputBase)
    deadlineWorker?.postMessage({ bazelAdmission: { command: executable, args, outputBase } });
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: withPinnedNodePath({ ...process.env, ...options.env }, process.execPath),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  if (outputBase) bazelClients.set(child, outputBase);
  deadlineWorker?.postMessage({ child: { pid: child.pid, outputBase } });
  const stageId = label(options.stageId ?? command);
  commandLabels.set(child, stageId);
  if (!options.quiet) diagnostic(`process-start stage=${stageId} pid=${child.pid ?? "pending"}`);
  child.once("error", (error) => {
    if (!options.quiet)
      diagnostic(
        `process-error stage=${stageId} pid=${child.pid ?? "pending"} code=${label(error.code)}`,
      );
  });
  child.once("exit", () => deadlineWorker?.postMessage({ closedPid: child.pid }));
  child.once("close", (code, signal) => {
    deadlineWorker?.postMessage({ closedPid: child.pid });
    activeChildren.delete(child);
    if (!options.quiet)
      diagnostic(
        `process-close stage=${stageId} pid=${child.pid ?? "pending"} exit=${code} signal=${signal ?? "none"}`,
      );
  });
  return child;
}

export async function commandOutput(command, args = [], options = {}) {
  const immediateTests = options.failFastTests && args.includes("--test");
  // GUI 自有失败帧不依赖 Node test reporter；必须在命令退出/清理之前通知监督者。
  const consumeFailureFrames = options.failFast || options.failFastTests;
  if (immediateTests) args = immediateTestArguments(args);
  const child = startCommand(command, args, options);
  // 管道分片可截断中文 UTF-8 字节；流解码必须保留半个字符，不能逐 Buffer.toString 生成替换符。
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let diagnostics = "";
  let skipped = false;
  const tails = { stdout: "", stderr: "" };
  let reportedFailure;
  let failureFrames = "";
  let failureNotified = false;
  const stopFailure = (code = 1) => {
    if (failureNotified) return;
    failureNotified = true;
    cancelCommands();
    // 阶段 finally 或流关闭也可能挂起，首失败必须直接通知调度所有者。
    options.onFailure?.({
      status: "FAIL",
      exitCode: code,
      ...(reportedFailure ? { reason: reportedFailure } : {}),
    });
    // stopOwnedTrees logs failures; the owning run still awaits the same cleanup promise.
    void stopAll(options.clock).catch(() => {});
  };
  const collect = (data, fromStderr = false) => {
    const text = data;
    // 原生目标日志由 Bazel 保存；只有 Git/版本查询和隔离自检需要返回完整输出。
    if (options.captureOutput !== false) {
      if (options.stdoutOnly && fromStderr) diagnostics += text;
      else output += text;
    }
    if (!options.quiet) process.stdout.write(text);
    // stdout/stderr 分片互相交错但不是一条流；共用 tail 会切断真诊断或拼成伪失败帧。
    const stream = fromStderr ? "stderr" : "stdout";
    const tail = (tails[stream] = (tails[stream] + text).slice(-12000));
    skipped ||= skipSignalPattern.test(tail);
    let immediateFailure;
    if (consumeFailureFrames && fromStderr) {
      failureFrames += text;
      let newline;
      while ((newline = failureFrames.indexOf("\n")) !== -1) {
        const line = failureFrames.slice(0, newline);
        failureFrames = failureFrames.slice(newline + 1);
        const prefix = "\u001eOMP_TEST_FAILURE ";
        if (line.startsWith(prefix)) {
          const failure = JSON.parse(line.slice(prefix.length));
          immediateFailure ??= `${failure.fullName ?? failure.name}: ${failure.error}`;
        }
      }
    }
    // 独立 stderr 失败帧不受 TAP 排序影响，编译诊断仍逐流解析。
    if (!reportedFailure) {
      const failed =
        (!immediateTests && options.failFastTests && !fromStderr
          ? tail.match(/^\s*not ok \d+ - [^\r\n]+/mu)
          : undefined) ??
        (options.failFastCompiler ? tail.match(/^[^\r\n]*\berror TS\d+: [^\r\n]+/mu) : undefined);
      if (immediateFailure || failed) {
        reportedFailure = immediateFailure ?? failed[0].trim();
        stopFailure();
      }
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", (data) => collect(data, true));
  child.once("exit", (code) => {
    if (options.failFast && code !== 0) stopFailure(code ?? 1);
  });
  return await new Promise((done) => {
    child.once("error", (error) => {
      activeChildren.delete(child);
      reportedFailure = error.message;
      if (options.failFast) stopFailure();
      done({
        code: 1,
        output: `${output}\n${diagnostics}${error.message}`,
        reason: error.message,
        skipped: false,
      });
    });
    child.once("close", (code) => {
      activeChildren.delete(child);
      done({
        code: reportedFailure ? 1 : (code ?? 1),
        output: code !== 0 && options.stdoutOnly ? output + diagnostics : output,
        skipped,
        ...(reportedFailure ? { reason: reportedFailure } : {}),
      });
    });
  });
}
