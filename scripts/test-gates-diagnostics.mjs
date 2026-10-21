import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readBepEvidence,
  readProfileEvidence,
  safeOptions,
  serverSnapshot,
} from "./test-gates-diagnostics-evidence.mjs";
import { bazelOutputBase } from "./test-gates-bazel-locations.mjs";

const seconds = (value) => (value === null ? "待定位" : `${value.toFixed(3)}s`);
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/gu, "_");
const sumKnown = (values) =>
  values.length && values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;

// This transport ID and every path below are diagnostic only: never use them
// in recipe/control/toolchain identities or in admission/cache decisions.
export async function createGateDiagnostics({
  outputBase = bazelOutputBase,
  // 已排除的源码目录中新建日志仍会使 glob 失效；证据留在源码树外且继续计时。
  inputsDir = outputBase,
} = {}) {
  const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const directory = join(inputsDir, "diagnostics", runId);
  await mkdir(directory, { recursive: true });
  const invocations = [];
  const phases = [];
  function recordPhase(id, phase, startedAt) {
    phases.push({ id, phase, seconds: (performance.now() - startedAt) / 1000 });
  }
  let sequence = 0;
  function createInvocationPaths(id) {
    const prefix = join(directory, `${String(++sequence).padStart(3, "0")}-${safeName(id)}`);
    return {
      bep: `${prefix}.bep.json`,
      profile: `${prefix}.profile.json.gz`,
      jsonexecution: `${prefix}.execution.json`,
      compactexecution: `${prefix}.execution.compact`,
      explain: `${prefix}.explain.log`,
      evidence: `${prefix}.invocation.json`,
    };
  }
  async function beginInvocation({
    id,
    command,
    args = [],
    env = {},
    paths = createInvocationPaths(id),
  }) {
    const issues = [];
    const before = await serverSnapshot(outputBase, issues);
    const commandIndex = args.findIndex((arg) =>
      ["build", "test", "info", "shutdown"].includes(arg),
    );
    const record = {
      id,
      runId,
      paths,
      command,
      args: safeOptions(args),
      env: { BAZEL_SH: env.BAZEL_SH ?? null },
      outputBase,
      before,
      requestedStartupOptions: safeOptions(
        args.slice(0, commandIndex < 0 ? args.length : commandIndex),
      ),
      mutuallyExclusiveExecutionLogs:
        args.some((arg) => arg.startsWith("--execution_log_json_file=")) &&
        args.some((arg) => arg.startsWith("--execution_log_compact_file=")),
      issues,
    };
    const persist = async () => {
      try {
        await writeFile(paths.evidence, `${JSON.stringify(record, null, 2)}\n`);
      } catch (error) {
        issues.push({ path: paths.evidence, code: error.code ?? error.name });
      }
    };
    // Start evidence survives a client failure. Its IO remains outside the client
    // interval, hence inside the gate's outer/diagnostic time.
    await persist();
    invocations.push(record);
    record.clientStartedAt = performance.now();
    record.clientStartedWall = new Date().toISOString();
    let completed;
    return {
      paths,
      finish({ exitCode = null, error } = {}) {
        if (completed) return completed;
        record.clientEndedAt = performance.now();
        record.elapsedSeconds = (record.clientEndedAt - record.clientStartedAt) / 1000;
        record.clientEndedWall = new Date().toISOString();
        record.exitCode = exitCode;
        // Error messages can contain tool arguments or environment credentials.
        if (error) record.error = { name: error.name, code: error.code ?? null };
        completed = (async () => {
          const [after, profile, bep] = await Promise.all([
            serverSnapshot(outputBase, issues),
            readProfileEvidence(paths.profile, issues),
            readBepEvidence(paths.bep, issues),
          ]);
          Object.assign(record, {
            after,
            profile,
            bep,
            clientMinusBepWallSeconds:
              bep.bepWallSeconds !== null ? record.elapsedSeconds - bep.bepWallSeconds : null,
            timingInterpretation:
              "Profile spans are unioned; BEP analysis is separate and not added to overlapping profile spans. Client minus BEP wall is a boundary difference, not lock-wait evidence.",
            stableServerPid:
              before.pid !== null && after.pid !== null ? before.pid === after.pid : null,
            stableServerCommandLine:
              before.cmdline !== null && after.cmdline !== null
                ? JSON.stringify(before.cmdline) === JSON.stringify(after.cmdline)
                : null,
            // Compact files are retained as native artifacts, not decoded or
            // misrepresented as JSON cache provenance by this diagnostics module.
            executionEvidence: {
              json: paths.jsonexecution,
              compact: paths.compactexecution,
              compactDecoded: false,
            },
          });
          await persist();
          return record;
        })();
        return completed;
      },
    };
  }
  async function summarize({ startedAt, log = console.log } = {}) {
    const complete = invocations.filter((record) => record.clientEndedAt !== undefined);
    const executionInvocations = [];
    const checkInvocations = [];
    const analysisInvocations = [];
    // 只读查询也会发出缓存 testResult；仅按本次明确旗标分组，避免重复计为真实测试。
    // 所有调用仍保留在 complete 中，完整计入耗时、加载/分析和原生证据。
    for (const record of complete) {
      if (record.args.includes("--nobuild")) {
        analysisInvocations.push(record);
        continue;
      }
      const records = record.args.includes("--check_tests_up_to_date")
        ? checkInvocations
        : executionInvocations;
      records.push(record);
    }
    const summarizeTests = (records) => ({
      testHits: sumKnown(
        records.map((record) =>
          record.bep?.available
            ? record.bep.tests.localHits +
              record.bep.tests.diskHits +
              record.bep.tests.remoteHits +
              record.bep.tests.unknownHits
            : null,
        ),
      ),
      testReruns: sumKnown(
        records.map((record) => (record.bep?.available ? record.bep.tests.reruns : null)),
      ),
      testLocalHits: sumKnown(
        records.map((record) => (record.bep?.available ? record.bep.tests.localHits : null)),
      ),
      testDiskHits: sumKnown(
        records.map((record) => (record.bep?.available ? record.bep.tests.diskHits : null)),
      ),
      testRemoteHits: sumKnown(
        records.map((record) => (record.bep?.available ? record.bep.tests.remoteHits : null)),
      ),
      testUnknownHits: sumKnown(
        records.map((record) => (record.bep?.available ? record.bep.tests.unknownHits : null)),
      ),
    });
    const summary = {
      runId,
      directory,
      invocationCount: invocations.length,
      launchLockWaitSeconds: sumKnown(
        complete.map((record) => record.profile?.launchLockWaitSeconds ?? null),
      ),
      loadingAnalysisSeconds: sumKnown(
        complete.map((record) => record.profile?.loadingAnalysisSeconds ?? null),
      ),
      analysisBepSeconds: sumKnown(
        complete.map((record) => record.bep?.analysisBepSeconds ?? null),
      ),
      bepWallSeconds: sumKnown(complete.map((record) => record.bep?.bepWallSeconds ?? null)),
      loadingAnalysisSource:
        "Union of native profile loading/analysis spans and target-pattern phase boundaries; separate BEP analysis may overlap and is not added.",
      actionsExecuted: sumKnown(complete.map((record) => record.bep?.actionsExecuted ?? null)),
      ...summarizeTests(executionInvocations),
      readOnlyTestChecks: {
        invocationCount: checkInvocations.length,
        ...summarizeTests(checkInvocations),
      },
      readOnlyAnalyses: { invocationCount: analysisInvocations.length },
      phases,
      clientSeconds: sumKnown(complete.map((record) => record.elapsedSeconds)),
      pnpmWallSeconds: null,
      invocations: complete.map((record) => record.paths.evidence),
    };
    const updateElapsed = () => {
      summary.totalSeconds = Number.isFinite(startedAt)
        ? (performance.now() - startedAt) / 1000
        : null;
      summary.outerSeconds =
        summary.totalSeconds !== null && summary.clientSeconds !== null
          ? summary.totalSeconds - summary.clientSeconds
          : null;
    };
    updateElapsed();
    try {
      await writeFile(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch (error) {
      summary.persistenceError = error.code ?? error.name;
    }
    updateElapsed();
    log(
      `[gate] 总耗时 ${seconds(summary.totalSeconds)} | 启动/锁等待 ${seconds(summary.launchLockWaitSeconds)} | 加载/分析 ${seconds(summary.loadingAnalysisSeconds)} | 实际动作 ${summary.actionsExecuted ?? "待定位"} | 测试命中/重跑 ${summary.testHits ?? "待定位"}/${summary.testReruns ?? "待定位"} (本地=${summary.testLocalHits ?? "待定位"} 磁盘=${summary.testDiskHits ?? "待定位"} 远端=${summary.testRemoteHits ?? "待定位"} 来源未观察=${summary.testUnknownHits ?? "待定位"}) | 只读查询 ${summary.readOnlyTestChecks.invocationCount}次 BEP命中/非缓存结果 ${summary.readOnlyTestChecks.testHits ?? "待定位"}/${summary.readOnlyTestChecks.testReruns ?? "待定位"} (不计实际测试) | 只读分析 ${summary.readOnlyAnalyses.invocationCount}次 | 外层耗时 ${seconds(summary.outerSeconds)}`,
    );
    updateElapsed();
    return summary;
  }
  return {
    runId,
    directory,
    invocations,
    createInvocationPaths,
    beginInvocation,
    recordPhase,
    summarize,
  };
}
