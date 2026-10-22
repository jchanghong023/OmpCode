import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cliDirectory = fileURLToPath(new URL("..", import.meta.url));
const runEntry = new URL("../src/run.ts", import.meta.url).href;
const storageEntry = new URL("../../adapters/src/storage/index.ts", import.meta.url).href;

async function runIsolated(body: string) {
  // 独立进程确保先删除 crypto / 注入版本，再首次加载真实 CLI 入口，不能被其他 UT 的模块缓存掩盖。
  const { stdout } = await execute(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", body],
    { cwd: cliDirectory, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

const helpInvocation = `
  const { run } = await import(${JSON.stringify(runEntry)});
  let output = "";
  const stream = { write(chunk) { output += String(chunk); return true; }, isTTY: false };
  const code = await run({ argv: ["--help"], stdin: { isTTY: false }, stdout: stream, stderr: stream });
  assert.equal(code, 0);
  assert.match(output, /--help/);
`;

test("Node 18 CLI entry avoids node:sqlite and reaches the shared lazy legacy driver", async () => {
  const result = await runIsolated(`
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    Object.defineProperty(process.versions, "node", { value: "18.18.2", configurable: true });
    Object.defineProperty(process, "getBuiltinModule", { value: undefined, configurable: true });
    Reflect.deleteProperty(globalThis, "crypto");
    const loads = [];
    const unavailable = new Error("injected legacy addon unavailable");
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "node:sqlite" || specifier === "sqlite" || specifier === "node:sea") {
        throw new Error("Node 18 must never resolve unavailable SQLite/SEA builtins");
      }
      if (specifier === "better-sqlite3") { loads.push(specifier); throw unavailable; }
      return nextResolve(specifier, context);
    } });
    ${helpInvocation}
    assert.deepEqual(loads, []);
    const { createSqliteSessionStore } = await import(${JSON.stringify(storageEntry)});
    await assert.rejects(createSqliteSessionStore({ dbPath: ":memory:" }), error => {
      assert.equal(error.cause, unavailable);
      return true;
    });
    assert.deepEqual(loads, ["better-sqlite3"]);
    console.log(JSON.stringify({ help: true, legacyLoads: loads }));
  `);
  assert.deepEqual(result, { help: true, legacyLoads: ["better-sqlite3"] });
});

test("CLI entry restores missing WebCrypto before the shared UUID v7 call", async () => {
  const result = await runIsolated(`
    import assert from "node:assert/strict";
    import { webcrypto } from "node:crypto";
    Reflect.deleteProperty(globalThis, "crypto");
    assert.equal(globalThis.crypto, undefined);
    ${helpInvocation}
    assert.equal(globalThis.crypto, webcrypto);
    const { uuidv7 } = await import("@zcode/shared");
    const id = uuidv7(123456);
    assert.match(id, /^00000001-e240-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    console.log(JSON.stringify({ restored: true, id }));
  `);
  assert.equal(result.restored, true);
});

test("modern CLI keeps native WebCrypto and SQLite storage behavior", async () => {
  const result = await runIsolated(`
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const originalCrypto = globalThis.crypto;
    assert.ok(originalCrypto);
    const loads = [];
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "better-sqlite3") throw new Error("modern CLI must not load legacy addon");
      if (specifier === "node:sqlite") loads.push(specifier);
      return nextResolve(specifier, context);
    } });
    ${helpInvocation}
    assert.equal(globalThis.crypto, originalCrypto);
    const { createSqliteSessionStore } = await import(${JSON.stringify(storageEntry)});
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      assert.ok(store.debugMigrationIds().length > 0);
      assert.deepEqual(await store.listSessions(), []);
    } finally { store.close(); }
    assert.ok(loads.length > 0);
    console.log(JSON.stringify({ nativeCrypto: true, nativeSqlite: true }));
  `);
  assert.deepEqual(result, { nativeCrypto: true, nativeSqlite: true });
});

test("built CJS CLI starts and prints help without import.meta loader failures", async () => {
  const bundle = fileURLToPath(new URL("../dist/zcode.cjs", import.meta.url));
  await assert.doesNotReject(
    access(bundle),
    "Build prerequisite missing: run the CLI build (including workspace dependencies) before this test.",
  );
  const directory = await mkdtemp(join(tmpdir(), "zcode-cli-cjs-help-"));
  try {
    // 源码加载不能覆盖 CJS 将 import.meta.url 清空的问题；必须消费真正构建的 CLI 产物。
    const { stdout } = await execute(process.execPath, [bundle, "--help"], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        ZCODE_DESKTOP_HOME_DIR: directory,
        ZCODE_DATA_BASE_DIR: directory,
        ZCODE_SESSION_DB_PATH: join(directory, "sessions.sqlite"),
        OMP_CONFIG_ROOT: join(directory, "omp"),
      },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.match(stdout, /--help/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
