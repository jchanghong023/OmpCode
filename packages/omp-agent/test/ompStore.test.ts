import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { createOmpStore } from "../src/adapters/ompStore.js";

test("OMP_CONFIG_ROOT 冷历史读取与删除使用目标 profile，旧目录保留", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omp-store-config-root-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const legacy = join(root, "legacy");
  const OMP_CONFIG_ROOT = join(root, "data");
  for (const [directory, id] of [
    [join(legacy, "agent", "sessions", "-"), "legacy"],
    [join(OMP_CONFIG_ROOT, "agent", "sessions", "-"), "default"],
    [join(OMP_CONFIG_ROOT, "profiles", "work", "agent", "sessions", "-"), "named"],
  ]) {
    await mkdir(directory!, { recursive: true });
    await writeFile(
      join(directory!, `2026-10-08T00-00-00-000Z_${id}.jsonl`),
      `${JSON.stringify({ type: "session", id })}\n`,
    );
  }
  const env = { OMP_CONFIG_ROOT, PI_CONFIG_DIR: legacy };
  const store = createOmpStore(env);
  assert.deepEqual(
    (await store.listSessions(homedir())).map((session) => session.sessionId),
    ["default"],
  );
  const namedStore = createOmpStore({ ...env, OMP_PROFILE: "work" });
  const named = await namedStore.findSession?.(homedir(), "named");
  assert.equal(
    named?.sessionPath,
    join(
      OMP_CONFIG_ROOT,
      "profiles",
      "work",
      "agent",
      "sessions",
      "-",
      "2026-10-08T00-00-00-000Z_named.jsonl",
    ),
  );
  assert.equal(await namedStore.deleteSession(named!.sessionPath), true);
  assert.deepEqual(await namedStore.listSessions(homedir()), []);
  assert.equal(
    (await createOmpStore({ PI_CONFIG_DIR: legacy }).listSessions(homedir()))[0]?.sessionId,
    "legacy",
  );
});

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

test(
  "Windows 用户目录内临时工作区按 omp 临时目录编码恢复会话",
  { skip: process.platform !== "win32" },
  async (context) => {
    const testRoot = await mkdtemp(join(tmpdir(), "omp-store-temp-scope-"));
    context.after(async () => {
      assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
      await rm(testRoot, { recursive: true, force: true });
    });
    const workspace = join(testRoot, "project");
    await mkdir(workspace, { recursive: true });
    const encodedWorkspace = `-tmp-${relative(tmpdir(), workspace).replace(/[/\\:]/g, "-")}`;
    const sessionDir = join(testRoot, "profile", "agent", "sessions", encodedWorkspace);
    await mkdir(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, "2026-09-24T00-00-00-000Z_temp-session.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({ type: "session", id: "temp-session" })}\n`);

    const store = createOmpStore({ PI_CONFIG_DIR: join(testRoot, "profile") });
    assert.equal((await store.findSession?.(workspace, "temp-session"))?.sessionPath, sessionPath);
    assert.equal((await store.listSessions(workspace))[0]?.sessionId, "temp-session");
  },
);

test("目录链接访问的会话恢复：链接路径 realpath 后与 omp 真实路径编码同一目录", async (context) => {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-store-link-"));
  context.after(async () => {
    assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(testRoot, { recursive: true, force: true });
  });
  const workspace = join(testRoot, "project");
  await mkdir(workspace, { recursive: true });
  const linkPath = join(testRoot, "project-link");
  try {
    // Windows 用 junction（无需管理员权限），POSIX 用目录符号链接；环境不允许时跳过。
    await symlink(workspace, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch {
    context.skip("当前环境不允许创建目录链接");
    return;
  }
  // omp 按真实路径落盘会话；编码须以 realpath 计算，链接路径才能命中同一目录。
  const realTmp = await realpath(tmpdir());
  const realWorkspace = await realpath(workspace);
  const encodedWorkspace = `-tmp-${relative(realTmp, realWorkspace).replace(/[/\\:]/g, "-")}`;
  const sessionDir = join(testRoot, "store", "agent", "sessions", encodedWorkspace);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "2026-09-24T00-00-00-000Z_link-session.jsonl"),
    `${JSON.stringify({ type: "session", id: "link-session" })}\n`,
  );

  const store = createOmpStore({ PI_CONFIG_DIR: join(testRoot, "store") });
  assert.equal((await store.listSessions(linkPath))[0]?.sessionId, "link-session");
  assert.equal((await store.findSession?.(linkPath, "link-session"))?.sessionId, "link-session");
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

test("超长会话文件完整读取，较早历史仍可分页", async (context) => {
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
  assert.equal(entries.length, total);
  const last = entries[entries.length - 1] as { message?: { content?: { text?: string }[] } };
  assert.equal(last?.message?.content?.[0]?.text, `m-${total - 1}`);
  const first = entries[0] as { message?: { content?: { text?: string }[] } };
  assert.equal(first?.message?.content?.[0]?.text, "m-0");

  // 子代理读取同样保留末尾（最新）段。
  const childDir = join(testRoot, "long");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(childDir, "scout.jsonl"), lines.join("\n"));
  const childEntries = await store.readSubagentEntries(longPath, "scout");
  assert.equal(childEntries.length, total);
  const childLast = childEntries[childEntries.length - 1] as {
    message?: { content?: { text?: string }[] };
  };
  assert.equal(childLast?.message?.content?.[0]?.text, `m-${total - 1}`);

  // 短文件行为不变。
  const shortPath = join(testRoot, "short.jsonl");
  await writeFile(shortPath, JSON.stringify({ type: "session", id: "s" }));
  assert.equal((await store.readSessionEntries(shortPath)).length, 1);
});

test("目录超过 100 个会话仍全部可见，旧 ID 可直接定位", async (context) => {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-store-many-test-"));
  context.after(async () => {
    assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(testRoot, { recursive: true, force: true });
  });
  const directory = join(testRoot, "agent", "sessions", "-");
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Array.from({ length: 121 }, (_, index) =>
      writeFile(
        join(
          directory,
          `2026-09-24T00-00-00-${String(index).padStart(3, "0")}Z_session-${index}.jsonl`,
        ),
        `${JSON.stringify({ type: "session", id: `session-${index}` })}\n`,
      ),
    ),
  );
  const store = createOmpStore({ PI_CONFIG_DIR: relative(homedir(), testRoot) });
  const sessions = await store.listSessions(homedir());
  assert.equal(sessions.length, 121);
  assert.equal((await store.findSession?.(homedir(), "session-0"))?.sessionId, "session-0");
});
