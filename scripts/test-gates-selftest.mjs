import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandOutput,
  stopAll,
  pause,
  startBudget,
  snapshot,
  gitText,
} from "./test-gates-process.mjs";

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
  const denied = await commandOutput("node", ["scripts/test-gates.mjs", "fulltest"], {
    quiet: true,
  });
  assert.equal(denied.code, 2);
  assert.match(denied.output, /HUMAN AUTHORIZATION REQUIRED/u);
  const plans = [];
  for (const level of ["fulltest", "slowtest"]) {
    const result = await commandOutput("node", ["scripts/test-gates.mjs", level, "--plan"], {
      quiet: true,
    });
    assert.equal(result.code, 0, result.output);
    const start = result.output.indexOf("{");
    const finish = result.output.lastIndexOf("\n}");
    plans.push(JSON.parse(result.output.slice(start, finish + 2)).stages);
  }
  assert.deepEqual(plans[0], plans[1], "Both complete gates must expose the same Windows plan");
  assert.deepEqual(plans[1].find((stage) => stage.id === "windows-local-package")?.args, [
    "bundle:desktop",
    "--",
    "--os=win",
    "--arch=x64",
  ]);
  assert.ok(
    plans[1].every((stage) => ["node", "pnpm"].includes(stage.command)),
    "Windows test stages cannot dispatch external target runners",
  );
  const obsoleteFlag = await commandOutput(
    "node",
    ["scripts/test-gates.mjs", "slowtest", "--plan", "--publish-releases"],
    { quiet: true },
  );
  assert.equal(obsoleteFlag.code, 1);
  assert.match(obsoleteFlag.output, /Unknown gate argument/u);
  // 只运行临时短桩与只读 Windows 计划，不执行完整测试或发布操作。
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
    "Self-tests PASS: failure, missing tool, permission rejection, source fingerprint, timeout and owned grandchild cleanup",
  );
}
