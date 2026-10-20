import { readFile } from "node:fs/promises";
import { fastPlan, fullPlan, slowPlan, installedOmp } from "./test-gates-plan.mjs";
import { restorePackagingState, snapshotPackagingState } from "./test-gates-command-stage.mjs";
import {
  bazelizeStages,
  assertBazelReady,
  runBazelStage,
  cleanupBazelInputs,
  isUncachedStage,
} from "./test-gates-bazel.mjs";
import { createGateRun } from "./test-gates-run.mjs";
import { snapshot, sameSnapshot } from "./test-gates-snapshot.mjs";
import { createGateClock, gateBudget } from "./test-gates-clock.mjs";
import { repositoryRoot } from "./test-gates-bazel-locations.mjs";
import { createGateDiagnostics } from "./test-gates-diagnostics.mjs";
import { ensureBazelGraph, graphStage } from "./test-gates-bazel-graph.mjs";

const startedAt = performance.now();
const clock = createGateClock(startedAt);
let diagnostics;
const diagnosticReport = {};
// scoped package scripts 也从统一仓库根执行，避免相对 mise/manifest 路径落到 desktop 包。
process.chdir(repositoryRoot);
const args = process.argv.slice(2);
const level = args.shift();
const value = (flag) => args[args.indexOf(flag) + 1];
const authorized = args.includes("--human-authorized");
const knownFlags = new Set([
  "--human-authorized",
  "--plan",
  "--budget-seconds",
  "--cache-debug",
  "--check-tests-up-to-date",
]);
const valueFlags = new Set(["--budget-seconds"]);
const buildOnly = ["build", "bootstrap"].includes(level);
if (buildOnly) {
  knownFlags.add("--target");
  valueFlags.add("--target");
}
const validLevel = ["fastcheck", "fulltest", "slowtest"].includes(level);
// 同一个明确模式同时控制两层准入和执行分支，不能借只读旗标放行普通 full/slow。
const diagnosticOnly =
  (validLevel || buildOnly) &&
  args.includes("--check-tests-up-to-date") &&
  !args.includes("--plan");
let budget = validLevel ? gateBudget(level) : null;
let argumentError;
try {
  if (validLevel && args.includes("--budget-seconds"))
    budget = gateBudget(level, Number(value("--budget-seconds")));
} catch (error) {
  argumentError = error;
}
const gate = createGateRun({
  level,
  limitSeconds: budget,
  clock,
  authorized: authorized || diagnosticOnly,
  timed: validLevel && !args.includes("--plan") && !argumentError,
  // Bazel 运行期控制文件只在本轮内存活；收尾与打包状态恢复共用同一清理链。
  cleanup: async () => {
    try {
      await restorePackagingState();
    } finally {
      // 恢复失败仍须删除本轮含运行环境的控制文件；原恢复错误继续使门禁失败。
      await cleanupBazelInputs();
      if (diagnostics) Object.assign(diagnosticReport, await diagnostics.summarize({ startedAt }));
    }
  },
});
async function finish(status, code, extra = {}) {
  const report = await gate.finish(status, code, { ...extra, diagnostics: diagnosticReport });
  process.exitCode = report.exitCode;
  if (report.exitCode !== 0) process.exit(report.exitCode);
  return report;
}

async function validateToolchain() {
  const mise = await readFile("mise.toml", "utf8");
  const pnpm = mise.match(/^pnpm\s*=\s*"([^"]+)"/mu)?.[1];
  // mise 的 Node 固定值是复现基线，不是兼容边界；精确比较曾在系统升级后阻止所有检查。
  // Node 支持范围沿用 package.json，门禁使用并记录实际运行时，保留 pnpm 版本校验。
  const agent = process.env.npm_config_user_agent;
  if (agent && !agent.startsWith(`pnpm/${pnpm} `))
    throw new Error(`pnpm ${pnpm} required; current ${agent.split(" ")[0]}`);
  return {
    node: process.versions.node,
    pnpm: agent?.split(" ")[0] ?? "not invoked through pnpm",
    platform: process.platform,
    arch: process.arch,
  };
}

// Signals and owned-process cleanup share the reusable lifecycle.

