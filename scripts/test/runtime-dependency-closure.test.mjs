import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectRuntimeModuleClosureEntries } from "../../packages/desktop/scripts/runtime-dependency-closure.mjs";

test("与 Node 内置模块同名的 npm 依赖必须收集真实包，不能复制当前工作目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-runtime-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  const dependencyNames = ["buffer", "string_decoder"];
  for (const name of ["consumer", ...dependencyNames]) {
    const directory = join(modules, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name,
      version: "1.0.0",
      main: "index.js",
      ...(name === "consumer" ? { dependencies: { buffer: "1.0.0", string_decoder: "1.0.0" } } : {}),
    }));
    await writeFile(join(directory, "index.js"), "module.exports = {};\n");
  }
  const entries = collectRuntimeModuleClosureEntries(["consumer"], [root]);
  assert.deepEqual(entries.map((entry) => entry.moduleName), ["consumer", ...dependencyNames]);
  for (const entry of entries) {
    assert.equal(entry.sourceModulePath, join(modules, entry.moduleName));
    assert.equal(entry.packageJsonPath, join(modules, entry.moduleName, "package.json"));
  }
});
