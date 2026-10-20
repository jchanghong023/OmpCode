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

async function assertReadOnlyGraphDiagnostics(root) {
  const fixture = join(root, "readonly-graph-diagnostic.mjs");
  // 仅替换 IO/原生命令边界；实际入口与图同步代码共同验证无授权诊断不会执行/回填。
  await writeFile(
    fixture,
    `
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const [scenario,level,...flags]=process.argv.slice(2);
const base=pathToFileURL(${JSON.stringify(resolve("scripts") + "/")});
const url=name=>new URL(name,base).href;
const entry=url('test-gates.mjs'),graph=url('test-gates-bazel-graph.mjs');
const calls=[],reads=[],writes=[],removals=[];
const original=Buffer.from('graph-A'),different=Buffer.from('graph-B');
const missing=()=>Object.assign(new Error('missing graph'),{code:'ENOENT'});
globalThis.fixtureState={scenario,calls,reads,writes,removals,original,different,missing};
const modules=new Map([
 ['fixture:fs',\`
 const state=globalThis.fixtureState;
 export async function readFile(path){
  const name=String(path).replaceAll('\\\\\\\\','/');state.reads.push(name);
  if(name==='mise.toml') return 'pnpm = "fixture"';
  if(name.endsWith('/BUILD.bazel')){
   if(state.scenario==='root-missing') throw state.missing();
   return state.original;
  }
  if(state.scenario==='artifact-missing') throw state.missing();
  if(state.scenario==='artifact-error') throw Object.assign(new Error('artifact denied'),{code:'EACCES'});
  return ['mismatch','normal-update'].includes(state.scenario)?state.different:state.original;
 }
 export async function writeFile(path,data){state.writes.push({path:String(path),text:String(data)});}
 export async function rm(path){state.removals.push(String(path));}
 \`],
 [url('test-gates-plan.mjs'),\`
 const plan=async()=>[{id:'cacheable'},{id:'external',noCache:true}];
 export const fastPlan=plan,fullPlan=plan,slowPlan=plan,installedOmp=async()=>'/fixture/omp';
 \`],
 [url('test-gates-command-stage.mjs'),'export async function restorePackagingState(){};export async function snapshotPackagingState(){throw Error("packaging executed");}'],
 [url('test-gates-bazel.mjs'),\`
 export const bazelizeStages=stages=>[{id:'native',bazel:{stages}}];
 export const assertBazelReady=async()=>({path:'fixture',version:'fixture'});
 export const isUncachedStage=stage=>Boolean(stage.noCache);
 export async function cleanupBazelInputs(){}
 export async function runBazelStage(stage){
  const state=globalThis.fixtureState;
  state.calls.push(stage);
  if(!state.scenario.startsWith('normal-')) assertCacheOnly(stage);
  const graph=stage.bazel.stages[0].id==='bazel-graph';
  const status=graph
   ?state.scenario==='graph-miss'?'CACHE_MISS':state.scenario==='graph-fail'?'FAIL':'PASS'
   :state.scenario==='query-miss'?'CACHE_MISS':state.scenario==='query-fail'?'FAIL':'PASS';
  return {status,targets:[],reason:status};
 }
 function assertCacheOnly(stage){if(stage.bazel.cacheOnly!==true) throw Error('NON_READONLY_EXECUTION');}
 \`],
 [url('test-gates-snapshot.mjs'),"export const snapshot=async()=>({contentHash:'current'}),sameSnapshot=()=>true,gitText=async()=>'',exists=async()=>true;"],
 [url('test-gates-clock.mjs'),'export const createGateClock=()=>({}),gateBudget=()=>900;'],
 [url('test-gates-bazel-locations.mjs'),\`export const repositoryRoot=\${JSON.stringify(process.cwd())};\`],
 [url('test-gates-diagnostics.mjs'),'export const createGateDiagnostics=async()=>({summarize:async()=>({})});'],
 [url('test-gates-run.mjs'),\`
 export function createGateRun(options){
  let report;
  const finish=async(status,exitCode)=>{
   if(report) return report;
   report={status,exitCode,...globalThis.fixtureState};
   console.log('FIXTURE_EVIDENCE '+JSON.stringify(report));
   return report;
  };
  return {clock:options.clock,finish,async run(operation){
   if(!options.authorized&&['fulltest','slowtest'].includes(options.level))
    return finish('NOT RUN — HUMAN AUTHORIZATION REQUIRED',2);
   await operation([],()=>{throw Error('unexpected execution failure callback');});
   return report??finish('PASS',0);
  }};
 }
 \`],
]);
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='node:fs/promises'&&[entry,graph].includes(context.parentURL))
   return {url:'fixture:fs',shortCircuit:true};
  return next(specifier,context);
 },
 load(name,context,next){
  if(modules.has(name)) return {format:'module',source:modules.get(name),shortCircuit:true};
  return next(name,context);
 },
});
delete process.env.npm_config_user_agent;
if(level==='graph'){
 const {ensureBazelGraph}=await import(graph);
 const result=await ensureBazelGraph({}, {readOnly:!scenario.startsWith('normal-')});
 console.log('FIXTURE_EVIDENCE '+JSON.stringify({...result,...globalThis.fixtureState}));
}else{
 process.argv=[process.execPath,entry,level,...flags];
 await import(entry);
}
`,
  );
  const run = async (scenario, level, flags = ["--check-tests-up-to-date"]) => {
    const result = await commandOutput("node", [fixture, scenario, level, ...flags], {
      quiet: true,
    });
    const evidence = result.output
      .split(/\r?\n/u)
      .find((line) => line.startsWith("FIXTURE_EVIDENCE "));
    assert.ok(evidence, result.output);
    return JSON.parse(evidence.slice("FIXTURE_EVIDENCE ".length));
  };
  for (const level of ["fastcheck", "fulltest", "slowtest"]) {
    for (const [scenario, status, count] of [
      ["hit", "DIAGNOSTIC_UP_TO_DATE", 2],
      ["graph-miss", "DIAGNOSTIC_OUT_OF_DATE", 1],
      ["graph-fail", "FAIL", 1],
      ["mismatch", "DIAGNOSTIC_OUT_OF_DATE", 1],
      ["artifact-missing", "DIAGNOSTIC_OUT_OF_DATE", 1],
      ["root-missing", "DIAGNOSTIC_OUT_OF_DATE", 1],
      ["artifact-error", "FAIL", 1],
      ["query-miss", "DIAGNOSTIC_OUT_OF_DATE", 2],
      ["query-fail", "FAIL", 2],
    ]) {
      const report = await run(scenario, level);
      assert.equal(report.status, status, `${level}/${scenario}`);
      assert.equal(report.calls.length, count);
      assert.deepEqual(report.writes, []);
      assert.deepEqual(report.removals, []);
      if (count === 2)
        assert.deepEqual(
          report.calls[1].bazel.stages.map((stage) => stage.id),
          ["cacheable"],
        );
      if (scenario === "hit")
        assert.ok(
          report.reads.some((name) =>
            name.endsWith(
              "/bazel-bin/gates/artifacts/gate-bazel-graph/gates/inputs/generated-build.bazel",
            ),
          ),
        );
      if (["graph-miss", "graph-fail"].includes(scenario))
        assert.equal(
          report.reads.some((name) => name.includes("generated-build.bazel")),
          false,
        );
      if (scenario === "hit") assert.equal(report.exitCode, 0);
    }
    const plan = await run("hit", level, ["--plan", "--check-tests-up-to-date"]);
    assert.equal(plan.status, "PLAN ONLY — NOT RUN");
    assert.deepEqual(plan.calls, []);
    const authorized = await run("hit", level, ["--human-authorized", "--check-tests-up-to-date"]);
    assert.equal(authorized.status, "DIAGNOSTIC_UP_TO_DATE");
    assert.ok(authorized.calls.every((call) => call.bazel.cacheOnly === true));
    if (level !== "fastcheck") {
      const denied = await run("hit", level, []);
      assert.equal(denied.exitCode, 2);
      assert.deepEqual(denied.calls, []);
    }
  }
  const snapshot = await run("hit", "--snapshot");
  assert.equal(snapshot.status, "PASS");
  assert.deepEqual(snapshot.calls, []);
  // 图函数只负责生成与根 BUILD 的字节更新；传输清理已归 GateRun 结束后的桥接 owner。
  for (const scenario of ["normal-same", "normal-update"]) {
    const report = await run(scenario, "graph", []);
    assert.equal(report.status, "PASS");
    assert.equal(report.calls.length, 1);
    assert.equal(report.calls[0].bazel.cacheOnly, undefined);
    assert.equal(report.writes.length, scenario === "normal-update" ? 1 : 0);
  }
}

async function runSelfTest(root) {
  await assertChangedArchitectureScope(root);
  await assertReadOnlyGraphDiagnostics(root);
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
