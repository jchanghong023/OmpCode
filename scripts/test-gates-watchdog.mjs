import { workerData, parentPort } from "node:worker_threads";
import { readFileSync, write } from "node:fs";
import { spawn } from "node:child_process";
import { killByOutputBaseMarker } from "./test-gates-bazel-runtime.mjs";
import { dirname, resolve } from "node:path";
import { gatesInputsDir } from "./test-gates-bazel-locations.mjs";
import { windowsSystemToolPath } from "./test-gates-process.mjs";

// Bazel owns target timeouts. This worker owns only the whole-run deadline,
// including a blocked supervisor event loop or blocked final-report destination.
const { shared, level, limitSeconds, startedAt, pid } = workerData;
const state = new BigInt64Array(shared);
let paths = [];
let usedNativeTargets = false;
const cleanupAt = limitSeconds - Math.min(5, limitSeconds * 0.5);
let cleanupStarted = false;
parentPort.on("message", (message) => {
  if (message.paths) {
    paths = message.paths;
    usedNativeTargets ||= paths.some((path) => dirname(resolve(path)) === gatesInputsDir);
  }
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
  forced = true;
  clearInterval(timer);
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  const [, excludedMs, paused, sampledAt] = snapshot();
  const total = (now - startedAt) / 1000;
  const compileExcluded = (excludedMs + pendingExclusion(sampledAt, now, paused)) / 1000;
  const budgeted = total - compileExcluded;
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
  // Never await the destination: a blocked report pipe is itself a deadline
  // case. The OS tree kill must proceed even when this best-effort write stalls.
  write(
    1,
    `${level}: TIMEOUT total=${total.toFixed(1)}s compile_excluded=${compileExcluded.toFixed(1)}s budgeted=${budgeted.toFixed(1)}s limit=${limitSeconds.toFixed(1)}s\n${JSON.stringify(report)}\n`,
    () => {},
  );
  if (process.platform === "win32") {
    const killer = spawn(windowsSystemToolPath("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    killer.unref();
  } else {
    // Windows taskkill /T covers owned descendants as well as the supervisor.
    process.kill(pid, "SIGKILL");
  }
}
const timer = setInterval(() => {
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  const [, excludedMs, paused, sampledAt] = snapshot();
  const total = (now - startedAt) / 1000;
  const compileExcluded = (excludedMs + pendingExclusion(sampledAt, now, paused)) / 1000;
  const used = level === "fastcheck" ? total - compileExcluded : total;
  if (!cleanupStarted && used >= cleanupAt) {
    cleanupStarted = true;
    // Give the detached-server marker cleanup its existing reserve first.
    // Once it settles, terminate the remaining supervisor tree immediately.
    if (usedNativeTargets) void killByOutputBaseMarker().then(forceTermination, forceTermination);
    else forceTermination();
  }
  // Last-resort fallback must not await a hung marker scan or report sink.
  if (used >= limitSeconds) forceTermination();
}, 25);
