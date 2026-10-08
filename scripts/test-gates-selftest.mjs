import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandOutput,
  exists,
  stopAll,
  pause,
  startBudget,
  snapshot,
  gitText,
} from "./test-gates-process.mjs";
import { remoteAllowed } from "./test-gates-remote.mjs";

export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), "ompcode-gates-selftest-"));
  const failure = join(root, "failure.mjs");
  const sleeper = join(root, "sleeper.mjs");
  const missingTool = join(root, "no-such-tool.exe");
  const childPid = join(root, "child.pid");
  const stub = join(root, "tree.mjs");
  await writeFile(failure, "process.exit(7);\n");
  await writeFile(sleeper, "setInterval(() => {}, 1000);\n");
  await writeFile(
    stub,
    `import {spawn} from 'node:child_process';import{writeFile}from'node:fs/promises';const c=spawn(process.execPath,[${JSON.stringify(sleeper)}],{windowsHide:true});await writeFile(${JSON.stringify(childPid)},String(c.pid));setInterval(()=>{},1000);\n`,
  );
  const failed = await commandOutput("node", [failure], { quiet: true });
  assert.equal(failed.code, 7);
  const absent = await commandOutput(missingTool, [], { quiet: true });
  assert.notEqual(absent.code, 0);
  assert.throws(() => startBudget(61, performance.now(), () => {}));
  const skipped = join(root, "skip.mjs");
  await writeFile(skipped, "console.log('ℹ skipped 1');\n");
  const skipResult = await commandOutput("node", [skipped], { quiet: true });
  assert.equal(
    skipResult.skipped,
    true,
    "Spec reporter skipped cases must not be counted as full PASS",
  );
  const gitRoot = join(root, "source-fingerprint");
  await mkdir(gitRoot);
  const runGit = async (args) => {
    const result = await commandOutput(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", gitRoot, ...args],
      { quiet: true },
    );
    assert.equal(result.code, 0, result.output);
    return result;
  };
  await runGit(["init", "--quiet"]);
  await assert.rejects(
    () => gitText(["-C", join(root, "missing-source-directory"), "status"]),
    /missing-source-directory/u,
    "Git failures must preserve the stderr path needed to diagnose the missing source",
  );
  await runGit(["config", "core.autocrlf", "true"]);
  await runGit(["config", "core.safecrlf", "warn"]);
  await writeFile(join(gitRoot, "source.txt"), "before\r\n");
  await runGit(["add", "source.txt"]);
  await runGit([
    "-c",
    "user.name=Gate fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await writeFile(join(gitRoot, "source.txt"), "after 中文字符边界\n".repeat(12_345));
  assert.match((await runGit(["diff", "--binary", "HEAD"])).output, /LF will be replaced by CRLF/u);
  const previousCwd = process.cwd();
  try {
    process.chdir(gitRoot);
    const withWarning = await snapshot();
    await runGit(["config", "core.safecrlf", "false"]);
    const withoutWarning = await snapshot();
    assert.equal(
      withWarning.contentHash,
      withoutWarning.contentHash,
      "Unchanged source must retain its fingerprint when Git diagnostics change",
    );
    await writeFile(join(gitRoot, "source.txt"), "real source change\n");
    assert.notEqual(
      (await snapshot()).contentHash,
      withoutWarning.contentHash,
      "Real source changes must still invalidate verification",
    );
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(
    remoteAllowed({ records: [{ status: "FAIL" }], inCi: false, authorizedRelease: true }),
    false,
  );
  const remoteMarker = join(root, "remote-triggered");
  if (remoteAllowed({ records: [{ status: "FAIL" }], inCi: false, authorizedRelease: true }))
    await writeFile(remoteMarker, "triggered");
  assert.equal(await exists(remoteMarker), false);
  assert.equal(
    remoteAllowed({ records: [{ status: "PASS" }], inCi: true, authorizedRelease: true }),
    false,
  );
  const denied = await commandOutput("node", ["scripts/test-gates.mjs", "fulltest"], {
    quiet: true,
  });
  assert.equal(denied.code, 2);
  assert.match(denied.output, /HUMAN AUTHORIZATION REQUIRED/u);
  const deniedSlow = await commandOutput(
    "node",
    ["scripts/test-gates.mjs", "slowtest", "--human-authorized"],
    { quiet: true, env: { CI: "true" } },
  );
  assert.equal(deniedSlow.code, 2);
  assert.match(deniedSlow.output, /CI must not recursively/u);
  // 只运行临时短桩，绝不调用真实 fulltest/slowtest 或远端流水线。
  const testTimeout = join(root, "timeout.mjs");
  await writeFile(
    testTimeout,
    `import{startCommand,startBudget}from ${JSON.stringify(pathToFileURL(resolve("scripts/test-gates-process.mjs")).href)};const t=performance.now();startCommand('node',[${JSON.stringify(stub)}]);startBudget(5,t,r=>{console.log('TIMEOUT '+r.seconds.toFixed(1)+'s');process.exit(124)});\n`,
  );
  const start = performance.now();
  const timeout = await commandOutput("node", [testTimeout], { quiet: true });
  assert.equal(timeout.code, 124);
  assert.match(timeout.output, /TIMEOUT \d+\.\ds/u);
  assert.ok(performance.now() - start < 6000);
  const pid = Number(await readFile(childPid, "utf8"));
  await pause(100);
  assert.throws(() => process.kill(pid, 0), "Owned grandchild must be terminated");
  await stopAll();
  console.log(
    "Self-tests PASS: failure, missing tool, permission rejection, prior failure blocks remote, CI recursion, timeout and owned grandchild cleanup",
  );
}
