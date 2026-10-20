import { readFile } from "node:fs/promises";
import { fastPlan, fullPlan, slowPlan, installedOmp } from "./test-gates-plan.mjs";
import { restorePackagingState, snapshotPackagingState } from "./test-gates-environments.mjs";
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

const clock = createGateClock();
// scoped package scripts 也从统一仓库根执行，避免相对 mise/manifest 路径落到 desktop 包。
process.chdir(repositoryRoot);
const args = process.argv.slice(2);
const level = args.shift();
const value = (flag) => args[args.indexOf(flag) + 1];
const authorized = args.includes("--human-authorized");
const knownFlags = new Set(["--human-authorized", "--plan", "--budget-seconds"]);
const valueFlags = new Set(["--budget-seconds"]);
const buildOnly = ["build", "bootstrap"].includes(level);
if (buildOnly) {
  knownFlags.add("--target");
  valueFlags.add("--target");
}
const validLevel = ["fastcheck", "fulltest", "slowtest"].includes(level);
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
  authorized,
  timed: validLevel && !args.includes("--plan") && !argumentError,
  // Bazel 运行期控制文件只在本轮内存活；收尾与打包状态恢复共用同一清理链。
  cleanup: async () => {
    try {
      await restorePackagingState();
    } finally {
      // 恢复失败仍须删除本轮含运行环境的控制文件；原恢复错误继续使门禁失败。
      await cleanupBazelInputs();
    }
  },
});
async function finish(status, code, extra = {}) {
  const report = await gate.finish(status, code, extra);
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
    if (["fulltest", "slowtest"].includes(level) && !planOnly && !authorized) {
      await finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
    } else {
      const progress = (message) => {
        if (!planOnly && level !== "--snapshot") console.log(`[gate] ${message}`);
      };
      progress("preparation begin: toolchain");
      const tools = await validateToolchain();
      if (!planOnly && level !== "--snapshot") {
        progress("toolchain verified; synchronizing generated Bazel graph");
        await import("./test-gates-bazel-sync.mjs");
      }
      progress("source snapshot begin");
      const source = await snapshot();
      progress("source snapshot complete");
      if (level === "--snapshot") {
        await finish("PASS", 0, { snapshot: source, tools });
      } else {
        const rawStages = buildOnly
          ? await (
              await import("./test-gates-workspace-plan.mjs")
            ).workspaceBuildPlan({
              bootstrap: level === "bootstrap",
              target: args.includes("--target") ? value("--target") : undefined,
            })
          : await (level === "fastcheck"
              ? fastPlan()
              : level === "slowtest"
                ? slowPlan()
                : fullPlan());
        // Every risk group is native; Bazel owns all target execution and reuse.
        const stages = planOnly ? rawStages : bazelizeStages(rawStages);
        if (planOnly) {
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
        } else {
          const context = {
            clock: gate.clock,
            snapshot: source,
            nativeStages: stages.flatMap((stage) => stage.bazel.stages),
            omp: await installedOmp(),
            guiProcesses: new Map(),
          };
          progress(`plan ready stages=${stages.length} installedOmp=${Boolean(context.omp)}`);
          const bazelInfo = await assertBazelReady();
          progress(`bazel ready path=${bazelInfo.path} version=${bazelInfo.version}`);
          console.log(
            JSON.stringify({
              snapshot: source,
              tools,
              ...(bazelInfo.path ? { bazel: bazelInfo } : {}),
              cache: "existing cache; cold cache not verified",
            }),
          );
          const report = await gate.run(
            async (records, onFailure) => {
              let cachedValidated = false;
              if (level === "fulltest" && stages.length > 1) {
                const cacheable = context.nativeStages.filter((target) => !isUncachedStage(target));
                const cached = await runBazelStage(
                  {
                    id: "bazel-cached-gate",
                    bazel: { stages: cacheable, localTestJobs: 4, cacheOnly: true },
                  },
                  context,
                  onFailure,
                );
                if (cached.status !== "CACHE_MISS") {
                  records.push({ ...cached, id: "bazel-cached-gate" });
                  if (cached.status !== "PASS") return;
                  cachedValidated = true;
                }
              }
              if (cachedValidated) {
                // Only a complete native cache proof admits this parallel group.
                // All three fulltest mandatory targets have no declared dependencies;
                // the original risk-group barriers remain intact on every cache miss.
                const mandatory = stages.flatMap((stage) =>
                  stage.bazel.stages
                    .filter(isUncachedStage)
                    .map((target) => ({ target, stageId: stage.id })),
                );
                if (!mandatory.length) return;
                const runnable = {
                  id: "bazel-mandatory-gate",
                  bazel: { stages: mandatory.map(({ target }) => target), localTestJobs: 4 },
                };
                if (mandatory.some(({ target }) => target.packaging))
                  await snapshotPackagingState();
                const result = await runBazelStage(runnable, context, (failure) =>
                  onFailure({
                    ...failure,
                    id:
                      mandatory.find(({ target }) => target.id === failure.targetId)?.stageId ??
                      runnable.id,
                  }),
                );
                for (const stageId of new Set(mandatory.map((entry) => entry.stageId))) {
                  const ids = new Set(
                    mandatory
                      .filter((entry) => entry.stageId === stageId)
                      .map(({ target }) => target.id),
                  );
                  const targets = result.targets.filter((target) => ids.has(target.id));
                  if (!records.some((record) => record.id === stageId))
                    records.push({
                      ...result,
                      id: stageId,
                      status:
                        targets.length === ids.size &&
                        targets.every((target) => target.status === "PASS")
                          ? "PASS"
                          : "FAIL",
                      seconds: targets.reduce((seconds, target) => seconds + target.seconds, 0),
                      targets,
                      slowTargets: result.slowTargets?.filter((target) => ids.has(target.id)),
                    });
                }
                // A nonzero Bazel exit must fail even if individual targets passed.
                if (result.status !== "PASS" && !records.some((record) => record.status === "FAIL"))
                  records.push({ ...result, id: runnable.id });
                return;
              }
              for (const stage of stages) {
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
              requiredTargets: stages.flatMap((stage) =>
                (stage.bazel?.stages ?? []).map((target) => target.id),
              ),
            },
            async (records) => {
              progress("source snapshot verification begin");
              const current = await snapshot();
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
  }
} catch (error) {
  await finish("FAIL", 1, { reason: error.message });
}
