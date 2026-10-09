import { readFile } from "node:fs/promises";
import { fastPlan, fullPlan, installedOmp } from "./test-gates-plan.mjs";
import { environmentConfig, regularStage } from "./test-gates-environments.mjs";
import {
  elapsed,
  stageResult,
  snapshot,
  sameSnapshot,
  stopAll,
  startBudget,
  cancelCommands,
} from "./test-gates-process.mjs";

const started = performance.now();
const args = process.argv.slice(2);
const level = args.shift();
const value = (flag) => args[args.indexOf(flag) + 1];
const authorized = args.includes("--human-authorized");
const knownFlags = new Set(["--human-authorized", "--plan", "--budget-seconds"]);
const valueFlags = new Set(["--budget-seconds"]);
let timer;
let finishing = false;

async function finish(status, code, extra = {}) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  await stopAll();
  console.log(`${level}: ${status}, ${elapsed(started)}s`);
  console.log(JSON.stringify({ level, status, seconds: Number(elapsed(started)), ...extra }));
  process.exitCode = code;
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

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    cancelCommands();
    await finish("CANCELLED", 130);
    process.exit(130);
  });

try {
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
      if (level === "fastcheck" && !planOnly) {
        const budget = args.includes("--budget-seconds") ? Number(value("--budget-seconds")) : 60;
        // 为 Windows taskkill 留出最多四秒；不得等满一分钟后再开始清理进程。
        timer = startBudget(budget, started, async () => {
          await finish("TIMEOUT", 124, { budgetSeconds: budget });
          process.exit(124);
        });
      }
      const tools = await validateToolchain();
      const source = await snapshot();
      if (level === "--snapshot") {
        await finish("PASS", 0, { snapshot: source, tools });
      } else {
        const stages = level === "fastcheck" ? await fastPlan() : await fullPlan();
        if (planOnly) {
          console.log(JSON.stringify({ snapshot: source, tools, stages }, null, 2));
          await finish("PLAN ONLY — NOT RUN", 0);
        } else {
          const context = {
            snapshot: source,
            omp: await installedOmp(),
            environments: await environmentConfig(),
            guiProcesses: new Map(),
            records: [],
          };
          console.log(
            JSON.stringify({
              snapshot: source,
              tools,
              cache: "existing cache; cold cache not verified",
            }),
          );
          for (const stage of stages) {
            const result = await stageResult(stage, async () => {
              if (stage.unknownGui)
                return {
                  status: "UNVERIFIED_MISSING_ENV",
                  reason:
                    "New GUI entry needs its original fixture/phase mapping before full coverage can be claimed",
                };
              return await regularStage(stage, context);
            });
            context.records.push(result);
            if (level === "fastcheck" && result.status !== "PASS") break;
          }
          const current = await snapshot();
          if (!sameSnapshot(source, current))
            context.records.push({
              id: "source-snapshot",
              status: "UNVERIFIED_MISSING_ENV",
              reason: "Source changed during validation; results belong to different snapshots",
            });
          const passed = context.records.every(
            (record) => record.status === "PASS" || record.status === "SKIPPED_NOT_APPLICABLE",
          );
          const failed = context.records.some((record) => record.status === "FAIL");
          await finish(
            passed ? "PASS" : failed ? "FAIL" : "UNVERIFIED — REQUIRED ENVIRONMENT UNAVAILABLE",
            passed ? 0 : 1,
            { snapshot: source, tools, stages: context.records },
          );
        }
      }
    }
  }
} catch (error) {
  await finish("FAIL", 1, { reason: error.message });
}
