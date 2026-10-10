import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exerciseEntryMechanisms } from "./test-gates-entry-selftest.mjs";
import {
  commandOutput,
  stopAll,
  gateBudget,
  snapshot,
  gitText,
  runStages,
  exists,
} from "./test-gates-process.mjs";

export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), "ompcode-gates-selftest-"));
  // 修复依据：断言提前失败也必须释放本次短桩进程和临时根，不能只在成功路径清理。
  try {
    await runSelfTest(root);
  } finally {
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function runSelfTest(root) {
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
  assert.throws(() => gateBudget("fastcheck", 61));
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
  for (const [level, maximum] of [
    ["fastcheck", 60],
    ["fulltest", 900],
    ["slowtest", 1500],
  ]) {
    const rejected = await commandOutput(
      "node",
      ["scripts/test-gates.mjs", level, "--plan", "--budget-seconds", String(maximum + 1)],
      { quiet: true },
    );
    assert.equal(rejected.code, 1, `${level} cannot relax its charged budget`);
    assert.match(rejected.output, /may only be lowered/u);
  }

  const events = join(root, "events.jsonl");
  const probe = join(root, "parallel-probe.mjs");
  // Windows 启动耗时不等，短桩先同步开始屏障，避免把真实并发误判为串行。
  await writeFile(
    probe,
    `
import assert from 'node:assert/strict';
import {appendFile,access,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const [root,id,...dependencies]=process.argv.slice(2);
for(const dependency of dependencies) await access(join(root,dependency+'.ready'));
await appendFile(join(root,'events.jsonl'),JSON.stringify({id,event:'start'})+'\\n');
await writeFile(join(root,id+'.started'),'started');
const peer=id==='a'?'b':id==='b'?'a':undefined;
const deadline=performance.now()+5000;
if(peer) while(!await access(join(root,peer+'.started')).then(()=>true,()=>false)){
  assert.ok(performance.now()<deadline,'Concurrent peer did not start');
  await new Promise(done=>setTimeout(done,10));
}
await new Promise(done=>setTimeout(done,200));
await writeFile(join(root,id+'.ready'),'done');
await appendFile(join(root,'events.jsonl'),JSON.stringify({id,event:'end'})+'\\n');
`,
  );
  const execute = async (stage) => {
    const result = await commandOutput(stage.command, stage.args, { quiet: true });
    return { status: result.code === 0 ? "PASS" : "FAIL", exitCode: result.code };
  };
  const prerequisites = ["a", "b", "c"].map((id) => ({
    id,
    parallelGroup: "offline",
    command: "node",
    args: [probe, root, id],
  }));
  const records = await runStages(
    [
      ...prerequisites,
      { id: "dependent", command: "node", args: [probe, root, "dependent", "a", "b", "c"] },
    ],
    execute,
    2,
  );
  assert.ok(
    records.every((record) => record.status === "PASS"),
    "Dependencies must finish before their consumer starts",
  );
  let active = 0;
  let peak = 0;
  for (const event of (await readFile(events, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))) {
    active += event.event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(peak, 2, "Independent children must run in parallel without exceeding the limit");
  const afterFailure = join(root, "after-failure.mjs");
  await writeFile(
    afterFailure,
    `import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(join(root, "should-not-run"))},'invalid');`,
  );
  const failedStages = await runStages(
    [
      { id: "failure", command: "node", args: [failure] },
      { id: "blocked-consumer", command: "node", args: [afterFailure] },
    ],
    execute,
  );
  assert.equal(failedStages[0].status, "FAIL");
  assert.equal(
    await exists(join(root, "should-not-run")),
    false,
    "Failed prerequisites must block subsequent stages",
  );
  const obsoleteFlag = await commandOutput(
    "node",
    ["scripts/test-gates.mjs", "slowtest", "--plan", "--publish-releases"],
    { quiet: true },
  );
  assert.equal(obsoleteFlag.code, 1);
  assert.match(obsoleteFlag.output, /Unknown gate argument/u);
  // 临时短桩复用真实生命周期，验证三种入口的全部退出路径和编译专用区间计费。
  await exerciseEntryMechanisms(root, { failure, tree: stub, childPid });
  console.log(
    "Self-tests PASS: failure propagation, bounded parallel children, dependency barrier, hard budget rejection, permissions, source fingerprint, timeout and owned grandchild cleanup",
  );
}
