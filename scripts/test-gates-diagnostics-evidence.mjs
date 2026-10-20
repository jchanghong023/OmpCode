import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

// 原生证据读取与脱敏由此处唯一负责，诊断编排不复制解析或缓存来源判定。
const unzip = promisify(gunzip);
const numeric = (value) =>
  value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
const secret = /(?:token|password|passwd|credential|api[_-]?key|authorization|cookie|secret)/iu;
export function safeOptions(options) {
  let redactNext = false;
  return options.map((option) => {
    const text = String(option);
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    const equals = text.indexOf("=");
    const value = equals < 0 ? "" : text.slice(equals + 1);
    // Bazel environment/define options can contain another KEY=value pair.
    const nestedKey = value.includes("=") ? value.slice(0, value.indexOf("=")) : "";
    if (!secret.test(equals < 0 ? text : text.slice(0, equals)) && !secret.test(nestedKey))
      return text;
    if (equals >= 0) return `${text.slice(0, equals)}=[REDACTED]`;
    redactNext = true;
    return text;
  });
}
async function optionalText(path, issues) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") issues.push({ path, code: error.code ?? error.name });
    return null;
  }
}
export async function serverSnapshot(outputBase, issues) {
  const directory = join(outputBase, "server");
  const [pidText, cmdline, starttime] = await Promise.all(
    ["server.pid.txt", "cmdline", "server.starttime"].map((file) =>
      optionalText(join(directory, file), issues),
    ),
  );
  const pid = numeric(pidText?.trim());
  return {
    observedAt: new Date().toISOString(),
    outputBase,
    pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
    cmdline: cmdline === null ? null : safeOptions(cmdline.split("\0").filter(Boolean)),
    starttime: starttime?.trim() ?? null,
    files: { pid: join(directory, "server.pid.txt"), cmdline: join(directory, "cmdline") },
  };
}
// Chrome trace timestamps and durations are microseconds. Union across workers,
// never sum overlapping loading/analysis or launch/lock/wait spans.
function intervalUnionSeconds(intervals) {
  if (!intervals.length) return null;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let [start, end] = sorted[0];
  let duration = 0;
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      duration += end - start;
      [start, end] = [nextStart, nextEnd];
    }
  }
  return (duration + end - start) / 1e6;
}
function timingGroup(event) {
  const name = event.name ?? "";
  const category = event.cat ?? "";
  // Module callbacks and combined analysis/execution phases are not timing
  // evidence for lock waits or loading/analysis in isolation.
  if (
    /^(?:launch (?:blaze|bazel)|(?:acquir(?:e|ing)|waiting for|wait for) .*lock|(?:client|server|command) (?:launch|lock|wait)(?: time)?|wait(?:ing)? for (?:server|command|previous command))$/iu.test(
      name,
    ) ||
    /^(?:client launch|client wait|lock wait|command wait|launch|lock|wait)$/iu.test(category)
  )
    return "launchLockWait";
  if (
    /^(?:(?:loading|analysis)(?: phase)?|evalTargetPatterns|evaluate target patterns)$/iu.test(
      name,
    ) ||
    /^(?:packagecreation|package loading|package creation|package validity check|package function|analysis|analysis phase|loading|loading phase|configured target function|create configured target)$/iu.test(
      category,
    )
  )
    return "loadingAnalysis";
  return null;
}
export async function readProfileEvidence(path, issues = []) {
  try {
    const bytes = await readFile(path);
    const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? await unzip(bytes) : bytes;
    const profile = JSON.parse(text.toString("utf8"));
    const groups = { launchLockWait: [], loadingAnalysis: [] };
    const names = { launchLockWait: new Set(), loadingAnalysis: new Set() };
    const pending = new Map();
    const phaseMarkers = [];
    for (const event of profile.traceEvents ?? []) {
      if (event.cat === "build phase marker" && event.ph === "i" && numeric(event.ts) !== null)
        phaseMarkers.push(event);
      const key = `${event.pid}:${event.tid}`;
      if (event.ph === "B") {
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(event);
      }
      let span = event;
      if (event.ph === "E") {
        const start = pending.get(key)?.pop();
        if (!start) continue;
        span = { ...start, ph: "X", dur: event.ts - start.ts };
      }
      if (span.ph !== "X") continue;
      const group = timingGroup(span);
      const start = numeric(span.ts);
      const duration = numeric(span.dur);
      if (!group || start === null || duration === null || duration < 0) continue;
      groups[group].push([start, start + duration]);
      names[group].add(`${span.cat ?? ""}: ${span.name ?? ""}`);
    }
    // These native phase boundaries isolate target-pattern/loading work from
    // the following mixed loading/analysis/execution phase. Never attribute
    // that mixed phase's entire duration to analysis.
    phaseMarkers.sort((left, right) => left.ts - right.ts);
    let targetPatternsStart = null;
    for (const marker of phaseMarkers) {
      if (marker.name === "Evaluate target patterns") targetPatternsStart = Number(marker.ts);
      if (
        marker.name === "Load, analyze dependencies and build artifacts" &&
        targetPatternsStart !== null
      ) {
        groups.loadingAnalysis.push([targetPatternsStart, Number(marker.ts)]);
        names.loadingAnalysis.add(
          "build phase marker: Evaluate target patterns → Load, analyze dependencies and build artifacts",
        );
        targetPatternsStart = null;
      }
    }
    return {
      launchLockWaitSeconds: intervalUnionSeconds(groups.launchLockWait),
      loadingAnalysisSeconds: intervalUnionSeconds(groups.loadingAnalysis),
      matchedSpans: Object.fromEntries(
        Object.entries(groups).map(([key, spans]) => [
          key,
          { count: spans.length, names: [...names[key]] },
        ]),
      ),
      source: path,
    };
  } catch (error) {
    issues.push({ path, code: error.code ?? error.name });
    return { launchLockWaitSeconds: null, loadingAnalysisSeconds: null, source: path };
  }
}
export async function readBepEvidence(path, issues = []) {
  const text = await optionalText(path, issues);
  const result = {
    available: text !== null,
    finished: false,
    actionsExecuted: null,
    actionsDeclared: null,
    runnerTotal: null,
    actionCompletedEvents: 0,
    tests: {
      results: 0,
      localHits: 0,
      diskHits: 0,
      remoteHits: 0,
      unknownHits: 0,
      reruns: 0,
      retryAttempts: 0,
    },
    serverPid: null,
    buildToolVersion: null,
    binaryPath: null,
    startupOptions: null,
    explicitStartupOptions: null,
    commandOptions: null,
    explicitCommandOptions: null,
    timingMetrics: null,
    analysisBepSeconds: null,
    bepWallSeconds: null,
  };
  if (text === null) return result;
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      issues.push({ path, code: "PARTIAL_BEP_LINE" });
      continue;
    }
    if (event.started) {
      result.serverPid = numeric(event.started.serverPid);
      // 版本来自本次实际启动的 Bazel，不把请求的固定版本或安装元数据当作执行观测。
      result.buildToolVersion = event.started.buildToolVersion ?? null;
    }
    if (event.unstructuredCommandLine) {
      const binary = event.unstructuredCommandLine.args?.find((arg) =>
        arg.startsWith("--binary_path="),
      );
      result.binaryPath = binary?.slice("--binary_path=".length) ?? null;
    }
    if (event.finished) result.finished = true;
    if (event.optionsParsed) {
      const options = event.optionsParsed;
      result.startupOptions = safeOptions(options.startupOptions ?? []);
      result.explicitStartupOptions = safeOptions(options.explicitStartupOptions ?? []);
      result.commandOptions = safeOptions(options.cmdLine ?? []);
      result.explicitCommandOptions = safeOptions(options.explicitCmdLine ?? []);
    }
    if (event.buildMetrics) {
      const summary = event.buildMetrics.actionSummary;
      // Present proto3 messages omit numeric scalar defaults. An observed
      // actionSummary with no actionsExecuted is native zero, not missing data.
      result.actionsExecuted = summary ? numeric(summary.actionsExecuted ?? 0) : null;
      const declared = (summary?.actionData ?? []).map((action) =>
        numeric(action.actionsCreated ?? 0),
      );
      result.actionsDeclared = summary ? declared.reduce((sum, value) => sum + value, 0) : null;
      const total = summary?.runnerCount?.find((runner) => runner.name === "total");
      result.runnerTotal = total ? numeric(total.count ?? 0) : null;
      const timing = event.buildMetrics.timingMetrics;
      result.timingMetrics = timing ?? null;
      result.analysisBepSeconds = timing ? numeric(timing.analysisPhaseTimeInMs ?? 0) / 1000 : null;
      result.bepWallSeconds = timing ? numeric(timing.wallTimeInMs ?? 0) / 1000 : null;
    }
    if (event.action) result.actionCompletedEvents++;
    if (!event.testResult) continue;
    const identity = JSON.stringify(event.id?.testResult ?? event.id);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const test = event.testResult;
    result.tests.results++;
    if (test.cachedLocally) result.tests.localHits++;
    else if (test.executionInfo?.cachedRemotely) {
      const strategy = test.executionInfo.strategy ?? "";
      if (/^disk cache hit$/iu.test(strategy)) result.tests.diskHits++;
      else if (/^remote cache hit$/iu.test(strategy)) result.tests.remoteHits++;
      else result.tests.unknownHits++;
    } else result.tests.reruns++;
    if (numeric(event.id?.testResult?.attempt) > 1) result.tests.retryAttempts++;
  }
  return result;
}
