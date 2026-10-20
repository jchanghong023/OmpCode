import assert from "node:assert/strict";
import { glob, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exerciseEntryMechanisms } from "./test-gates-entry-selftest.mjs";
import { fullPlan, slowPlan } from "./test-gates-plan.mjs";
import { bazelSelfTest } from "./test-gates-bazel-selftest.mjs";
import { commandOutput, stopAll } from "./test-gates-process.mjs";
import { snapshot, gitText } from "./test-gates-snapshot.mjs";
import { gateBudget } from "./test-gates-clock.mjs";

async function assertCurrentTestInventory() {
  const full = await fullPlan();
  const slow = await slowPlan();
  assert.deepEqual(slow.slice(0, full.length), full, "Slow must inherit every full check once");
  assert.equal(
    full.some((stage) => stage.packaging),
    false,
    "Daily fulltest must not package",
  );
  assert.deepEqual(
    slow.slice(full.length).map((stage) => stage.id),
    ["desktop-windows-unpacked-packaging"],
    "Only slowtest adds the existing local unpacked packaging validation",
  );
  const discovered = [];
  for (const pattern of [
    "scripts/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "packages/*/test/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "packages/*/test/*.gui.e2e.mjs",
    "packages/*/test/*.components.e2e.mjs",
    "packages/*/test/*.windows-smoke.mjs",
  ])
    for await (const file of glob(pattern)) discovered.push(file.replaceAll("\\", "/"));
  const scheduled = new Set(
    full
      .flatMap((stage) => stage.args)
      .filter((arg) => typeof arg === "string" && discovered.includes(arg)),
  );
  // 手写文件名单曾漏掉 workspaceFileIndex；阶段全绿不代表现存测试已全部收录。
  assert.deepEqual(
    [...scheduled].sort(),
    [...new Set(discovered)].sort(),
    "Every existing applicable package test entry must be scheduled, including new GUI suites",
  );
  const nodeTests = full.filter((stage) => stage.kind === "test" && stage.args.includes("--test"));
  for (const file of discovered.filter((entry) => /\.test\.[cm]?[jt]sx?$/u.test(entry))) {
    const owners = nodeTests.filter((stage) => stage.args.includes(file));
    assert.equal(owners.length, 1, `${file} must be executed exactly once`);
    assert.deepEqual(
      owners[0].args.filter((arg) => /\.test\.[cm]?[jt]sx?$/u.test(arg)),
      [file],
      `${file} must not share its cached execution with another test file`,
    );
  }
  for (const suite of ["conversation", "models", "agents", "native", "interactions"]) {
    const stages = full.filter((stage) => stage.fixture && stage.suite === suite);
    assert.deepEqual(
      stages.map((stage) => stage.phase),
      suite === "models" ? ["live", "profile", "default"] : ["live", "recovery"],
    );
    assert.ok(
      stages.every((stage) => stage.realOmp),
      `${suite} may not bypass the real OMP gate`,
    );
  }
}

export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), "ompcode-gates-selftest-"));
  // 修复依据：断言提前失败也必须释放本次短桩进程和临时根，不能只在成功路径清理。
  try {
    await assertCurrentTestInventory();
    // Native fixture owns concurrency/dependency/cache assertions; the remaining
    // short fixtures exercise only the outer lifecycle and process adapters.
    await bazelSelfTest();
    await runSelfTest(root);
  } finally {
    await stopAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function assertChangedArchitectureScope(root) {
  const workspace = join(root, "architecture-scope");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "architecture-policy.yaml"),
    JSON.stringify({
      version: 1,
      modules: [{ id: "fixture", roots: ["src"], managed: false }],
      global: { managedOnly: false, maxFileLines: 2 },
    }),
  );
  await writeFile(join(workspace, "src/violation.ts"), "export const a = 1;\n\n\n");
  const control = join(workspace, "scope.json");
  const inspect = async (changedFiles) => {
    await writeFile(control, JSON.stringify({ stage: { changedFiles } }));
    return commandOutput(
      "node",
      [
        resolve("scripts/architecture/architecture-check.mjs"),
        "report",
        "--changed",
        "--changed-files-control",
        control,
      ],
      { cwd: workspace, quiet: true, stdoutOnly: true },
    );
  };
  // 此根没有 Git 仓库：显式范围必须优先于 --changed，且决定实际违规过滤结果。
  const excluded = await inspect([]);
  assert.equal(excluded.code, 0, excluded.output);
  assert.deepEqual(JSON.parse(excluded.output).newViolations, []);
  const included = await inspect(["src/violation.ts"]);
  assert.equal(included.code, 1, included.output);
  assert.deepEqual(
    JSON.parse(included.output).newViolations.map((item) => item.rule),
    ["max-file-lines"],
  );
}

async function runSelfTest(root) {
  await assertChangedArchitectureScope(root);
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
    const narrowed = await commandOutput(
      "node",
      ["scripts/test-gates.mjs", level, "--plan", "--target", "@zcode/desktop"],
      { quiet: true },
    );
    assert.equal(narrowed.code, 1, `${level} cannot narrow its test scope`);
    assert.match(narrowed.output, /Unknown gate argument: --target/u);
  }

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
    "Self-tests PASS: native Bazel execution/cache/dependencies, outer budgets, permissions, source fingerprint, immediate case failures, signals and owned grandchild cleanup",
  );
}
