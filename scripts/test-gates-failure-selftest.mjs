import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";

export async function exerciseFirstFailure(
  run,
  level,
  { childPid, blocked, streamFirstSeen, streamNoiseSeen },
) {
  for (const scenario of [
    "parallel-failure",
    "compiler-output-failure",
    ...(level === "fastcheck"
      ? []
      : ["nested-failure", "out-of-order-files", "concurrent-test-failure"]),
  ]) {
    await rm(childPid, { force: true });
    await rm(blocked, { force: true });
    const failedFast = await run(level, scenario, 10);
    assert.notEqual(failedFast.code, 0);
    assert.equal(failedFast.report.status, "FAIL");
    assert.ok(failedFast.report.budgeted < failedFast.report.limitSeconds, failedFast.output);
    const peerPid = Number(await readFile(childPid, "utf8"));
    assert.throws(() => process.kill(peerPid, 0), `${level}/${scenario}: owned peer survived`);
    await assert.rejects(
      () => readFile(blocked),
      { code: "ENOENT" },
      `${level}/${scenario} must not start the queued fifth stage: ${failedFast.output}`,
    );
    assert.equal(
      failedFast.report.stages.some((stage) => stage.id === "must-not-start"),
      false,
    );
    const trigger = failedFast.report.stages[0];
    assert.equal(trigger.status, "FAIL");
    if (scenario === "parallel-failure") assert.equal(trigger.exitCode, 7);
    else if (scenario === "compiler-output-failure")
      assert.match(trigger.reason, /error TS9999: FIRST_COMPILER_FAILURE/u);
    else {
      assert.match(trigger.reason, /FIRST_TEST_FAILURE|UNORDERED_TEST_FAILURE/u);
      assert.match(failedFast.output, /FIRST_TEST_FAILURE|UNORDERED_TEST_FAILURE/u);
    }
  }
  for (const scenario of ["compiler-cleanup", "stream-tap-failure", "stream-compiler-failure"]) {
    for (const path of [childPid, blocked, streamFirstSeen, streamNoiseSeen])
      await rm(path, { force: true });
    const failed = await run(level, scenario, 10);
    assert.equal(failed.report.status, "FAIL", `${level}/${scenario}: ${failed.output}`);
    assert.notEqual(failed.code, 0);
    assert.ok(failed.report.budgeted < failed.report.limitSeconds, failed.output);
    assert.deepEqual(
      failed.report.stages.map((stage) => stage.id),
      [
        scenario === "compiler-cleanup" ? "first-compiler-failure" : "first-stream-failure",
        "owned-peer-tree",
        "owned-compile",
        "owned-compile-peer",
      ],
      `${level}/${scenario} must stop the active group before admitting a later stage`,
    );
    const trigger = failed.report.stages[0];
    assert.equal(trigger.status, "FAIL");
    const pid = Number(await readFile(childPid, "utf8"));
    assert.throws(() => process.kill(pid, 0), `${level}/${scenario}: owned grandchild survived`);
    await assert.rejects(
      () => readFile(blocked),
      { code: "ENOENT" },
      `${level}/${scenario} must not start the queued fifth stage: ${failed.output}`,
    );
    if (scenario === "compiler-cleanup") {
      assert.equal(trigger.reason, "error TS9999: PURE_COMPILER_FAILURE");
      assert.ok(
        failed.report.cleanupObservations.some(
          ({ compileActive, checkActive, wasCompileOnly, compileOnly, before, after }) =>
            compileActive === 4 &&
            checkActive === 1 &&
            wasCompileOnly &&
            !compileOnly &&
            after.budgeted > before.budgeted &&
            after.compileExcluded === before.compileExcluded,
        ),
        `${level}: pure compiler tree cleanup must activate check time and charge its full interval: ${JSON.stringify(failed.report.cleanupObservations)}`,
      );
    } else {
      assert.deepEqual(failed.report.streamSeen, ["stdout-head", "stderr-between"]);
      assert.equal(
        trigger.reason,
        scenario === "stream-tap-failure"
          ? "not ok 1 - STREAM_TAP_FAILURE"
          : "error TS9999: STREAM_COMPILER_FAILURE",
      );
      assert.match(failed.output, /INTERLEAVED_STDERR/u);
    }
  }
}
