import { workerData, parentPort } from "node:worker_threads";
import { readFileSync, write } from "node:fs";
import { windowsSystemToolPath } from "./test-gates-process.mjs";
import { cleanupOwnedProcesses } from "./test-gates-process-cleanup.mjs";

// Bazel owns target timeouts. This worker owns only the whole-run deadline,
// including a blocked supervisor event loop or blocked final-report destination.
const { shared, level, limitSeconds, startedAt, pid } = workerData;
const state = new BigInt64Array(shared);
let paths = [];
const children = new Map();
const bazelAdmissions = [];
const cleanupAt = limitSeconds - Math.min(5, limitSeconds * 0.5);
let cleanupStarted = false;
parentPort.on("message", (message) => {
  if (message.paths) paths = message.paths;
  if (message.child?.pid) children.set(message.child.pid, message.child);
  if (message.closedPid) children.delete(message.closedPid);
  if (message.bazelAdmission) bazelAdmissions.push(message.bazelAdmission);
});
const snapshot = () => {
  for (;;) {
    const version = Atomics.load(state, 4);
    if (version % 2n) continue;
    const values = [0, 1, 2, 3].map((index) => Number(Atomics.load(state, index)));
    if (version === Atomics.load(state, 4)) return values;
  }
};
function pendingExclusion(sampledAt, now, paused) {
  if (!paths.length) {
    // A responsive clock publishes every 50ms. An abandoned compile lease with
    // no native action evidence must never disable the deadline indefinitely.
    return paused ? Math.min(now - sampledAt, 200) : 0;
  }
  const events = [];
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const prefix = "\u001eOMP_GATE_KIND ";
      if (!line.startsWith(prefix)) continue;
      try {
        const frame = JSON.parse(line.slice(prefix.length));
        if (Number.isFinite(frame.time)) events.push({ ...frame, path });
      } catch {
        /* A live writer may not have finished its last frame. */
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  if (!events.length) return paused ? Math.min(now - sampledAt, 200) : 0;
  const active = new Map();
  let cursor = sampledAt;
  let excluded = 0;
  const compileOnly = () =>
    active.size > 0 && [...active.values()].every((kind) => kind === "compile");
  for (const event of events) {
    if (event.time > now) break;
    if (event.time > sampledAt) {
      if (compileOnly()) excluded += event.time - cursor;
      cursor = event.time;
    }
    if (event.event === "start") active.set(event.path, event.kind);
    else if (event.event === "end") active.delete(event.path);
  }
  if (compileOnly()) excluded += now - cursor;
  return excluded;
}
let forced = false;
function forceTermination() {
  if (forced) return;
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  const [, excludedMs, paused, sampledAt] = snapshot();
  const total = (now - startedAt) / 1000;
  const compileExcluded = (excludedMs + pendingExclusion(sampledAt, now, paused)) / 1000;
  const budgeted = total - compileExcluded;
  // 终态清理在预留点后仍可合法完成；只有实际硬截止才允许覆盖已接纳的失败/取消。
  if (Atomics.load(state, 5) === 1n && (level === "fastcheck" ? budgeted : total) < limitSeconds)
    return;
  forced = true;
  // The reserve includes OS process-tree termination, not just issuing cleanup.
  const report = {
    level,
    status: "TIMEOUT",
    exitCode: null,
    requestedExitCode: 124,
    forcedTermination: true,
    total,
    compileExcluded,
    budgeted,
    limitSeconds,
    budgetMode: level === "fastcheck" ? "non-compilation" : "wall-clock",
    reason: "Independent whole-run watchdog requested forced OS tree termination",
  };
  // CAS 同时封住尚为空的准入，避免检查后主线程恰好 spawn 的跨线程竞态。
  Atomics.compareExchange(state, 6, 0n, 2n);
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    // 监督者 /T 会沿刚启动的 server 祖先误杀缓存拥有者；独立清理器只按核对后的 PID 终止。
    cleanupOwnedProcesses([...children.values()], {
      supervisorPid: pid,
      bazelAdmissions,
      powershell:
        process.platform === "win32"
          ? windowsSystemToolPath("WindowsPowerShell/v1.0/powershell.exe")
          : undefined,
      detached: true,
    });
  };
  // 无后代时立即 SIGKILL 会丢掉异步 write；提交完成后再终止，但阻塞管道不能延长硬截止。
  const remaining = (limitSeconds - (level === "fastcheck" ? budgeted : total)) * 1000;
  const flushDeadline = setTimeout(terminate, Math.max(0, Math.min(25, remaining)));
  write(
    1,
    `${level}: TIMEOUT total=${total.toFixed(1)}s compile_excluded=${compileExcluded.toFixed(1)}s budgeted=${budgeted.toFixed(1)}s limit=${limitSeconds.toFixed(1)}s\n${JSON.stringify(report)}\n`,
    () => {
      clearTimeout(flushDeadline);
      terminate();
    },
  );
  if (remaining <= 0) terminate();
}
const timer = setInterval(() => {
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  const [, excludedMs, paused, sampledAt] = snapshot();
  const total = (now - startedAt) / 1000;
  const compileExcluded = (excludedMs + pendingExclusion(sampledAt, now, paused)) / 1000;
  const used = level === "fastcheck" ? total - compileExcluded : total;
  if (!cleanupStarted && Atomics.load(state, 5) !== 1n && used >= cleanupAt) {
    cleanupStarted = true;
    // 预留区间包含真实工作进程清理；server 生命周期不再是取消路径的一部分。
    forceTermination();
  }
  // 硬截止不等待报告管道；脱离监督者的清理器继续收口本轮工作。
  if (used >= limitSeconds) {
    forceTermination();
    clearInterval(timer);
    // CIM 枚举或脱离清理器卡住也不能延长总截止；这里只杀监督者自身，清理器继续执行。
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}, 25);
