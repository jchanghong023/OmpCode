import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { immediateTestArguments } from "./test-gates-test-reporter.mjs";
import { gateBudget } from "./test-gates-clock.mjs";

const activeChildren = new Set();
const stoppingTrees = new WeakMap();
const activeStages = new Set();
const commandLabels = new WeakMap();
const label = (value) =>
  String(value ?? "unlabelled")
    .replace(/[^a-zA-Z0-9_.:/-]/gu, "_")
    .slice(0, 160);
const diagnostic = (text) => writeSync(1, `[gate] ${text}\n`);

export function logGateProgress(clock, event, phase = "stages") {
  const timing = clock.read();
  const stages = [...activeStages].map(({ id, group }) => `${id}@${group}`).join(",") || "none";
  const children =
    [...activeChildren]
      .map((child) => `${commandLabels.get(child) ?? "unlabelled"}:${child.pid ?? "pending"}`)
      .join(",") || "none";
  diagnostic(
    `${label(event)} phase=${label(phase)} active=${stages} pid=${children} ` +
      `total=${timing.total.toFixed(1)}s budgeted=${timing.budgeted.toFixed(1)}s`,
  );
}
let commandsCancelled = false;
let budgetTimedOut = false;

export const budgetExpired = () => budgetTimedOut;

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
          "taskkill",
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
  try {
    await stopTrees([...activeChildren]);
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
  const wallClock = level !== "fastcheck";
  const used = () => clock.read()[wallClock ? "total" : "budgeted"];
  const paused = () => !wallClock && clock.compileOnly();
  // 原定时器在编译和 finish 时被取消，清理挂起可无限越过总时限。
  // 提前清理与硬截止独立；full/slow 按总墙钟，硬截止一直保留到报告完成。
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
    if (options.stdoutOnly && fromStderr) diagnostics += text;
    else output += text;
    if (!options.quiet) process.stdout.write(text);
    // stdout/stderr 分片互相交错但不是一条流；共用 tail 会切断真诊断或拼成伪失败帧。
    const stream = fromStderr ? "stderr" : "stdout";
    const tail = (tails[stream] = (tails[stream] + text).slice(-12000));
    skipped ||= /# SKIP|(?:#|ℹ) skipped [1-9]|\[UNVERIFIED|requires .*; skipped/u.test(tail);
    let immediateFailure;
    if (immediateTests && fromStderr) {
      failureFrames += text;
      let newline;
      while ((newline = failureFrames.indexOf("\n")) !== -1) {
        const line = failureFrames.slice(0, newline);
        failureFrames = failureFrames.slice(newline + 1);
        const prefix = "\u001eOMP_TEST_FAILURE ";
        if (line.startsWith(prefix)) {
          const failure = JSON.parse(line.slice(prefix.length));
          immediateFailure = `${failure.fullName ?? failure.name}: ${failure.error}`;
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
      done({ code: 1, output: `${output}\n${diagnostics}${error.message}`, skipped: false });
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

export async function gitText(args) {
  // Git 的 LF/CRLF 诊断与 diff 跨流拼接顺序不稳定；指纹只取 stdout，失败仍保留 stderr。
  const result = await commandOutput("git", args, { quiet: true, stdoutOnly: true });
  if (result.code) throw new Error(result.output.trim());
  return result.output;
}

export async function snapshot() {
  const head = (await gitText(["rev-parse", "HEAD"])).trim();
  const diff = await gitText(["diff", "--binary", "HEAD"]);
  const untracked = (await gitText(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256").update(diff);
  for (const name of untracked) {
    hash.update(name).update(await readFile(name));
  }
  const status = (await gitText(["status", "--short"])).trim();
  return {
    head,
    contentHash: hash.digest("hex"),
    clean: !status,
    dirty: status.split("\n").filter(Boolean),
  };
}

export function sameSnapshot(a, b) {
  return a?.head === b?.head && a?.contentHash === b?.contentHash;
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function stageResult(stage, operation, clock) {
  const start = performance.now();
  const context = { id: label(stage.id), group: label(stage.parallelGroup ?? "serial") };
  activeStages.add(context);
  diagnostic(
    `stage-start stage=${context.id} group=${context.group} kind=${label(stage.kind ?? "check")}`,
  );
  let end;
  let result;
  try {
    end = clock?.enter(stage.kind ?? "check");
    result = await operation();
  } catch (error) {
    result = { status: "FAIL", reason: error.message };
  } finally {
    end?.();
    activeStages.delete(context);
  }
  const record = { id: stage.id, seconds: Number(elapsed(start)), ...result };
  console.log(
    `[${record.status}] ${record.id} ${record.seconds.toFixed(1)}s${record.reason ? `: ${record.reason}` : ""}`,
  );
  return record;
}

export async function runStages(stages, operation, concurrency = 3, clock) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Gate concurrency must be between 1 and 4");
  const records = [];
  for (let index = 0; index < stages.length;) {
    const group = stages[index].parallelGroup;
    let end = index + 1;
    if (group) while (end < stages.length && stages[end].parallelGroup === group) end++;
    diagnostic(`group-start group=${label(group ?? "serial")} stages=${end - index}`);
    const results = [];
    const started = new Set();
    let next = index;
    let failed = false;
    let fail;
    const firstFailure = new Promise((resolve) => {
      fail = resolve;
    });
    const worker = async () => {
      while (next < end && !failed && !commandsCancelled) {
        const current = next++;
        started.add(current);
        const start = performance.now();
        const onFailure = (result) => {
          if (failed) return;
          results[current - index] = {
            id: stages[current].id,
            seconds: Number(elapsed(start)),
            ...result,
          };
          failed = true;
          // Emit the original evidence before resolving the first-failure race:
          // neither the stage's finally nor process-tree cleanup may delay it.
          writeSync(
            1,
            `[gate] first-failure stage=${label(stages[current].id)} ` +
              `status=${label(result.status)} seconds=${elapsed(start)} ` +
              `exit=${result.exitCode ?? "n/a"}${result.reason ? `: ${result.reason}` : ""}\n`,
          );
          cancelCommands();
          fail();
        };
        const result = await stageResult(
          stages[current],
          async () => {
            const result = await operation(stages[current], onFailure);
            return results[current - index] ?? result;
          },
          clock,
        );
        // A late success cannot replace an already accepted first-failure record.
        results[current - index] ??= result;
        if (result.status !== "PASS") {
          onFailure(result);
        }
      }
    };
    const workers = Promise.all(Array.from({ length: Math.min(concurrency, end - index) }, worker));
    await Promise.race([workers, firstFailure]);
    if (failed) {
      await stopAll(clock);
      for (const current of started)
        results[current - index] ??= { id: stages[current].id, status: "CANCELLED" };
    }
    records.push(...results.filter(Boolean));
    diagnostic(
      `group-close group=${label(group ?? "serial")} status=${failed ? "FAIL" : commandsCancelled ? "CANCELLED" : "PASS"}`,
    );
    if (failed || commandsCancelled) break;
    index = end;
  }
  return records;
}
