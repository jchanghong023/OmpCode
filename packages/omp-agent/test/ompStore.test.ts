import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
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
  const sessionPath = join(sessionDir, "2026-09-24T00-00-00-000Z_test-session.jsonl");
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", id: "test-session" })}\n`);
  await utimes(sessionPath, 1_000_000_000.123, 1_000_000_000.123);

  const store = createOmpStore({ PI_CONFIG_DIR: relative(homedir(), testRoot) });
  const sessions = await store.listSessions(homedir());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, "test-session");
  assert.equal(Number.isSafeInteger(sessions[0]?.createdAt), true);
  assert.equal(Number.isSafeInteger(sessions[0]?.updatedAt), true);
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
  assert.equal(
    (await createOmpStore({ PI_CONFIG_DIR: configDir }).listSessions(homedir())).length,
    0,
  );
  const named = await createOmpStore({
    PI_CONFIG_DIR: configDir,
    OMP_PROFILE: "work",
  }).listSessions(homedir());
  assert.equal(named[0]?.sessionId, "named-session");
});

test("超长会话文件读取末尾 4000 行，短文件行为不变", async (context) => {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-store-tail-test-"));
  context.after(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });
  const store = createOmpStore({ PI_CONFIG_DIR: relative(homedir(), testRoot) });
  const total = 4500;
  const lines: string[] = [];
  for (let i = 0; i < total; i += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `m-${i}` }] },
      }),
    );
  }
  // 不带尾随换行写入，保证窗口计数不受末尾空行干扰。
  const longPath = join(testRoot, "long.jsonl");
  await writeFile(longPath, lines.join("\n"));
  const entries = await store.readSessionEntries(longPath);
  assert.equal(entries.length, 4000);
  const last = entries[entries.length - 1] as { message?: { content?: { text?: string }[] } };
  assert.equal(last?.message?.content?.[0]?.text, `m-${total - 1}`);
  const first = entries[0] as { message?: { content?: { text?: string }[] } };
  assert.equal(first?.message?.content?.[0]?.text, `m-${total - 4000}`);

  // 子代理读取同样保留末尾（最新）段。
  const childDir = join(testRoot, "long");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "scout.jsonl"), lines.join("\n"));
  const childEntries = await store.readSubagentEntries(longPath, "scout");
  assert.equal(childEntries.length, 4000);
  const childLast = childEntries[childEntries.length - 1] as {
    message?: { content?: { text?: string }[] };
  };
  assert.equal(childLast?.message?.content?.[0]?.text, `m-${total - 1}`);

  // 短文件行为不变。
  const shortPath = join(testRoot, "short.jsonl");
  await writeFile(shortPath, JSON.stringify({ type: "session", id: "s" }));
  assert.equal((await store.readSessionEntries(shortPath)).length, 1);
});
