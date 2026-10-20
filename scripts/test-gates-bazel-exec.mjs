import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gatesInputsDir } from "./test-gates-bazel-locations.mjs";
import { prepareBazelEnvironment } from "./test-gates-bazel-runtime.mjs";
import { createGateClock } from "./test-gates-clock.mjs";
import { regularStage } from "./test-gates-environments.mjs";
import { stopAll } from "./test-gates-process.mjs";

const target = process.argv[process.argv.indexOf("--stage") + 1];
if (!target?.startsWith("gate-")) throw new Error("gate exec requires --stage <target>");
const control = JSON.parse(await readFile(join(gatesInputsDir, `${target}.json`), "utf8"));
const stage = control.stage;
const runtime = await prepareBazelEnvironment(stage, control);
const clock = createGateClock();
let failed = false;
const onFailure = (result) => {
  if (failed) return;
  failed = true;
  appendFileSync(
    join(gatesInputsDir, `${target}.live`),
    `\u001eOMP_TEST_FAILURE ${JSON.stringify({ name: stage.id, error: result.reason ?? result.status })}\n`,
  );
};
let result;
const kindFrame = (event) =>
  appendFileSync(
    join(gatesInputsDir, `${target}.live`),
    `\u001eOMP_GATE_KIND ${JSON.stringify({ event, kind: stage.kind, time: Number(process.hrtime.bigint() / 1_000_000n) })}\n`,
  );
kindFrame("start");
try {
  // Lifecycle commands invoke the existing serial suite owner; all other recipes
  // use the original setup/packaging/node-test semantics, not a raw spawn clone.
  result = await regularStage(stage, {
    clock,
    omp: runtime.omp,
    guiProcesses: new Map(),
    onFailure,
  });
  if (result.status !== "PASS") onFailure(result);
} catch (error) {
  result = { status: "FAIL", reason: error.stack ?? String(error) };
  onFailure(result);
  console.error(result.reason);
} finally {
  await stopAll(clock);
  kindFrame("end");
}
process.exitCode = result?.status === "PASS" && !failed ? 0 : 1;
