import assert from "node:assert/strict";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandOutput } from "./test-gates-process.mjs";

// 只在临时目录运行短桩；和真实入口共用生命周期，不提供绕过真实计划的 CLI/env 开关。
export async function exerciseEntryMechanisms(root, { failure, tree, childPid }) {
  const runner = pathToFileURL(resolve("scripts/test-gates-run.mjs")).href;
  const processModule = pathToFileURL(resolve("scripts/test-gates-process.mjs")).href;
  const fixture = join(root, "entry-fixture.mjs");
  const cache = join(root, "build.tsbuildinfo");
  await writeFile(
    fixture,
    `
import {createGateRun} from ${JSON.stringify(runner)};
import {commandOutput} from ${JSON.stringify(processModule)};
import {readFile,writeFile} from 'node:fs/promises';
const [level,scenario,root,limit]=process.argv.slice(2);
const gate=createGateRun({level,limitSeconds:Number(limit),authorized:!['denied','unauthed-timeout'].includes(scenario),signals:['SIGTERM']});
const waitCode=ms=>'setTimeout(()=>{},'+ms+')';
const node=(id,kind,ms,extra={})=>({id,kind,command:'node',args:['--eval',waitCode(ms)],...extra});
let stages;
switch(scenario){
 case 'success': stages=[node('check','check',100)]; break;
 case 'failure': stages=[{id:'failure',kind:'check',command:'node',args:[${JSON.stringify(failure)}]}]; break;
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
 default: throw new Error('Unknown fixture scenario');
}
if(scenario==='interruption') setTimeout(()=>process.emit('SIGTERM'),1000);
const report=await gate.run(stages,async stage=>{
 const result=await commandOutput(stage.command,stage.args,{quiet:true});
 if(result.output) console.log(result.output);
 return {status:result.code?'FAIL':'PASS',exitCode:result.code};
},{scenario});
process.exitCode=report.exitCode;
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
    assert.equal(compile.code, 0, "Long pure compilation must not inherit a charged wall timeout");
    assert.equal(compile.report.status, "PASS");
    assert.ok(compile.report.total > 1.5 && compile.report.compileExcluded > 2);
    assert.ok(compile.report.budgeted < 1.5);
    const compilerFailure = await run(level, "compile-fail");
    assert.notEqual(compilerFailure.code, 0);
    assert.equal(compilerFailure.report.status, "FAIL");
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
    // 编译先启动的独占短区间可以排除；重叠、混合和串行场景仍必须耗尽同一计费预算。
    const timed = await run("fulltest", scenario);
    assert.equal(timed.code, 124, `${scenario} must consume the same non-compilation clock`);
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
    "Entry self-tests PASS: all-tier reports/statuses, compile-only exclusion, charged overlap, cumulative budget, cancellation/tree cleanup, concurrency and reusable cache",
  );
}
