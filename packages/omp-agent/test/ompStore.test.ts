import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { createOmpStore } from "../src/adapters/ompStore.js";

test("相对 PI_CONFIG_DIR 从用户主目录解析并扫描 omp 冷会话", async (context) => {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-store-test-"));
  context.after(async () => {
    assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(testRoot, { recursive: true, force: true });
  });
  const sessionDir = join(testRoot, "agent", "sessions", "-");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "2026-09-24T00-00-00-000Z_test-session.jsonl"),
    `${JSON.stringify({ type: "session", id: "test-session" })}\n`,
  );

  const store = createOmpStore({ PI_CONFIG_DIR: relative(homedir(), testRoot) });
  const sessions = await store.listSessions(homedir());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, "test-session");
});

test("命名 profile 的历史与默认 profile 隔离", async (context) => {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-profile-store-test-"));
  context.after(async () => {
    assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(testRoot, { recursive: true, force: true });
  });
  const namedSessions = join(testRoot, "profiles", "work", "agent", "sessions", "-");
  await mkdir(namedSessions, { recursive: true });
  await writeFile(
    join(namedSessions, "2026-09-24T00-00-00-000Z_named-session.jsonl"),
    `${JSON.stringify({ type: "session", id: "named-session" })}\n`,
  );
  const configDir = relative(homedir(), testRoot);
  assert.equal((await createOmpStore({ PI_CONFIG_DIR: configDir }).listSessions(homedir())).length, 0);
  const named = await createOmpStore({ PI_CONFIG_DIR: configDir, OMP_PROFILE: "work" }).listSessions(homedir());
  assert.equal(named[0]?.sessionId, "named-session");
});
