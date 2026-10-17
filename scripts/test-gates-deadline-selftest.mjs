import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";

export async function exerciseHardDeadline(run, level, compile, childPid) {
  if (level === "fastcheck") {
    assert.equal(compile.code, 0, "fastcheck still excludes pure compilation");
    assert.equal(compile.report.status, "PASS");
    assert.ok(compile.report.total > 1.5 && compile.report.compileExcluded > 2);
    assert.ok(compile.report.budgeted < 1.5);
    return;
  }
  const stuckFailure = await run(level, "failure-finally-hang", 10);
  assert.equal(stuckFailure.code, 1, stuckFailure.output);
  assert.equal(stuckFailure.report.status, "FAIL");
  assert.equal(stuckFailure.report.stages[0].exitCode, 7);
  assert.ok(stuckFailure.report.total < 3, "Command failure must bypass a stuck stage finally");
  assert.equal(compile.code, 124, `${level} must time out even during pure compilation`);
  assert.equal(compile.report.status, "TIMEOUT");
  assert.ok(compile.report.total < 1.8, compile.output);
  for (const scenario of ["hung-work", "hung-verify", "hung-cleanup"]) {
    const hung = await run(level, scenario);
    assert.equal(hung.code, 124, `${level}/${scenario}: ${hung.output}`);
    assert.equal(hung.report.status, "TIMEOUT");
    assert.ok(hung.report.total < 1.8, hung.output);
    if (scenario === "hung-cleanup")
      assert.ok(hung.report.total >= hung.report.limitSeconds, hung.output);
  }
  const peer = await run(level, "parallel-hang", 10);
  assert.equal(peer.report.status, "FAIL", peer.output);
  assert.ok(peer.report.total < 3, "First failure must not wait for a hung peer");
  assert.equal(peer.report.stages.find((stage) => stage.id === "hung-work").status, "CANCELLED");
  await rm(childPid, { force: true });
  const unhandled = await run(level, "unhandled", 10);
  assert.equal(unhandled.code, 1, unhandled.output);
  assert.equal(unhandled.report.status, "FAIL");
  assert.match(unhandled.report.reason, /UNHANDLED_FIXTURE_FAILURE/u);
  const pid = Number(await readFile(childPid, "utf8"));
  assert.throws(() => process.kill(pid, 0), `${level}: unhandled failure left a grandchild`);
}
