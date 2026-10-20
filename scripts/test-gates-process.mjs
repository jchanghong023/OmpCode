import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { immediateTestArguments } from "./test-gates-test-reporter.mjs";
import { gateBudget } from "./test-gates-clock.mjs";

export function windowsSystemToolPath(executable) {
  // PATH 搜索在短截止场景中实测耗尽清理余量；直接定位当前 Windows 的系统工具。
  // Worker 的 env 副本区分大小写；Bazel 传入 SYSTEMROOT，不能沿用主线程的大小写别名。
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "SYSTEMROOT");
  if (!key) throw new Error("Windows SystemRoot is required for native gate tools");
  return join(process.env[key], "System32", executable);
}

const activeChildren = new Set();
const stoppingTrees = new WeakMap();
const commandLabels = new WeakMap();
const label = (value) =>
  String(value ?? "unlabelled")
    .replace(/[^a-zA-Z0-9_.:/-]/gu, "_")
    .slice(0, 160);
const diagnostic = (text) => writeSync(1, `[gate] ${text}\n`);

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

let deadlineWorker;
export function watchBudgetTargets(paths) {
  deadlineWorker?.postMessage({ paths });
  return () => deadlineWorker?.postMessage({ paths: [] });
}

// Node 原生测试的跳过标记不可被 commandOutput 当作已验证通过。
const skipSignalPattern = /# SKIP|(?:#|ℹ) skipped [1-9]|\[UNVERIFIED|requires .*; skipped/u;

// Bazel 批客户端 java 可能脱离已注册子进程；桥接模块按 --output_base 标记注册
// 附加进程树终止器，stopAll 清理直跑子进程后一并执行，仍计入同一计费区间。
const extraTreeKillers = new Set();
export const registerTreeKiller = (killer) => {
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
    if (running.length && process.platform === "win32") {
      // Windows 每次 /T 都枚举进程；并发 taskkill 争用会拖慢清理，批量终止本门禁所属根。
      // 不能提前杀掉清理器再等待未终止的子进程；保留完整清理耗时和真实预算结果。
      await new Promise((done, reject) => {
        const killer = spawn(
          windowsSystemToolPath("taskkill.exe"),
          [...running.flatMap((child) => ["/PID", String(child.pid)]), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("error", reject);
        killer.once("exit", (code, signal) => {
          // 批量 taskkill 与自然退出竞争时可能返回 128；清理成功只以全部 close 为准。
          if (code !== 0)
            diagnostic(
              `tree-cleanup-taskkill-exit pid=${pids} exit=${code} signal=${signal ?? "none"} waiting=owned-close`,
            );
          done();
        });
      });
    } else {
      for (const child of running) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    await Promise.all(closed);
    diagnostic(`tree-cleanup-complete pid=${pids} seconds=${elapsed(started)}`);
  } catch (error) {
    diagnostic(
      `tree-cleanup-failed method=${process.platform === "win32" ? "taskkill" : "kill"} pid=${pids} code=${label(error.code ?? "unknown")} exit=${error.exitCode ?? "n/a"} seconds=${elapsed(started)}`,
    );
    throw error;
  }
}

export async function stopAll(clock) {
  // 首诊断到达时编译阶段尚未退出，taskkill 等待曾被误算为纯编译；清理必须显式计费。
  // 复用门禁时钟的活跃区间计数，和超时/finish 的清理重叠也只计同一段墙钟时间。
  const endCleanup = clock?.enter("check");
  // 取消时先接管附加清理器：等待客户端 close 会触发阶段 finally 注销，
  // 若在 await 后才读取集合，已脱离客户端的 Bazel server 就会漏清理。
  const cancelledTreeKillers = commandsCancelled ? [...extraTreeKillers] : [];
  try {
    await stopTrees([...activeChildren]);
    // 附加进程树终止器只在取消/首失败路径启用：正常完成的收尾杀掉 Bazel server
    // 会中断其动作缓存簿记落盘，下一轮出现 _tmp/actions 幻影输入（平台缺陷）。
    await Promise.allSettled(cancelledTreeKillers.map((killer) => killer()));
  } finally {
    endCleanup?.();
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
  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 5);
  const state = new BigInt64Array(shared);
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
  const expire = () => {
    if (cancelled || expiring) return;
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
    process.exit(124);
  };
  const schedule = () => {
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
    if (cancelled || paused()) return;
    const elapsed = used();
    if (!expiring) softTimer = setTimeout(expire, Math.max(0, (cleanupAt - elapsed) * 1000));
    hardTimer = setTimeout(forceExit, Math.max(0, (limitSeconds - elapsed) * 1000));
  };
  const unsubscribe = clock.subscribe(schedule);
  schedule();
  return {
    cancel() {
      cancelled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      unsubscribe();
      clearInterval(publishing);
      unpublish();
      if (deadlineWorker === watchdog) deadlineWorker = undefined;
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
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: withPinnedNodePath({ ...process.env, ...options.env }, process.execPath),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  const stageId = label(options.stageId ?? command);
  commandLabels.set(child, stageId);
  if (!options.quiet) diagnostic(`process-start stage=${stageId} pid=${child.pid ?? "pending"}`);
  child.once("error", (error) => {
    if (!options.quiet)
      diagnostic(
        `process-error stage=${stageId} pid=${child.pid ?? "pending"} code=${label(error.code)}`,
      );
  });
  child.once("close", (code, signal) => {
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
