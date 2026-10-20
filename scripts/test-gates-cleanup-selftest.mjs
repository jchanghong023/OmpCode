import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandOutput } from "./test-gates-process.mjs";

export async function exerciseCleanupFailure(root, fixtureEnv) {
  // 执行真实入口的清理回调，只替换外部恢复/输入适配器；不用源码文本断言代替行为。
  const cleanupEntry = join(root, "entry-cleanup-failure.mjs");
  const runtimeInput = join(root, "entry-runtime.json");
  const entry = pathToFileURL(resolve("scripts/test-gates.mjs")).href;
  const environments = pathToFileURL(resolve("scripts/test-gates-environments.mjs")).href;
  const bazel = pathToFileURL(resolve("scripts/test-gates-bazel.mjs")).href;
  await writeFile(runtimeInput, JSON.stringify({ env: { FIXTURE_SECRET: "run-owned" } }));
  await writeFile(
    cleanupEntry,
    `
import {registerHooks} from 'node:module';
registerHooks({
 load(url,context,nextLoad){
  if(url===${JSON.stringify(environments)}) return {format:'module',shortCircuit:true,source:
   "export * from "+JSON.stringify(url+"?actual")+";export async function restorePackagingState(){throw new Error('RESTORE_FIXTURE_FAILURE');}"};
  if(url===${JSON.stringify(bazel)}) return {format:'module',shortCircuit:true,source:
   "export * from "+JSON.stringify(url+"?actual")+";import {rm} from 'node:fs/promises';export async function cleanupBazelInputs(){await rm("+${JSON.stringify(JSON.stringify(runtimeInput))}+",{force:true});}"};
  return nextLoad(url,context);
 }
});
// argv 的入口必须是磁盘路径；file: URL 只用于 import，否则 realpathSync 在 Windows 解析失败。
process.argv=[process.execPath,${JSON.stringify(resolve("scripts/test-gates.mjs"))},'fulltest'];
await import(${JSON.stringify(entry)});
`,
  );
  const restoreFailed = await commandOutput("node", [cleanupEntry], {
    quiet: true,
    env: fixtureEnv,
  });
  assert.equal(restoreFailed.code, 1, restoreFailed.output);
  assert.match(restoreFailed.output, /"status":"FAIL"/u);
  assert.match(restoreFailed.output, /"cleanupError":"RESTORE_FIXTURE_FAILURE"/u);
  await assert.rejects(readFile(runtimeInput), { code: "ENOENT" });
}
