import { readFile } from "node:fs/promises";
import { fastPlan, fullPlan, slowPlan, installedOmp } from "./test-gates-plan.mjs";
import { regularStage, restorePackagingState } from "./test-gates-environments.mjs";
import { createGateRun } from "./test-gates-run.mjs";
import { createGateClock, gateBudget, snapshot, sameSnapshot } from "./test-gates-process.mjs";

const clock = createGateClock();
const args = process.argv.slice(2);
const level = args.shift();
const value = (flag) => args[args.indexOf(flag) + 1];
const authorized = args.includes("--human-authorized");
const knownFlags = new Set(["--human-authorized", "--plan", "--budget-seconds"]);
const valueFlags = new Set(["--budget-seconds"]);
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
  cleanup: restorePackagingState,
});
async function finish(status, code, extra = {}) {
  const report = await gate.finish(status, code, extra);
  process.exitCode = report.exitCode;
  return report;
}

async function validateToolchain() {
  const mise = await readFile("mise.toml", "utf8");
  const node = mise.match(/^node\s*=\s*"([^"]+)"/mu)?.[1];
  const pnpm = mise.match(/^pnpm\s*=\s*"([^"]+)"/mu)?.[1];
  if (process.versions.node !== node)
    throw new Error(
      `Node ${node} required; current ${process.versions.node}. Use mise's existing toolchain; no automatic install.`,
    );
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
  // 用户明确限定 AI 只测 Windows；拒绝非 Windows 运行，不能退回已取消的 Linux 测试路径。
  if (process.platform !== "win32")
    throw new Error("AI testing is Windows-only; run these gates on Windows");
  if (level === "--self-test") {
    await (await import("./test-gates-selftest.mjs")).selfTest();
    await finish("PASS", 0);
  } else {
    if (!["fastcheck", "fulltest", "slowtest", "--snapshot"].includes(level))
      throw new Error(
        "Use pnpm fastcheck|fulltest|slowtest; --plan is read-only; --self-test uses only temporary stubs",
      );
    for (let index = 0; index < args.length; index++) {
      if (!knownFlags.has(args[index])) throw new Error(`Unknown gate argument: ${args[index]}`);
      if (valueFlags.has(args[index]) && !args[++index]) throw new Error("Missing flag value");
    }
    const planOnly = args.includes("--plan");
    if (["fulltest", "slowtest"].includes(level) && !planOnly && !authorized) {
      await finish("NOT RUN — HUMAN AUTHORIZATION REQUIRED", 2);
    } else {
      const tools = await validateToolchain();
      const source = await snapshot();
      if (level === "--snapshot") {
        await finish("PASS", 0, { snapshot: source, tools });
      } else {
        const stages = await (level === "fastcheck"
          ? fastPlan()
          : level === "slowtest"
            ? slowPlan()
            : fullPlan());
        if (planOnly) {
          console.log(
            JSON.stringify(
              {
                snapshot: source,
                tools,
                limitSeconds: budget,
                concurrency: 3,
                stages,
              },
              null,
              2,
            ),
          );
          await finish("PLAN ONLY — NOT RUN", 0);
        } else {
          const context = {
            snapshot: source,
            omp: await installedOmp(),
            guiProcesses: new Map(),
          };
          console.log(
            JSON.stringify({
              snapshot: source,
              tools,
              cache: "existing cache; cold cache not verified",
            }),
          );
          const report = await gate.run(
            stages,
            (stage) => regularStage(stage, context),
            async (records) => {
              const current = await snapshot();
              if (!sameSnapshot(source, current))
                records.push({
                  id: "source-snapshot",
                  status: "UNVERIFIED_MISSING_ENV",
                  reason: "Source changed during validation; results belong to different snapshots",
                });
              return { snapshot: source, tools };
            },
          );
          process.exitCode = report.exitCode;
        }
      }
    }
  }
} catch (error) {
  await finish("FAIL", 1, { reason: error.message });
}
