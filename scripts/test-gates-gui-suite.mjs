import { writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { createGateClock } from "./test-gates-clock.mjs";
import { fixtureStage } from "./test-gates-environments.mjs";
import { fullPlan, installedOmp } from "./test-gates-plan.mjs";
import { createGateRun } from "./test-gates-run.mjs";

// Bazel owns this whole lifecycle result. The outer gate owns its deadline and
// prepared environment; fixtureStage still owns the real GUI and exit barriers.
const clock = createGateClock();
const run = createGateRun({ level: "gui-suite", clock, timed: false, limitSeconds: null });
let suite;
let failureReported = false;
const reportFailure = (stage, result) => {
  if (failureReported) return;
  failureReported = true;
  writeSync(
    2,
    `\u001eOMP_TEST_FAILURE ${JSON.stringify({
      name: stage?.id ?? `gui-suite-${suite ?? "unknown"}`,
      fullName: stage?.id ?? `gui-suite-${suite ?? "unknown"}`,
      error: result.reason ?? `GUI lifecycle returned ${result.status}`,
    })}\n`,
  );
};

let result;
try {
  ({
    values: { suite },
  } = parseArgs({ options: { suite: { type: "string" } } }));
  if (!suite) throw new Error("GUI suite runner requires --suite <suite>");
  const stages = (await fullPlan()).filter((stage) => stage.fixture && stage.suite === suite);
  if (!stages.length) throw new Error(`Unknown GUI suite: ${suite}`);
  const context = {
    clock,
    omp: await installedOmp(),
    guiProcesses: new Map(),
    preparedEnv: process.env,
  };
  result = await run.run(
    async (records, onFailure) => {
      for (const stage of stages) {
        const fail = (failure) => {
          reportFailure(stage, failure);
          onFailure({ ...failure, id: stage.id });
        };
        try {
          const phase = await fixtureStage(stage, { ...context, onFailure: fail });
          if (!records.some((record) => record.id === stage.id))
            records.push({ ...phase, id: stage.id });
          if (phase.status !== "PASS") fail(phase);
          if (failureReported) break;
        } catch (error) {
          fail({ status: "FAIL", exitCode: 1, reason: error.stack ?? String(error) });
          break;
        }
      }
    },
    { suite },
  );
} catch (error) {
  const reason = error.stack ?? String(error);
  reportFailure(undefined, { status: "FAIL", reason });
  result = await run.finish("FAIL", 1, { suite, reason });
}
// Includes failures from the existing owner's final stopAll/cleanup path: a
// successful phase list alone must never turn failed process cleanup into PASS.
if (result.status !== "PASS") reportFailure(undefined, result);
process.exitCode = result.status === "PASS" ? 0 : result.exitCode || 1;
