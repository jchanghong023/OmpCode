import assert from "node:assert/strict";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandOutput } from "./test-gates-process.mjs";
import { exerciseHardDeadline } from "./test-gates-deadline-selftest.mjs";

// 只在临时目录运行短桩；和真实入口共用生命周期，不提供绕过真实计划的 CLI/env 开关。
export async function exerciseEntryMechanisms(root, { failure, tree, childPid }) {
  const runner = pathToFileURL(resolve("scripts/test-gates-run.mjs")).href;
  const processModule = pathToFileURL(resolve("scripts/test-gates-process.mjs")).href;
  const fixture = join(root, "entry-fixture.mjs");
  const cache = join(root, "build.tsbuildinfo");
  const failingTests = join(root, "first-failure.test.mjs");
  const laterTests = join(root, "later.test.mjs");
  const slowTests = join(root, "earlier-slow.test.mjs");
  const lateFailureTests = join(root, "later-failure.test.mjs");
  const concurrentTests = join(root, "concurrent-failure.test.mjs");
  const blocked = join(root, "blocked-after-failure");
  const streamFirstSeen = join(root, "stream-first-seen");
  const streamNoiseSeen = join(root, "stream-noise-seen");
  const sourceFile = join(root, "verification-source");
  const verifyRan = join(root, "verification-ran");
  const streamNoise = "INTERLEAVED_STDERR\n";
  const streamFailures = {
    "stream-tap-failure": { first: "not o", last: "k 1 - STREAM_TAP_FAILURE\n" },
    "stream-compiler-failure": { first: "error T", last: "S9999: STREAM_COMPILER_FAILURE\n" },
  };
  const streamCode = Object.fromEntries(
    Object.entries(streamFailures).map(([scenario, { first, last }]) => [
      scenario,
      `import{readFile}from'node:fs/promises';const seen=async p=>{while(!await readFile(p).then(()=>true,()=>false))await new Promise(setImmediate);};await seen(${JSON.stringify(childPid)});process.stdout.write(${JSON.stringify(first)});await seen(${JSON.stringify(streamFirstSeen)});process.stderr.write(${JSON.stringify(streamNoise)});await seen(${JSON.stringify(streamNoiseSeen)});process.stdout.write(${JSON.stringify(last)});setInterval(()=>{},1000);`,
    ]),
  );
  const awaitPeer = `while(!await readFile(${JSON.stringify(childPid)}).then(()=>true,()=>false)) await new Promise(r=>setTimeout(r,10));`;
  await writeFile(
    failingTests,
    `import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';test('first failure',async()=>{${awaitPeer}assert.fail('FIRST_TEST_FAILURE');});test('already scheduled work',async()=>{await new Promise(r=>setTimeout(r,10000));});`,
  );
  await writeFile(
    slowTests,
    `import test from 'node:test';test('earlier slow file',async()=>{await new Promise(r=>setTimeout(r,10000));});`,
  );
  await writeFile(
    lateFailureTests,
    `import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';test('later file failure',async()=>{${awaitPeer}assert.fail('UNORDERED_TEST_FAILURE');});`,
  );
  await writeFile(
    concurrentTests,
    `import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';test('concurrent suite',{concurrency:2},async t=>{await Promise.all([t.test('earlier slow child',async()=>{await new Promise(r=>setTimeout(r,10000));}),t.test('later failing child',async()=>{${awaitPeer}assert.fail('UNORDERED_TEST_FAILURE');})]);});`,
  );
  await writeFile(
    laterTests,
    `import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(blocked)},'must not start');`,
  );
  await writeFile(
    fixture,
    `
import {createGateRun} from ${JSON.stringify(runner)};
import {commandOutput} from ${JSON.stringify(processModule)};
import {readFile,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
const [level,scenario,root,limit]=process.argv.slice(2);
const gate=createGateRun({level,limitSeconds:Number(limit),authorized:!['denied','unauthed-timeout'].includes(scenario),signals:['SIGTERM'],cleanup:scenario==='hung-cleanup'?()=>new Promise(()=>{}):undefined});
const waitCode=ms=>'setTimeout(()=>{},'+ms+')';
const node=(id,kind,ms,extra={})=>({id,kind,command:'node',args:['--eval',waitCode(ms)],...extra});
const cleanupObservations=[];
if(scenario==='compiler-cleanup'){
 const enter=gate.clock.enter.bind(gate.clock);
 let compileActive=0;
 let checkActive=0;
 gate.clock.enter=kind=>{
  const wasCompileOnly=gate.clock.compileOnly();
  const end=enter(kind);
  if(kind==='compile') compileActive++; else checkActive++;
  const observation=kind!=='compile'&&compileActive>0
   ? {compileActive,checkActive,wasCompileOnly,compileOnly:gate.clock.compileOnly(),before:gate.clock.read()}
   : undefined;
  return ()=>{
   if(observation) cleanupObservations.push({...observation,after:gate.clock.read()});
   end();
   if(kind==='compile') compileActive--; else checkActive--;
  };
 };
}
const streamFailures=${JSON.stringify(streamFailures)};
const streamCode=${JSON.stringify(streamCode)};
const streamSeen=[];
const originalWrite=process.stdout.write;
if(streamFailures[scenario]){
 process.stdout.write=function(chunk,...args){
  const result=originalWrite.call(this,chunk,...args);
  const text=String(chunk);
  if(text===streamFailures[scenario].first){
   streamSeen.push('stdout-head');
   writeFileSync(${JSON.stringify(streamFirstSeen)},'seen');
  }else if(text===${JSON.stringify(streamNoise)}){
   streamSeen.push('stderr-between');
   writeFileSync(${JSON.stringify(streamNoiseSeen)},'seen');
  }
  return result;
 };
}
let stages;
switch(scenario){
 case 'success': stages=[node('check','check',100)]; break;
 case 'hung-work': stages=[{id:'hung-work',kind:'compile'}]; break;
 case 'hung-verify':
 case 'hung-cleanup': stages=[node('check','check',100)]; break;
 case 'parallel-hang': stages=[{id:'failure',kind:'check',command:'node',args:[${JSON.stringify(failure)}],parallelGroup:'failure'},{id:'hung-work',kind:'check',parallelGroup:'failure'}]; break;
 case 'unhandled': stages=[{id:'owned-tree',kind:'check',command:'node',args:[${JSON.stringify(tree)}]}]; break;
 case 'failure': stages=[{id:'failure',kind:'check',command:'node',args:[${JSON.stringify(failure)}]}]; break;
 case 'failure-finally-hang': stages=[{id:'failure',kind:'check',command:'node',args:[${JSON.stringify(failure)}]}]; break;
 case 'missing': stages=[{id:'missing',kind:'check',command:root+'/no-such-tool.exe',args:[]}]; break;
 case 'denied': stages=[{id:'must-not-run',kind:'check',command:'node',args:['--eval',"require('node:fs').writeFileSync("+JSON.stringify(root+'/unauthorized-ran')+",'bad')"]}]; break;
 case 'timeout':
 case 'unauthed-timeout':
 case 'interruption': stages=[{id:'owned-tree',kind:'check',command:'node',args:[${JSON.stringify(tree)}]}]; break;
 case 'compile-long': stages=[node('compile','compile',2600)]; break;
 case 'compile-fail': stages=[{id:'compile-fail',kind:'compile',command:'node',args:[${JSON.stringify(failure)}]}]; break;
 case 'overlap': stages=[node('compile','compile',2600,{parallelGroup:'parallel'}),node('check','check',2600,{parallelGroup:'parallel'})]; break;
 case 'serial-budget': stages=[node('first','check',600),node('second','check',600),node('third','check',600)]; break;
 case 'mixed': stages=[node('compile-and-test','test',2600)]; break;
 case 'parallel': stages=[node('a','check',500,{parallelGroup:'parallel'}),node('b','check',500,{parallelGroup:'parallel'}),node('c','check',500,{parallelGroup:'parallel'})]; break;
 case 'cache': stages=[{id:'cached-compile',kind:'compile',command:'node',args:['--eval',"const fs=require('node:fs');const p="+JSON.stringify(${JSON.stringify(cache)})+";if(fs.existsSync(p)){console.log('CACHE_REUSED')}else{fs.writeFileSync(p,'reusable-build-artifact');console.log('CACHE_CREATED')}"]}]; break;
 case 'verify-source': stages=[node('check','check',100)]; break;
 case 'verify-failure': stages=[{id:'failure',kind:'check',command:'node',args:[${JSON.stringify(failure)}]}]; break;
 case 'compiler-cleanup': {
  stages=[
   {id:'first-compiler-failure',kind:'compile',command:'node',args:['--input-type=module','--eval',${JSON.stringify(`import{readFile}from'node:fs/promises';${awaitPeer}console.log('error TS9999: PURE_COMPILER_FAILURE');setInterval(()=>{},1000);`)}],parallelGroup:'failure'},
   {id:'owned-peer-tree',kind:'compile',command:'node',args:[${JSON.stringify(tree)}],parallelGroup:'failure'},
   node('owned-compile','compile',10000,{parallelGroup:'failure'}),
   {id:'must-not-start',kind:'compile',command:'node',args:[${JSON.stringify(laterTests)}],parallelGroup:'failure'},
  ];
  break;
 }
 case 'stream-tap-failure':
 case 'stream-compiler-failure': {
  const kind=scenario==='stream-tap-failure'?'test':'compile';
  stages=[
   {id:'first-stream-failure',kind,failFastTests:kind==='test',command:'node',args:['--input-type=module','--eval',streamCode[scenario]],parallelGroup:'failure'},
   {id:'owned-peer-tree',kind,command:'node',args:[${JSON.stringify(tree)}],parallelGroup:'failure'},
   node('owned-compile','compile',10000,{parallelGroup:'failure'}),
   {id:'must-not-start',kind,command:'node',args:[${JSON.stringify(laterTests)}],parallelGroup:'failure'},
  ];
  break;
 }
 case 'parallel-failure':
 case 'compiler-output-failure':
 case 'out-of-order-files':
 case 'concurrent-test-failure':
 case 'nested-failure': {
  const trigger=['nested-failure','out-of-order-files','concurrent-test-failure'].includes(scenario)
   ? {id:'first-test-failure',kind:'test',command:'node',args:['--test','--test-reporter=tap',scenario==='out-of-order-files'?'--test-concurrency=2':'--test-concurrency=1',...(scenario==='out-of-order-files'?[${JSON.stringify(slowTests)},${JSON.stringify(lateFailureTests)}]:scenario==='concurrent-test-failure'?[${JSON.stringify(concurrentTests)}]:[${JSON.stringify(failingTests)},${JSON.stringify(laterTests)}])]}
   : scenario==='compiler-output-failure'
    ? {id:'first-compiler-failure',kind:'compile',command:'node',args:['--input-type=module','--eval',${JSON.stringify(`import{readFile}from'node:fs/promises';${awaitPeer}console.log('error TS9999: FIRST_COMPILER_FAILURE');setInterval(()=>{},1000);`)}]}
    : {id:'first-stage-failure',kind:'check',command:'node',args:['--input-type=module','--eval',${JSON.stringify(`import{readFile}from'node:fs/promises';${awaitPeer}process.exit(7);`)}]};
  stages=[{...trigger,parallelGroup:'failure'}, {id:'owned-peer-tree',kind:'check',command:'node',args:[${JSON.stringify(tree)}],parallelGroup:'failure'},node('owned-compile','compile',10000,{parallelGroup:'failure'}),{id:'must-not-start',kind:'check',command:'node',args:[${JSON.stringify(laterTests)}],parallelGroup:'failure'}];
  break;
 }
 default: throw new Error('Unknown fixture scenario');
}
if(scenario==='interruption') setTimeout(()=>process.emit('SIGTERM'),1000);
if(scenario==='unhandled') { void (async()=>{${awaitPeer}throw new Error('UNHANDLED_FIXTURE_FAILURE');})(); }
const verification={calls:0};
const sourceBefore=scenario.startsWith('verify-')?await readFile(${JSON.stringify(sourceFile)},'utf8'):undefined;
const details={
 scenario,cleanupObservations,streamSeen,
 ...(sourceBefore===undefined?{}:{snapshot:{source:sourceBefore},tools:{node:process.version,nodePath:process.execPath},verification}),
};
const report=await gate.run(stages,async (stage,onFailure)=>{
 if(stage.id==='hung-work') return new Promise(()=>{});
 const result=await commandOutput(stage.command,stage.args,{clock:gate.clock,onFailure,failFast:true,quiet:!streamFailures[scenario],failFastTests:stage.failFastTests||stage.kind==='test'&&stage.args.includes('--test'),failFastCompiler:stage.kind==='compile'});
 if(result.output) console.log(result.output);
 if(scenario==='failure-finally-hang') return new Promise(()=>{});
 return {status:result.code?'FAIL':'PASS',exitCode:result.code,...(result.reason?{reason:result.reason}:{})};
},details,scenario.startsWith('verify-')?async records=>{
 verification.calls++;
 await writeFile(${JSON.stringify(verifyRan)},'verify ran');
 await writeFile(${JSON.stringify(sourceFile)},'SOURCE_AFTER');
 const sourceAfter=await readFile(${JSON.stringify(sourceFile)},'utf8');
 if(sourceBefore!==sourceAfter) records.push({
  id:'source-snapshot',
  status:'UNVERIFIED_MISSING_ENV',
  reason:'Source changed during validation; results belong to different snapshots',
 });
}:scenario==='hung-verify'?()=>new Promise(()=>{}):undefined);
process.stdout.write=originalWrite;
process.exit(report.exitCode);
`,
  );
  // 修复依据：Windows 启动/清理可能耗尽 1.5 秒短预算，使故意退出的桩误报 TIMEOUT。
  // 普通状态验证留出启动余量；预算耗尽、累计及编译排除场景仍保留原短预算和全部判据。
  const run = async (
    level,
    scenario,
    limit = ["success", "failure", "missing", "denied", "compile-fail", "cache"].includes(scenario)
      ? 6
      : 1.5,
  ) => {
    if (["timeout", "interruption", "unauthed-timeout"].includes(scenario))
      await rm(childPid, { force: true });
    const result = await commandOutput("node", [fixture, level, scenario, root, String(limit)], {
      quiet: true,
    });
    const report = result.output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.level === level && "budgeted" in entry);
    assert.ok(report, `${level}/${scenario} must report every duration: ${result.output}`);
    for (const field of ["total", "compileExcluded", "budgeted", "limitSeconds"])
      assert.ok(Number.isFinite(report[field]) && report[field] >= 0, `${scenario}: ${field}`);
    assert.equal(report.limitSeconds, limit);
    assert.ok(Math.abs(report.total - report.compileExcluded - report.budgeted) <= 0.21);
    assert.match(result.output, /total=\d+\.\d+s/u);
    assert.match(result.output, /compile_excluded=\d+\.\d+s/u);
    assert.match(result.output, /budgeted=\d+\.\d+s/u);
    assert.match(result.output, /limit=\d+\.\d+s/u);
    assert.equal(result.code, report.exitCode);
    return { ...result, report };
  };
  for (const level of ["fastcheck", "fulltest", "slowtest"]) {
    const success = await run(level, "success");
    assert.equal(success.code, 0);
    assert.equal(success.report.status, "PASS");
    assert.equal(success.report.compileExcluded, 0);
    for (const scenario of ["failure", "missing"]) {
      const failed = await run(level, scenario);
      assert.notEqual(failed.code, 0);
      assert.equal(failed.report.status, "FAIL");
    }
    // fastcheck 不需要授权，其余入口必须在执行任何桩之前拒绝。
    if (level !== "fastcheck") {
      const denied = await run(level, "denied");
      assert.equal(denied.code, 2);
      await assert.rejects(() => readFile(join(root, "unauthorized-ran")));
    }
    for (const scenario of ["timeout", "interruption"]) {
      // Windows taskkill 本身需要计费；留足短桩清理余量，不放宽真实门禁上限。
      const limit = 6;
      const ended = await run(level, scenario, limit);
      assert.equal(ended.code, scenario === "timeout" ? 124 : 130);
      assert.equal(ended.report.status, scenario === "timeout" ? "TIMEOUT" : "CANCELLED");
      const pid = Number(await readFile(childPid, "utf8"));
      assert.throws(
        () => process.kill(pid, 0),
        `${level}/${scenario} must terminate its grandchild`,
      );
      assert.ok(
        ended.report.budgeted < limit,
        `${level}/${scenario}: ${JSON.stringify(ended.report)}`,
      );
    }
    const compile = await run(level, "compile-long");
    await exerciseHardDeadline(run, level, compile, childPid);
    const compilerFailure = await run(level, "compile-fail");
    assert.notEqual(compilerFailure.code, 0);
    assert.equal(compilerFailure.report.status, "FAIL");
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
      await assert.rejects(() => readFile(blocked));
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
        ],
        `${level}/${scenario} must stop the active group before admitting a later stage`,
      );
      const trigger = failed.report.stages[0];
      assert.equal(trigger.status, "FAIL");
      const pid = Number(await readFile(childPid, "utf8"));
      assert.throws(() => process.kill(pid, 0), `${level}/${scenario}: owned grandchild survived`);
      await assert.rejects(() => readFile(blocked));
      if (scenario === "compiler-cleanup") {
        assert.equal(trigger.reason, "error TS9999: PURE_COMPILER_FAILURE");
        assert.ok(
          failed.report.cleanupObservations.some(
            ({ compileActive, checkActive, wasCompileOnly, compileOnly, before, after }) =>
              compileActive === 3 &&
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
    for (const scenario of ["verify-source", "verify-failure"]) {
      await writeFile(sourceFile, "SOURCE_BEFORE");
      await rm(verifyRan, { force: true });
      const verified = await run(level, scenario, 10);
      assert.notEqual(verified.code, 0);
      assert.deepEqual(verified.report.snapshot, { source: "SOURCE_BEFORE" });
      assert.deepEqual(verified.report.tools, {
        node: process.version,
        nodePath: process.execPath,
      });
      if (scenario === "verify-source") {
        assert.equal(verified.report.status, "UNVERIFIED — REQUIRED ENVIRONMENT UNAVAILABLE");
        assert.equal(verified.report.stages[0].status, "PASS");
        assert.equal(verified.report.verification.calls, 1);
        assert.equal(await readFile(verifyRan, "utf8"), "verify ran");
        assert.equal(await readFile(sourceFile, "utf8"), "SOURCE_AFTER");
        assert.deepEqual(verified.report.stages[1], {
          id: "source-snapshot",
          status: "UNVERIFIED_MISSING_ENV",
          reason: "Source changed during validation; results belong to different snapshots",
        });
      } else {
        assert.equal(verified.report.status, "FAIL");
        assert.equal(verified.report.stages[0].status, "FAIL");
        assert.equal(verified.report.verification.calls, 0);
        assert.equal(await readFile(sourceFile, "utf8"), "SOURCE_BEFORE");
        await assert.rejects(() => readFile(verifyRan));
        assert.equal(
          verified.report.stages.some((stage) => stage.id === "source-snapshot"),
          false,
        );
      }
    }
  }
  const autonomousTimeout = await run("fastcheck", "unauthed-timeout", 6);
  assert.equal(
    autonomousTimeout.code,
    124,
    "fastcheck without a human flag still enforces its budget",
  );
  assert.equal(autonomousTimeout.report.status, "TIMEOUT");
  const autonomousPid = Number(await readFile(childPid, "utf8"));
  assert.throws(() => process.kill(autonomousPid, 0));
  for (const scenario of ["overlap", "serial-budget", "mixed"]) {
    // full/slow 的编译、重叠、混合和连续阶段全部使用同一总墙钟截止。
    const timed = await run("fulltest", scenario);
    assert.equal(timed.code, 124, `${scenario} must consume the same total wall clock`);
    assert.equal(timed.report.status, "TIMEOUT");
  }
  const parallel = await run("fulltest", "parallel", 6);
  assert.equal(parallel.code, 0);
  assert.ok(
    parallel.report.budgeted <
      parallel.report.stages.reduce((sum, stage) => sum + stage.seconds, 0),
    "Parallel wall time must not sum all child durations",
  );
  const initial = await run("fastcheck", "cache");
  assert.equal(initial.code, 0);
  assert.match(initial.output, /CACHE_CREATED/u);
  const artifact = await stat(cache);
  const repeated = await run("fastcheck", "cache");
  assert.equal(repeated.code, 0);
  assert.match(repeated.output, /CACHE_REUSED/u);
  assert.equal((await stat(cache)).mtimeMs, artifact.mtimeMs);
  assert.equal(await readFile(cache, "utf8"), "reusable-build-artifact");
  console.log(
    "Entry self-tests PASS: all-tier reports/statuses, fastcheck compile exclusion, full/slow hard wall deadlines, hung work/verification/cleanup, first failure, cancellation/tree cleanup, concurrency and reusable cache",
  );
}
