import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// BEP is the sole source of target completion, timing, cache provenance and logs.
export async function parseBuildEventFile(path, targets) {
  const results = new Map();
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return results;
  }
  const actions = new Map();
  for (const line of text.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const label =
      event.id?.testResult?.label ??
      event.id?.testSummary?.label ??
      event.id?.targetCompleted?.label ??
      event.id?.actionCompleted?.label ??
      event.action?.label;
    const target = label?.replace(/^\/\/:/u, "");
    if (!targets.includes(target)) continue;
    const previous = results.get(target) ?? { cacheState: "incomplete", cached: false };
    if (event.action) {
      const action = event.action;
      const duration =
        action.endTime && action.startTime
          ? (Date.parse(action.endTime) - Date.parse(action.startTime)) / 1000
          : 0;
      actions.set(target, (actions.get(target) ?? 0) + duration);
      results.set(target, {
        ...previous,
        seconds: previous.testTarget ? previous.seconds : actions.get(target),
        logPath: previous.logPath ?? uriPath(action.stderr?.uri),
        actionExecuted: true,
      });
    }
    if (event.completed) {
      const test = event.children?.some((child) => child.testSummary);
      results.set(target, {
        ...previous,
        complete: !test,
        testTarget: Boolean(test),
        status: event.completed.success ? (test ? "NO_STATUS" : "PASSED") : "FAILED",
        seconds: actions.get(target) ?? 0,
        cached: false,
        cacheState: "incomplete",
      });
    }
    if (event.testResult) {
      const result = event.testResult;
      const cacheState = result.cachedLocally
        ? "localCache"
        : result.executionInfo?.cachedRemotely
          ? "diskCache"
          : "new";
      results.set(target, {
        ...previous,
        testTarget: true,
        status: result.status,
        cached: cacheState !== "new",
        cacheState,
        seconds: Number(result.testAttemptDurationMillis ?? 0) / 1000,
        logPath: uriPath(
          (result.testActionOutput ?? []).find((output) => output.name === "test.log")?.uri,
        ),
      });
    }
    if (event.testSummary) {
      const summary = event.testSummary;
      results.set(target, {
        ...previous,
        complete: true,
        status: summary.overallStatus,
        seconds: Number(summary.totalRunDurationMillis ?? (previous.seconds ?? 0) * 1000) / 1000,
      });
    }
  }
  return results;
}
const uriPath = (uri) => (uri?.startsWith("file:") ? fileURLToPath(uri) : undefined);
// BEP deliberately omits build-action cache provenance (bazelbuild/bazel#26211).
// The official execution log supplements provenance only, never PASS or timing.
export async function actionCacheStates(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const states = new Map();
  let depth = 0,
    start = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (!depth) start = index;
      depth++;
    }
    if (char !== "}" || --depth !== 0) continue;
    const spawn = JSON.parse(text.slice(start, index + 1));
    const target = spawn.targetLabel?.replace(/^\/\/:/u, "");
    if (!target) continue;
    const state = spawn.cacheHit ? "diskCache" : "new";
    if (!states.has(target) || state === "new") states.set(target, state);
  }
  return states;
}

// 只接受原生失败分类，不把语法、工具链或 IO 错误当成缓存 miss 后重试。
export async function isBazelCacheMiss(path, exitCode) {
  if (exitCode !== 1) return false;
  const text = await readFile(path, "utf8");
  let cacheMiss = false;
  let finished = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    // Bazel 9.3 的 ACTION_NOT_UP_TO_DATE 在 targetCompleted，不在 buildFinished。
    const detail =
      event.completed?.failureDetail ??
      event.action?.failureDetail ??
      event.finished?.failureDetail;
    if (detail) {
      if (detail.execution?.code !== "ACTION_NOT_UP_TO_DATE") return false;
      cacheMiss = true;
    }
    if (["ANALYSIS_FAILURE", "LOADING_FAILURE", "INTERNAL"].includes(event.aborted?.reason))
      return false;
    if (event.finished) finished = event.finished.exitCode?.code === 1;
  }
  return finished && cacheMiss;
}