try {
  if (argumentError) throw argumentError;
  // 测试门禁仅限 Windows；普通 workspace build 保留原跨平台能力。
  if (!buildOnly && process.platform !== "win32")
    throw new Error("AI testing is Windows-only; run these gates on Windows");
  if (level === "--self-test") {
    await (await import("./test-gates-selftest.mjs")).selfTest();
    await finish("PASS", 0);
  } else {
    if (!["fastcheck", "fulltest", "slowtest", "build", "bootstrap", "--snapshot"].includes(level))
      throw new Error(
        "Use pnpm fastcheck|fulltest|slowtest|build; --plan is read-only; --self-test uses isolated fixtures",
      );
    for (let index = 0; index < args.length; index++) {
      if (!knownFlags.has(args[index])) throw new Error(`Unknown gate argument: ${args[index]}`);
      if (valueFlags.has(args[index]) && !args[++index]) throw new Error("Missing flag value");
    }
    const planOnly = args.includes("--plan");
    if (["fulltest", "slowtest"].includes(level) && !planOnly && !diagnosticOnly && !authorized) {
      await finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
    } else {
      const progress = (message) => {
        if (!planOnly && level !== "--snapshot") console.log(`[gate] ${message}`);
      };
      const prepare = async (name, operation) => {
        const started = performance.now();
        try {
          return await operation();
        } finally {
          progress(
            `preparation ${name} seconds=${((performance.now() - started) / 1000).toFixed(3)}`,
          );
        }
      };
      progress("preparation begin: toolchain");
      const tools = await prepare("toolchain", validateToolchain);
      const readOnly = planOnly || level === "--snapshot";
      const plan = async () =>
        buildOnly
          ? (await import("./test-gates-workspace-plan.mjs")).workspaceBuildPlan({
              bootstrap: level === "bootstrap",
              target: args.includes("--target") ? value("--target") : undefined,
            })
          : level === "fastcheck"
            ? fastPlan()
            : level === "slowtest"
              ? slowPlan()
              : fullPlan();
      if (readOnly) {
        progress("source snapshot begin");
        const source = await prepare("snapshot", snapshot);
        progress("source snapshot complete");
        if (level === "--snapshot") {
          await finish("PASS", 0, { snapshot: source, tools });
        } else {
          const stages = await plan();
          console.log(
            JSON.stringify(
              {
                snapshot: source,
                tools,
                limitSeconds: budget,
                concurrency: 4,
                stages,
              },
              null,
              2,
            ),
          );
          await finish("PLAN ONLY — NOT RUN", 0);
        }
      } else {
        // 图生成与产品门禁共用一次生命周期，失败、取消及预算均保留原生证据。
        diagnostics = await createGateDiagnostics();
        const context = {
          clock: gate.clock,
          guiProcesses: new Map(),
          cacheDebug: args.includes("--cache-debug"),
          diagnostics,
        };
        const source = {};
        const bazelInfo = {};
        const requiredTargets = [graphStage.id];
        const report = await gate.run(
          async (records, onFailure) => {
            progress(
              diagnosticOnly
                ? "toolchain verified; checking generated Bazel graph"
                : "toolchain verified; synchronizing generated Bazel graph",
            );
            const generated = await prepare("graph", () =>
              ensureBazelGraph(context, { readOnly: diagnosticOnly }),
            );
            records.push({ ...generated, id: graphStage.id });
            if (generated.status !== "PASS") {
              if (diagnosticOnly)
                await finish(
                  generated.status === "CACHE_MISS" ? "DIAGNOSTIC_OUT_OF_DATE" : "FAIL",
                  1,
                  { query: generated },
                );
              return;
            }
            progress("source snapshot begin");
            Object.assign(source, await prepare("snapshot", snapshot));
            context.snapshot = source;
            progress("source snapshot complete");
            const stages = bazelizeStages(await plan());
            context.nativeStages = stages.flatMap((stage) => stage.bazel.stages);
            context.omp = await prepare("omp-discovery", installedOmp);
            requiredTargets.push(...context.nativeStages.map((target) => target.id));
            progress(`plan ready stages=${stages.length} installedOmp=${Boolean(context.omp)}`);
            Object.assign(bazelInfo, await prepare("bazel-discovery", assertBazelReady));
            progress(`bazel ready path=${bazelInfo.path} version=${bazelInfo.version}`);
            console.log(
              JSON.stringify({
                snapshot: source,
                tools,
                bazel: bazelInfo,
                cache: "existing cache; cold cache not verified",
              }),
            );
            if (diagnosticOnly) {
              const query = await runBazelStage(
                {
                  id: "bazel-diagnostic-query",
                  bazel: {
                    stages: context.nativeStages.filter((stage) => !isUncachedStage(stage)),
                    localTestJobs: 4,
                    cacheOnly: true,
                  },
                },
                context,
              );
              records.push({ ...query, id: "bazel-diagnostic-query" });
              await finish(
                query.status === "PASS"
                  ? "DIAGNOSTIC_UP_TO_DATE"
                  : query.status === "CACHE_MISS"
                    ? "DIAGNOSTIC_OUT_OF_DATE"
                    : "FAIL",
                query.status === "PASS" ? 0 : 1,
                { query },
              );
              return;
            }
            let scheduled = stages;
            if (level === "fulltest" && context.omp) {
              // 上次失败会关闭 server；遗留 stable-status 文件不代表新 server 已执行其原生动作。
              // 保留原静态准入，用真实执行初始化，再查询剩余目标，不能吞掉查询错误。
              const first = stages[0];
              const checked = await runBazelStage(first, context, (failure) =>
                onFailure({ ...failure, id: first.id }),
              );
              if (!records.some((record) => record.id === first.id))
                records.push({ ...checked, id: first.id });
              if (checked.status !== "PASS") return;
              scheduled = stages.slice(1);
              const remaining = scheduled.flatMap((group) => group.bazel.stages);
              // 只读命中仅决定调度；验收仍来自覆盖剩余完整目标的普通 bazel test。
              const probe = await runBazelStage(
                {
                  id: "bazel-native-cache-probe",
                  bazel: {
                    stages: remaining.filter((target) => !isUncachedStage(target)),
                    localTestJobs: 2,
                    cacheOnly: true,
                  },
                },
                context,
              );
              if (probe.status === "FAIL")
                throw new Error(
                  `Native cache probe failed; evidence=${probe.bepPath ?? probe.reason}`,
                );
              if (probe.status === "PASS")
                scheduled = [
                  {
                    id: "bazel-native-fulltest",
                    bazel: { stages: remaining, localTestJobs: 2 },
                  },
                ];
            }
            for (const stage of scheduled) {
              const targets = stage.bazel.stages;
              if (!targets.length) continue;
              const runnable = { ...stage, bazel: { ...stage.bazel, stages: targets } };
              // executor 会被取消强杀；外层必须在准入前持有共享模板原文，
              // gate.finish 在所属进程树停止后恢复，不能只依赖 executor finally。
              if (stage.bazel.stages.some((target) => target.packaging))
                await snapshotPackagingState();
              const result = await runBazelStage(runnable, context, (failure) =>
                onFailure({ ...failure, id: stage.id }),
              );
              if (!records.some((record) => record.id === stage.id))
                records.push({ ...result, id: stage.id });
              if (result.status !== "PASS" || records.some((record) => record.status === "FAIL"))
                break;
            }
          },
          {
            snapshot: source,
            tools,
            bazel: bazelInfo,
            diagnostics: diagnosticReport,
            requiredTargets,
          },
          async (records) => {
            progress("source snapshot verification begin");
            const current = await prepare("snapshot-verification", snapshot);
            if (!sameSnapshot(source, current))
              records.push({
                id: "source-snapshot",
                status: "UNVERIFIED_MISSING_ENV",
                reason: "Source changed during validation; results belong to different snapshots",
              });
            progress("source snapshot verification complete");
          },
        );
        process.exitCode = report.exitCode;
        if (report.exitCode !== 0) process.exit(report.exitCode);
      }
    }
  }
} catch (error) {
  // 入口自检直接在此抛错；堆栈随首异常报告一次，不被后续 cleanup 错误替代。
  await finish("FAIL", 1, { reason: error.message, stack: error.stack });
}
