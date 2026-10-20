import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandOutput } from "./test-gates-process.mjs";
import { exerciseCleanupFailure } from "./test-gates-cleanup-selftest.mjs";

// Only the outer deadline, process ownership and immediate node:test adapter need
// short stubs. Native scheduling/cache/dependency assertions live in bazelSelfTest.
export async function exerciseEntryMechanisms(root, { failure, tree, childPid }) {
  const runner = pathToFileURL(resolve("scripts/test-gates-run.mjs")).href;
  const fixtureEnv = { ...process.env };
  if (process.platform === "win32") {
    // 显式覆盖 Bazel 的大写环境边界，不能只在主线程大小写不敏感的 env 上验证清理。
    const systemRoot = process.env.SystemRoot;
    for (const key of Object.keys(fixtureEnv))
      if (key.toUpperCase() === "SYSTEMROOT") delete fixtureEnv[key];
    fixtureEnv.SYSTEMROOT = systemRoot;
  }
  const processModule = pathToFileURL(resolve("scripts/test-gates-process.mjs")).href;
  const fixture = join(root, "outer-lifecycle.mjs");
  const first = join(root, "first.test.mjs");
  const slow = join(root, "slow.test.mjs");
  const later = join(root, "later.test.mjs");
  const nested = join(root, "nested.test.mjs");
  const compiler = join(root, "compiler-stream.mjs");
  const environments = pathToFileURL(resolve("scripts/test-gates-environments.mjs")).href;
  const template = join(root, "shared-installSection.nsh");
  const originalTemplate = Buffer.from("original NSIS template\r\n原始内容\r\n");
  const packagingWriter = join(root, "packaging-writer.mjs");
  const framedGui = join(root, "framed-gui.mjs");
  await writeFile(
    packagingWriter,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(template)},'mutated template');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000);`,
  );
  await writeFile(
    framedGui,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));process.stdout.write('GUI_OUTPUT_BEFORE_FAILURE\\n');process.stderr.write('\\u001eOMP_TEST_');setTimeout(()=>{process.stdout.write('GUI_OUTPUT_BETWEEN_FRAME_CHUNKS\\n');process.stderr.write('FAILURE '+JSON.stringify({name:'GUI live',error:'GUI_FIRST_FAILURE'})+'\\n');setInterval(()=>{},1000);},30);`,
  );
  await writeFile(
    compiler,
    "process.stdout.write('error T');setTimeout(()=>{process.stderr.write('COMPILER_STDERR_BETWEEN\\n');setTimeout(()=>{process.stdout.write('S9999: FIRST_COMPILER_FAILURE\\n');setInterval(()=>{},1000);},20);},20);",
  );
  const lifecycleFiles = {};
  for (const [scenario, code] of Object.entries({
    collection: "throw new Error('COLLECTION_FAILURE');",
    setup:
      "import test,{before} from 'node:test';before(()=>{throw new Error('SETUP_FAILURE');});test('body',()=>{});",
    teardown:
      "import test,{after} from 'node:test';after(()=>{throw new Error('TEARDOWN_FAILURE');});test('body',()=>{});",
    "worker-crash": "process.exit(23);",
  })) {
    lifecycleFiles[scenario] = join(root, `${scenario}.test.mjs`);
    await writeFile(lifecycleFiles[scenario], code);
  }
  await writeFile(
    first,
    "import test from 'node:test';import assert from 'node:assert/strict';test('first failure',()=>assert.fail('FIRST_CASE_FAILURE'));test('pending',async()=>{await new Promise(r=>setTimeout(r,10000));});",
  );
  await writeFile(
    slow,
    "import test from 'node:test';test('earlier slow file',async()=>{await new Promise(r=>setTimeout(r,10000));});",
  );
  await writeFile(
    later,
    "import test from 'node:test';import assert from 'node:assert/strict';test('later failure',()=>assert.fail('LATER_CASE_FAILURE'));",
  );
  await writeFile(
    nested,
    "import test from 'node:test';import assert from 'node:assert/strict';test('suite',{concurrency:2},async t=>{await Promise.all([t.test('slow child',async()=>{await new Promise(r=>setTimeout(r,10000));}),t.test('later child',()=>assert.fail('NESTED_CASE_FAILURE'))]);});",
  );
  await writeFile(
    fixture,
    `
import {createGateRun} from ${JSON.stringify(runner)};
import {commandOutput,startCommand,watchBudgetTargets,registerTreeKiller,cancelCommands,stopAll} from ${JSON.stringify(processModule)};
import {regularStage,snapshotPackagingState,restorePackagingState} from ${JSON.stringify(environments)};
import {readFile} from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const [level,scenario,limit]=process.argv.slice(2);
const gate=createGateRun({level,limitSeconds:Number(limit),authorized:scenario!=='denied',signals:['SIGTERM'],cleanup:scenario==='hung-cleanup'?()=>new Promise(()=>{}):scenario==='packaging-cancel'?restorePackagingState:undefined});
const cleanupObservations=[];
if(scenario==='compiler-stream'){
 const enter=gate.clock.enter.bind(gate.clock);
 gate.clock.enter=kind=>{
  const wasCompileOnly=gate.clock.compileOnly();
  const end=enter(kind);
  const before=wasCompileOnly&&kind!=='compile'?gate.clock.read():undefined;
  return ()=>{
   if(before) cleanupObservations.push({before,after:gate.clock.read()});
   end();
  };
 };
}
if(scenario==='blocked-report'){
 const original=fs.writeSync;
 fs.writeSync=(fd,text,...rest)=>{
  if(String(text).startsWith(level+':')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  return original(fd,text,...rest);
 };
 syncBuiltinESMExports();
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const execute=async(args,onFailure,options={})=>{
 const result=await commandOutput('node',args,{quiet:true,clock:gate.clock,failFast:true,onFailure:failure=>onFailure({...failure,id:'native-group'}),...options});
 if(result.output) console.log(result.output);
 return {id:'native-group',status:result.code?'FAIL':'PASS',exitCode:result.code,...(result.reason?{reason:result.reason}:{})};
};
const report=await gate.run(async(records,onFailure)=>{
 if(scenario==='tree-killer-cancel'||scenario==='tree-killer-success'){
  const cancelled=scenario==='tree-killer-cancel';
  const unregister=registerTreeKiller(()=>cleanupObservations.push('cleanup'));
  const child=startCommand('node',['--eval',cancelled?"process.stdout.write('ready');setInterval(()=>{},1000);":''],{quiet:true});
  const closed=new Promise(resolve=>child.once('close',()=>{
   if(cancelled){
    unregister();
    cleanupObservations.push('unregistered');
   }
   resolve();
  }));
  if(cancelled){
   await new Promise(resolve=>child.stdout.once('data',resolve));
   cancelCommands();
   await stopAll(gate.clock);
  } else {
   await closed;
   await stopAll(gate.clock);
   unregister();
   cleanupObservations.push('unregistered');
  }
  await closed;
  records.push({id:'native-group',status:cancelled?'FAIL':'PASS',exitCode:cancelled?1:0});
  return;
 }
 if(scenario==='packaging-cancel'){
  await snapshotPackagingState(${JSON.stringify(template)});
  void (async()=>{
   while(!await readFile(${JSON.stringify(childPid)}).then(()=>true,()=>false)) await wait(10);
   process.emit('SIGTERM');
  })();
  records.push(await execute([${JSON.stringify(packagingWriter)}],onFailure));
  return;
 }
 if(scenario==='framed-gui'){
  const result=await regularStage({id:'gui-lifecycle',kind:'test',command:'node',args:[${JSON.stringify(framedGui)}]},{
   clock:gate.clock,onFailure:failure=>onFailure({...failure,id:'native-group'}),
  });
  if(!records.some(record=>record.id==='native-group')) records.push({...result,id:'native-group'});
  return;
 }
 if(['blocked-loop','blocked-compile','blocked-native'].includes(scenario)){
  startCommand('node',[${JSON.stringify(tree)}],{quiet:true});
  while(!await readFile(${JSON.stringify(childPid)}).then(()=>true,()=>false)) await wait(10);
  if(scenario==='blocked-native'){
   const live=${JSON.stringify(join(root, "blocked-native.live"))};
   watchBudgetTargets([live]);
   const code="const fs=require('node:fs');const p="+JSON.stringify(live)+";const frame=event=>'\\\\u001eOMP_GATE_KIND '+JSON.stringify({event,kind:'compile',time:Number(process.hrtime.bigint()/1_000_000n)})+'\\\\n';fs.writeFileSync(p,frame('start'));setTimeout(()=>fs.appendFileSync(p,frame('end')),500);";
   startCommand('node',['--eval',code],{quiet:true});
   while(!await readFile(live).then(text=>text.includes('start'),()=>false)) await wait(10);
   gate.clock.enter('compile');
  }
  if(scenario==='blocked-compile') gate.clock.enter('compile');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 if(scenario==='hung-work') return new Promise(()=>{});
 if(scenario==='late-pass'){
  onFailure({id:'native-group',status:'FAIL',exitCode:7,reason:'FIRST_ACCEPTED_FAILURE'});
  return;
 }
 if(['timeout','interruption','unhandled'].includes(scenario)){
  if(['interruption','unhandled'].includes(scenario)) void (async()=>{
   while(!await readFile(${JSON.stringify(childPid)}).then(()=>true,()=>false)) await wait(10);
   if(scenario==='interruption') process.emit('SIGTERM');
   else throw new Error('UNHANDLED_FIXTURE_FAILURE');
  })();
  records.push(await execute([${JSON.stringify(tree)}],onFailure));
  return;
 }
 if(scenario==='compile'||scenario==='overlap'){
  const end=gate.clock.enter('compile');
  const charged=scenario==='overlap'?gate.clock.enter('test'):undefined;
  try {await wait(2600);records.push({id:'native-group',status:'PASS'});}
  finally {charged?.();end();}
  return;
 }
 if(scenario==='serial-budget'){
  for(let i=0;i<3;i++){await wait(600);records.push({id:'group-'+i,status:'PASS'});}
  return;
 }
 if(scenario==='compiler-stream'){
  const end=gate.clock.enter('compile');
  try {
   const result=await execute([${JSON.stringify(compiler)}],onFailure,{failFastCompiler:true,quiet:false});
   if(!records.some(record=>record.id===result.id)) records.push(result);
  } finally {end();}
  return;
 }
 const cases={first:['--test',${JSON.stringify(first)}],later:['--test','--test-concurrency=2',${JSON.stringify(slow)},${JSON.stringify(later)}],nested:['--test',${JSON.stringify(nested)}],...Object.fromEntries(Object.entries(${JSON.stringify(lifecycleFiles)}).map(([name,path])=>[name,['--test',path]]))};
 const args=cases[scenario]??(scenario.startsWith('failure')?[${JSON.stringify(failure)}]:['--eval','setTimeout(()=>{},50)']);
 const result=await execute(args,onFailure,{failFastTests:Boolean(cases[scenario])});
 if(scenario==='failure-finally-hang') await new Promise(()=>{});
 if(!records.some(record=>record.id===result.id)) records.push(result);
},{scenario,cleanupObservations},scenario==='hung-verify'?()=>new Promise(()=>{}):scenario==='verify-source'?records=>records.push({id:'source-snapshot',status:'UNVERIFIED_MISSING_ENV',reason:'Source changed during validation'}):undefined);
process.exit(report.exitCode);
`,
  );
  const run = async (level, scenario, limit = 6) => {
    await rm(childPid, { force: true });
    if (scenario === "packaging-cancel") await writeFile(template, originalTemplate);
    const result = await commandOutput("node", [fixture, level, scenario, String(limit)], {
      quiet: true,
      env: fixtureEnv,
    });
    const report = result.output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.level === level && "budgeted" in entry);
    assert.ok(report, `${level}/${scenario}: ${result.output}`);
    for (const field of ["total", "compileExcluded", "budgeted", "limitSeconds"])
      assert.ok(Number.isFinite(report[field]) && report[field] >= 0, `${scenario}/${field}`);
    assert.equal(report.limitSeconds, limit);
    if (report.status === "TIMEOUT") assert.notEqual(result.code, 0);
    else assert.equal(result.code, report.exitCode);
    assert.ok(Math.abs(report.total - report.compileExcluded - report.budgeted) < 0.01);
    return { ...result, report };
  };
  for (const level of ["fastcheck", "fulltest", "slowtest"]) {
    assert.equal((await run(level, "success")).report.status, "PASS");
    const failed = await run(level, "failure");
    assert.equal(failed.report.status, "FAIL", failed.output);
    const late = await run(level, "late-pass");
    assert.equal(late.report.stages[0].reason, "FIRST_ACCEPTED_FAILURE");
    assert.equal(late.report.status, "FAIL");
    const hangingFailure = await run(level, "failure-finally-hang");
    assert.equal(hangingFailure.report.status, "FAIL", hangingFailure.output);
    assert.ok(hangingFailure.report.total < 5, hangingFailure.output);
    if (level !== "fastcheck") assert.equal((await run(level, "denied")).code, 2);
    const compiled = await run(level, "compile", 1.5);
    if (level === "fastcheck") assert.equal(compiled.code, 0, compiled.output);
    else assert.equal(compiled.report.status, "TIMEOUT", compiled.output);
    if (level === "fastcheck") {
      assert.ok(compiled.report.compileExcluded > 2);
      assert.ok(compiled.report.budgeted < 1.5);
    }
    for (const scenario of [
      "hung-work",
      "hung-verify",
      "hung-cleanup",
      "overlap",
      "serial-budget",
      "timeout",
    ]) {
      const timed = await run(level, scenario, 1.5);
      assert.notEqual(timed.code, 0, `${level}/${scenario}: ${timed.output}`);
      assert.equal(timed.report.status, "TIMEOUT");
      if (scenario === "hung-cleanup") assert.ok(timed.report.total <= 1.65, timed.output);
      if (scenario === "timeout") {
        const pid = Number(await readFile(childPid, "utf8"));
        assert.throws(() => process.kill(pid, 0), "Deadline must remove owned grandchildren");
      }
    }
    for (const [scenario, status, code] of [
      ["interruption", "CANCELLED", 130],
      ["unhandled", "FAIL", 1],
    ]) {
      const stopped = await run(level, scenario);
      assert.equal(stopped.report.status, status, stopped.output);
      assert.equal(stopped.code, code);
      const pid = Number(await readFile(childPid, "utf8"));
      assert.throws(() => process.kill(pid, 0), `${scenario}: owned grandchild survived`);
    }
    const changed = await run(level, "verify-source");
    assert.notEqual(changed.code, 0);
    assert.equal(changed.report.stages.at(-1).id, "source-snapshot");
  }
  // close 注销后仍必须执行取消时已接管的清理器；成功退出不能杀常驻 server。
  const cancelledKiller = await run("fulltest", "tree-killer-cancel");
  assert.equal(cancelledKiller.report.status, "FAIL", cancelledKiller.output);
  assert.notEqual(cancelledKiller.code, 0);
  assert.deepEqual(cancelledKiller.report.cleanupObservations, ["unregistered", "cleanup"]);
  const successfulKiller = await run("fulltest", "tree-killer-success");
  assert.equal(successfulKiller.report.status, "PASS", successfulKiller.output);
  assert.deepEqual(successfulKiller.report.cleanupObservations, ["unregistered"]);

  await exerciseCleanupFailure(root, fixtureEnv);
  const framed = await run("fulltest", "framed-gui");
  assert.equal(framed.report.status, "FAIL", framed.output);
  assert.match(framed.report.stages[0].reason, /GUI live: GUI_FIRST_FAILURE/u);
  assert.match(framed.output, /GUI_OUTPUT_BEFORE_FAILURE/u);
  assert.match(framed.output, /GUI_OUTPUT_BETWEEN_FRAME_CHUNKS/u);
  assert.ok(framed.report.total < 5, "Non-test failure frame must not wait for GUI exit");
  const guiPid = Number(await readFile(childPid, "utf8"));
  assert.throws(() => process.kill(guiPid, 0), "First failure must stop the GUI process");
  const cancelledPackage = await run("slowtest", "packaging-cancel");
  assert.equal(cancelledPackage.report.status, "CANCELLED", cancelledPackage.output);
  assert.deepEqual(await readFile(template), originalTemplate);
  const packagingPid = Number(await readFile(childPid, "utf8"));
  assert.throws(() => process.kill(packagingPid, 0), "Restore must follow owned process exit");
  for (const level of ["fulltest", "slowtest"]) {
    for (const [scenario, evidence] of [
      ["first", "FIRST_CASE_FAILURE"],
      ["later", "LATER_CASE_FAILURE"],
      ["nested", "NESTED_CASE_FAILURE"],
      ["collection", "COLLECTION_FAILURE"],
      ["setup", "SETUP_FAILURE"],
      ["teardown", "TEARDOWN_FAILURE"],
      ["worker-crash", "23"],
    ]) {
      const failed = await run(level, scenario);
      assert.equal(failed.report.status, "FAIL", failed.output);
      assert.match(failed.output, new RegExp(evidence, "u"));
      if (["first", "later", "nested"].includes(scenario))
        assert.match(failed.report.stages[0].reason, new RegExp(evidence, "u"));
      assert.ok(
        failed.report.total < 5,
        "Node failure cannot wait for ordered TAP or pending tests",
      );
    }
  }
  for (const level of ["fastcheck", "fulltest", "slowtest"]) {
    const failed = await run(level, "compiler-stream");
    assert.equal(failed.report.status, "FAIL", failed.output);
    assert.match(failed.report.stages[0].reason, /error TS9999: FIRST_COMPILER_FAILURE/u);
    assert.match(failed.output, /COMPILER_STDERR_BETWEEN/u);
    assert.ok(failed.report.total < 5, "Compiler first diagnostic must not await process exit");
    assert.ok(
      failed.report.cleanupObservations.some(
        ({ before, after }) =>
          after.budgeted > before.budgeted && after.compileExcluded === before.compileExcluded,
      ),
      `Cleanup while compilation is active must charge wall time: ${failed.output}`,
    );
  }
  for (const level of ["fastcheck", "fulltest", "slowtest"]) {
    for (const scenario of [
      "blocked-loop",
      "blocked-compile",
      "blocked-native",
      "blocked-report",
    ]) {
      await rm(childPid, { force: true });
      await rm(join(root, "blocked-native.live"), { force: true });
      const started = performance.now();
      const stopped = await commandOutput("node", [fixture, level, scenario, "1.5"], {
        quiet: true,
        env: fixtureEnv,
      });
      assert.notEqual(stopped.code, 0, `${level}/${scenario}: watchdog must force OS termination`);
      const elapsed = (performance.now() - started) / 1000;
      const forcedReport = stopped.output
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .findLast((entry) => entry.forcedTermination);
      const excluded =
        level === "fastcheck"
          ? (forcedReport?.compileExcluded ??
            (scenario === "blocked-native" ? 0.5 : scenario === "blocked-compile" ? 0.2 : 0))
          : 0;
      assert.ok(
        elapsed - excluded <= 1.65,
        `${level}/${scenario}: actual=${elapsed.toFixed(3)}s excluded=${excluded.toFixed(3)}s charged=${(elapsed - excluded).toFixed(3)}s limit=1.5s; ${stopped.output}`,
      );
      // A blocked destination cannot guarantee delivery, but any delivered final
      // evidence must identify the independent timeout rather than a false PASS.
      if (stopped.output.includes("Independent whole-run watchdog")) {
        assert.match(stopped.output, /"status":"TIMEOUT"/u);
        assert.match(stopped.output, /"exitCode":null/u);
        assert.match(stopped.output, /"requestedExitCode":124/u);
        assert.match(stopped.output, /"forcedTermination":true/u);
      }
      if (scenario !== "blocked-report") {
        const pid = Number(await readFile(childPid, "utf8"));
        assert.throws(() => process.kill(pid, 0), `${scenario}: owned grandchild survived`);
      }
    }
  }
}
