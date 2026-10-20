import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { startCommand, stopCommand } from "./test-gates-process.mjs";

export async function artifactCancelSelfTest(root) {
  for (const comparison of [false, true]) await cancelDuringArtifactIO(root, comparison);
}

async function cancelDuringArtifactIO(root, comparison) {
  const fixture = join(root, comparison ? "artifact-compare-cancel" : "artifact-cancel");
  await mkdir(fixture);
  const source = join(fixture, "cache.txt");
  const destination = join(fixture, "consumer.txt");
  const release = join(fixture, "release");
  const laterStage = join(fixture, "later-stage");
  const refusedCopy = join(fixture, "refused-copy");
  const contents = "real cached artifact\n取消等待 chmod\n";
  await writeFile(source, contents);
  await chmod(source, 0o444);
  await writeFile(destination, comparison ? contents : "stale consumer content");
  await chmod(destination, 0o444);
  const sourceMode = (await stat(source)).mode & 0o777;
  const entry = join(fixture, "entry.mjs");
  const artifacts = new URL("./test-gates-artifacts.mjs", import.meta.url).href;
  const runner = new URL("./test-gates-run.mjs", import.meta.url).href;
  const processes = new URL("./test-gates-process.mjs", import.meta.url).href;
  await writeFile(
    entry,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const source=${JSON.stringify(source)};
const destination=${JSON.stringify(destination)};
const release=${JSON.stringify(release)};
const comparison=${JSON.stringify(comparison)};
const originalCopy=fs.promises.copyFile;
const originalOpen=fs.promises.open;
let gate;
let io;
let commandsAreCancelled;
// 延迟真实 IO 的完成通知，分别覆盖复制后的权限恢复和真实内容比较。
const pause=async ()=>{
 assert.equal(await fs.promises.readFile(destination,'utf8'),${JSON.stringify(contents)});
 assert.equal((await fs.promises.stat(destination)).mode & 0o200,0);
 const barrier=new Promise((resolve,reject)=>{
  const watcher=fs.watch(${JSON.stringify(fixture)},async (_event,name)=>{
   if(String(name)!=='release') return;
   try {await fs.promises.access(release);watcher.close();resolve();}
   catch(error){watcher.close();reject(error);}
  });
  watcher.once('error',reject);
 });
 process.emit('SIGTERM');
 setImmediate(async ()=>{
  assert.equal(commandsAreCancelled(),true);
  await assert.rejects(io.copy(source,${JSON.stringify(refusedCopy)}),/cancelled/iu);
  await assert.rejects(io.prepare(source),/cancelled/iu);
  fs.writeSync(1,'ARTIFACT_IO_STILL_WAITING\\n');
 });
 await barrier;
};
if(comparison) {
 fs.promises.open=async (...args)=>{
  const handle=await originalOpen(...args);
  if(String(args[0])===${JSON.stringify(process.platform === "win32" ? toNamespacedPath(destination) : destination)}) {
   const originalRead=handle.read.bind(handle);
   let paused=false;
   handle.read=async (...readArgs)=>{
    const result=await originalRead(...readArgs);
    if(!paused) {paused=true;await pause();}
    return result;
   };
  }
  return handle;
 };
} else {
 fs.promises.copyFile=async (...args)=>{
  await originalCopy(...args);
  await pause();
 };
}
syncBuiltinESMExports();
const {createArtifactIO}=await import(${JSON.stringify(artifacts)});
const {createGateRun}=await import(${JSON.stringify(runner)});
({commandsAreCancelled}=await import(${JSON.stringify(processes)}));
io=createArtifactIO();
gate=createGateRun({level:'fastcheck',signals:['SIGTERM']});
await gate.run(async (records)=>{
 if(comparison) await assert.rejects(io.copy(source,destination),/cancelled/iu);
 else await io.copy(source,destination);
 assert.equal(commandsAreCancelled(),true);
 fs.writeSync(1,'ARTIFACT_IO_SETTLED_AFTER_CANCEL\\n');
 if(!commandsAreCancelled()) fs.writeFileSync(${JSON.stringify(laterStage)},'admitted');
 records.push({id:'artifact-copy',status:'PASS'});
});
`,
  );
  const child = startCommand("node", [entry], { quiet: true, stageId: "artifact-cancel" });
  let output = "";
  let acknowledge;
  const receipt = new Promise((resolve) => {
    acknowledge = resolve;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    output += text;
    if (output.includes("ARTIFACT_IO_STILL_WAITING\n")) acknowledge("waiting");
  });
  child.stderr.on("data", (text) => {
    output += text;
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const first = await Promise.race([receipt, closed]);
    assert.equal(first, "waiting", `Gate exited before admitted IO drained: ${output}`);
    assert.doesNotMatch(output, /cleanup-complete|"status":"(?:PASS|FAIL|CANCELLED)"/u);
    assert.equal(await readFile(destination, "utf8"), contents);
    assert.equal((await stat(destination)).mode & 0o200, 0);
    await writeFile(release, "release real copy completion");
    const result = await closed;
    assert.equal(result.code, 130, output);
    assert.equal(result.signal, null, output);
    const reports = output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .filter((report) => report.level === "fastcheck" && "status" in report);
    assert.equal(reports.length, 1, output);
    assert.equal(reports[0].status, "CANCELLED", output);
    assert.equal(reports[0].exitCode, 130, output);
    assert.match(output, /ARTIFACT_IO_SETTLED_AFTER_CANCEL/u);
    assert.ok(output.indexOf("cleanup-complete") > output.indexOf("ARTIFACT_IO_STILL_WAITING"));
    assert.equal(await readFile(destination, "utf8"), contents);
    if (comparison) {
      // 比较在取消时停止，未写入的只读目的保持原状；后续复制/生产者未获准入。
      assert.equal((await stat(destination)).mode & 0o200, 0);
      await chmod(destination, 0o666);
    } else assert.notEqual((await stat(destination)).mode & 0o200, 0);
    await writeFile(destination, "consumer can overwrite after cancellation");
    assert.equal(await readFile(destination, "utf8"), "consumer can overwrite after cancellation");
    assert.equal(await readFile(source, "utf8"), contents);
    assert.equal((await stat(source)).mode & 0o777, sourceMode);
    for (const path of [laterStage, refusedCopy])
      await assert.rejects(stat(path), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) await stopCommand(child);
  }
}
