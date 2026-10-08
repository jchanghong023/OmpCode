import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { createOmpStore, ompCommandOutputsRoot } from "../src/adapters/ompStore.js";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import { ServerApp } from "../src/app/serverApp.js";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";
import { mergeOmpCommandOutputHistory } from "../src/domain/OmpCommandOutputHistory.js";
import type { HostGateway, OmpStorePort, OmpSessionProcessHandlers } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

const cwd = homedir();
const output = { id: "output-1", text: "repo index: 8 files", createdAt: 1000 };
const logicalId = "omp-session-command-only";
const stableId = "01a0d66e-1891-7035-ab59-f8e5f0a33703";

async function scratch(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-command-output-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const env = { OMP_CONFIG_ROOT: join(root, "omp") };
  return { root, env, store: createOmpStore(env) };
}

function registryWith(store: OmpStorePort) {
  let processStarts = 0;
  const directory = createDirectoryStub();
  directory.setForkSurface(true);
  const registry = new SessionRegistry({
    store,
    directory,
    ompFactory: {
      create() {
        processStarts += 1;
        throw new Error("cold output history must not start OMP");
      },
    },
    gateway: { emitFrame() {} } as HostGateway,
  });
  return { registry, directory, starts: () => processStarts };
}

test("仅 command_output 的会话持久恢复，不创建 OMP journal，不重发命令", async (context) => {
  const { store, env } = await scratch(context);
  const session = { cwd, sessionId: logicalId, sessionPath: null, title: "/repo" };
  await Promise.all([
    store.appendCommandOutput!(session, output),
    store.appendCommandOutput!(session, {
      id: "output-2",
      text: "repo index ready",
      createdAt: 2000,
    }),
    store.appendCommandOutput!(session, output),
  ]);
  await store.flushCommandOutputs!();
  const reopened = createOmpStore(env);
  const summaries = await reopened.listSessions(cwd);
  assert.deepEqual(summaries, [
    {
      sessionId: logicalId,
      sessionPath: "",
      title: "/repo",
      firstUserText: null,
      createdAt: 1000,
      updatedAt: 2000,
      commandOutputOnly: true,
    },
  ]);
  const fixture = registryWith(reopened);
  const engine = await fixture.registry.resumeSession({
    sessionId: logicalId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  const rows = engine.projection.rowsRange(undefined, 20).rows;
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    [output.text, "repo index ready"],
  );
  assert.equal(new Set(rows.map((row) => row.entityId)).size, 2);
  assert.equal(engine.ompSessionFile, null);
  assert.equal(fixture.starts(), 0);
  assert.equal(fixture.directory.sentDirectoryCommands.length, 0);
  await fixture.registry.closeSession(logicalId);
  assert.equal((await reopened.listSessions(cwd)).length, 1, "关闭不删除已收到的派生历史");
  await fixture.registry.dispose();
});

test("原生文件随后生成时关联 UUID，冷恢复合并模型历史且不复制 journal", async (context) => {
  const { store, env } = await scratch(context);
  const session = { cwd, sessionId: logicalId, sessionPath: null, title: "/wiki" };
  await store.appendCommandOutput!(session, output);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const entries = [
    { type: "session", id: stableId, cwd, timestamp: new Date(100).toISOString() },
    {
      type: "message",
      id: "user-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "actual model prompt" }],
        timestamp: 3000,
      },
      timestamp: new Date(3000).toISOString(),
    },
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "actual model answer" }],
        timestamp: 4000,
      },
      timestamp: new Date(4000).toISOString(),
    },
  ];
  const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(nativePath, journal);
  await store.associateCommandOutputs!({ ...session, sessionPath: nativePath });
  const reopened = createOmpStore(env);
  assert.equal((await reopened.listSessions(cwd)).length, 1);
  assert.equal((await reopened.findSession!(cwd, stableId))?.sessionPath, nativePath);
  assert.equal((await reopened.findSession!(cwd, logicalId))?.sessionPath, nativePath);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, stableId, nativePath), [output]);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), [output]);
  const fixture = registryWith(reopened);
  const engine = await fixture.registry.resumeSession({
    sessionId: stableId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  const rows = engine.projection.rowsRange(undefined, 20).rows;
  assert.equal(
    rows.filter((row) => row.kind === "assistantText" && row.text === output.text).length,
    1,
  );
  assert.ok(rows.some((row) => row.kind === "assistantText" && row.text === "actual model answer"));
  assert.equal(await readFile(nativePath, "utf8"), journal);
  assert.equal(fixture.starts(), 0);
  await fixture.registry.dispose();
});

test("原生文件存在后，旧 GUI ID 两链路公开冷订阅保留多轮模型及派生输出", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const entries = [
    { type: "session", id: stableId, cwd },
    { type: "message", message: { role: "user", content: "first turn", timestamp: 1500 } },
    {
      type: "message",
      id: "earlier-answer",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "earlier native saved answer" }],
        timestamp: 2000,
      },
    },
    { type: "message", message: { role: "user", content: "next turn", timestamp: 2500 } },
    {
      type: "message",
      id: "answer",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "native saved answer" }],
        timestamp: 3000,
      },
    },
  ];
  const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(nativePath, journal);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  await store.flushCommandOutputs!();
  const frames: unknown[] = [];
  const resumedPaths: Array<string | undefined> = [];
  const sentTypes: string[] = [];
  const app = new ServerApp({
    store: createOmpStore(env),
    workspacePath: cwd,
    workspaceKey: "ws",
    directory: createDirectoryStub(),
    gateway: {
      emitFrame: (frame) => frames.push(frame),
      requestUserInput: async () => ({ action: "cancel" as const }),
    },
    loadWorkspaceConfig: async () => ({ configOptions: [], slashCommands: [] }),
    loadWorkspaceSkillCommands: async () => [],
    ompFactory: {
      create(options) {
        resumedPaths.push(options.resumeSessionPath);
        return {
          ompSessionFile: nativePath,
          async start() {},
          async dispose() {},
          respondUi() {},
          async refreshState() {
            return null;
          },
          async readContextReport() {
            return null;
          },
          async send(command) {
            sentTypes.push(command.type);
            return { success: true, data: {} };
          },
        };
      },
    },
  });
  try {
    for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
      const priorFrameCount = frames.length;
      const result = (await app.handleRequest("v4/conversation/subscribe", {
        topic: `conversation/${logicalId}`,
        connectionId: `cold-old-gui-id-${mode}`,
        clientMode: mode,
      })) as { ack: { mode: string } };
      assert.equal(result.ack.mode, "snapshot");
      const wire = frames.slice(priorFrameCount).find((frame) => {
        const candidate = frame as { frame?: { payload?: { snapshot?: unknown } } };
        return candidate.frame?.payload?.snapshot !== undefined;
      }) as { frame: { payload: { snapshot: unknown } } };
      assert.ok(wire, "每条冷订阅链路必须实际发布 snapshot");
      const snapshot = conversationSnapshotSchema.parse(wire.frame.payload.snapshot);
      assert.equal(snapshot.sessionId, logicalId);
      assert.deepEqual(
        snapshot.rows.window.filter((row) => row.kind === "assistantText").map((row) => row.text),
        [output.text, "earlier native saved answer", "native saved answer"],
      );
    }
    assert.equal(app.registry.requireEngine(logicalId).ompSessionFile, nativePath);
    assert.deepEqual(resumedPaths, [nativePath]);
    assert.ok(!sentTypes.includes("prompt"), "冷订阅不能重发已执行命令");
    assert.equal(await readFile(nativePath, "utf8"), journal);
  } finally {
    await app.dispose();
  }
});

test("冷合并按输出 ID 去重，保留相同文本的不同事件及原生行", () => {
  const native = rowsFromOmpEntries([
    {
      type: "message",
      id: "native",
      message: { role: "assistant", content: [{ type: "text", text: "model" }], timestamp: 3000 },
    },
  ]);
  const records = [output, output, { ...output, id: "another-event", createdAt: 2000 }];
  const rows = mergeOmpCommandOutputHistory(native, records);
  const twice = mergeOmpCommandOutputHistory(rows, records);
  assert.equal(
    rows.filter((row) => row.kind === "assistantText" && row.text === output.text).length,
    2,
  );
  assert.equal(twice.length, rows.length);
  assert.deepEqual(
    twice.map((row) => row.entityId),
    rows.map((row) => row.entityId),
  );
  assert.deepEqual(
    rows.map((row) => row.rowId),
    rows.map((_, index) => index + 1),
  );
  assert.ok(rows.some((row) => row.kind === "assistantText" && row.text === "model"));
});

test("派生冷合并保留多轮及同轮多段原生历史，不按类别 entityId 覆盖模型回复", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "first", timestamp: 100 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "first reasoning" },
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
        ],
        timestamp: 200,
      },
    },
    { type: "message", message: { role: "user", content: "second", timestamp: 300 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "second reasoning" },
          { type: "text", text: "second answer" },
        ],
        timestamp: 400,
      },
    },
  ];
  const native = rowsFromOmpEntries(entries);
  assert.ok(new Set(native.map((row) => row.entityId)).size < native.length);
  const rows = mergeOmpCommandOutputHistory(native, [output, output]);
  const twice = mergeOmpCommandOutputHistory(rows, [output, output]);
  assert.deepEqual(
    rows
      .filter((row) => !row.entityId.startsWith("omp-command-output:"))
      .map(({ rowId: _rowId, createdAtSeq: _seq, ...row }) => row),
    native.map(({ rowId: _rowId, createdAtSeq: _seq, ...row }) => row),
  );
  assert.deepEqual(twice, rows);
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    ["first paragraph", "second paragraph", "second answer", output.text],
  );
});

test("多条原生 custom 冷恢复各自独立稳定显示组，保留合法重复且不改变模型轮", () => {
  const entries = [
    {
      type: "message",
      id: "user",
      message: { role: "user", content: "model task", timestamp: 100 },
    },
    {
      type: "message",
      id: "model-before",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "model before" }],
        timestamp: 200,
      },
    },
    {
      type: "custom_message",
      id: "dispatch-old",
      customType: "team-dispatch",
      content: "team-dispatch",
      display: true,
      timestamp: 300,
    },
    {
      type: "custom_message",
      id: "incomplete",
      customType: "team-result",
      content: "team-incomplete",
      display: true,
      timestamp: 400,
    },
    {
      type: "custom_message",
      id: "dispatch-new",
      customType: "team-dispatch",
      content: "team-dispatch",
      display: true,
      timestamp: 500,
    },
    {
      type: "message",
      id: "model-after",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "model after" }],
        timestamp: 600,
      },
    },
  ];
  const rows = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    [output],
    entries,
    stableId,
  );
  const custom = rows.filter((row) => row.kind === "assistantText" && row.text.startsWith("team-"));
  assert.deepEqual(
    custom.map((row) => row.kind === "assistantText" && row.text),
    ["team-dispatch", "team-incomplete", "team-dispatch"],
  );
  assert.equal(
    new Set(custom.map((row) => row.turnId)).size,
    3,
    "latest-assistant 每组仍能显示每条原生报告",
  );
  assert.deepEqual(
    custom.map((row) => row.turnId),
    [
      "omp-native-custom:dispatch-old",
      "omp-native-custom:incomplete",
      "omp-native-custom:dispatch-new",
    ],
  );
  const model = rows.filter((row) => row.kind === "assistantText" && row.text.startsWith("model "));
  assert.equal(model.length, 2);
  assert.equal(model[0]!.turnId, model[1]!.turnId, "custom 不推进或替换原生模型轮");
  assert.ok(custom.every((row) => row.turnId !== model[0]!.turnId));
  assert.deepEqual(
    rowsFromOmpEntries(entries)
      .filter((row) => row.kind === "assistantText" && row.text.startsWith("team-"))
      .map((row) => row.turnId),
    custom.map((row) => row.turnId),
  );
});

test("同 cwd 不同 workspaceIdentity 的 GUI 派生历史隔离", async (context) => {
  const { env } = await scratch(context);
  const remoteA = createOmpStore({ ...env, ZCODE_WORKSPACE_IDENTITY: "remote-a" });
  const remoteB = createOmpStore({ ...env, ZCODE_WORKSPACE_IDENTITY: "remote-b" });
  await remoteA.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  assert.deepEqual(await remoteB.listSessions(cwd), []);
  assert.deepEqual(await remoteB.readCommandOutputs!(cwd, logicalId), []);
  assert.equal((await remoteA.listSessions(cwd)).length, 1);
});

test("只有派生历史的冷会话删除不调用原生目录，重启不会复活", async (context) => {
  const { env, store } = await scratch(context);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  const fixture = registryWith(store);
  // 初始化工作区但不加载待删会话，覆盖完全冷删除路径。
  await fixture.registry.createSession({
    sessionId: "unrelated",
    workspaceId: "ws",
    workspacePath: cwd,
  });
  await fixture.registry.deleteSession(logicalId);
  assert.deepEqual(await createOmpStore(env).listSessions(cwd), []);
  assert.equal(fixture.directory.sentDirectoryCommands.length, 0);
  await fixture.registry.dispose();
});

test("已加载的纯本地命令会话删除等待写入，并删除派生历史", async (context) => {
  const { env, store } = await scratch(context);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  const fixture = registryWith(store);
  await fixture.registry.resumeSession({
    sessionId: logicalId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  await fixture.registry.deleteSession(logicalId);
  assert.deepEqual(await createOmpStore(env).listSessions(cwd), []);
  assert.equal(fixture.registry.getEngine(logicalId), null);
  assert.equal(fixture.directory.sentDirectoryCommands.length, 0);
  await fixture.registry.dispose();
});

test("公开 sendText 入口收到 ACK 前后输出，关闭并冷恢复只展示收到的事实", async (context) => {
  const { store, env } = await scratch(context);
  let handlers: OmpSessionProcessHandlers | null = null;
  let prompts = 0;
  const registry = new SessionRegistry({
    store,
    directory: createDirectoryStub(),
    gateway: { emitFrame() {} } as HostGateway,
    ompFactory: {
      create(options) {
        handlers = options;
        return {
          ompSessionFile: null,
          async start() {},
          async send(command) {
            if (command.type === "prompt") {
              prompts += 1;
              options.onCommandOutput?.({ text: "repo index started" });
              return { success: true, data: { agentInvoked: false } };
            }
            return { success: true };
          },
          respondUi() {},
          async refreshState() {
            return null;
          },
          async readContextReport() {
            return null;
          },
          async dispose() {},
        };
      },
    },
  });
  const engine = await registry.createSession({
    sessionId: logicalId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  await engine.sendText("/repo status", "command-1", "client-1");
  assert.ok(handlers);
  (handlers as OmpSessionProcessHandlers).onCommandOutput?.({ text: "repo index ready after ACK" });
  const live = engine.projection
    .rowsRange(undefined, 20)
    .rows.filter((row) => row.kind === "assistantText");
  await registry.closeSession(logicalId);
  await registry.dispose();
  const reopened = registryWith(createOmpStore(env));
  const cold = await reopened.registry.resumeSession({
    sessionId: logicalId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  const restored = cold.projection
    .rowsRange(undefined, 20)
    .rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    restored.map((row) => row.text),
    live.map((row) => row.text),
  );
  assert.deepEqual(
    restored.map((row) => row.entityId),
    live.map((row) => row.entityId),
  );
  assert.equal(prompts, 1);
  assert.equal(reopened.starts(), 0);
  await reopened.registry.dispose();
});

test("OMP 目录删除成功后，UUID 与逻辑 ID 关联的派生输出同步删除", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await writeFile(nativePath, `${JSON.stringify({ type: "session", id: stableId, cwd })}\n`);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  const directory = createDirectoryStub();
  directory.sendDirectory = async (command) => {
    assert.equal(command.type, "delete_session");
    assert.equal("sessionId" in command ? command.sessionId : null, stableId);
    await rm(nativePath);
    return { success: true };
  };
  const registry = new SessionRegistry({
    store,
    directory,
    gateway: { emitFrame() {} } as HostGateway,
    ompFactory: {
      create() {
        throw new Error("must not start core");
      },
    },
  });
  await registry.resumeSession({ sessionId: stableId, workspaceId: "ws", workspacePath: cwd });
  await registry.deleteSession(stableId);
  const reopened = createOmpStore(env);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), []);
  assert.deepEqual(await reopened.readCommandOutputs!(cwd, stableId, nativePath), []);
  assert.deepEqual(await reopened.listSessions(cwd), []);
  await registry.dispose();
});

test("派生文件删除失败不报告成功，冷历史保持可恢复", async (context) => {
  const { store } = await scratch(context);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  const fixture = registryWith({ ...store, deleteCommandOutputs: async () => false });
  await fixture.registry.createSession({
    sessionId: "unrelated",
    workspaceId: "ws",
    workspacePath: cwd,
  });
  await assert.rejects(
    fixture.registry.deleteSession(logicalId),
    /cannot delete omp command history/,
  );
  assert.deepEqual(await store.readCommandOutputs!(cwd, logicalId), [output]);
  assert.equal((await store.listSessions(cwd)).length, 1);
  await fixture.registry.dispose();
});

test("旧 GUI alias 冷删除使用 canonical UUID，并同步删除关联派生输出", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  await mkdir(nativeDirectory, { recursive: true });
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await writeFile(nativePath, `${JSON.stringify({ type: "session", id: stableId, cwd })}\n`);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  const directory = createDirectoryStub();
  directory.sendDirectory = async (command) => {
    assert.equal(command.type, "delete_session");
    assert.equal("sessionId" in command ? command.sessionId : null, stableId);
    await rm(nativePath);
    return { success: true };
  };
  const registry = new SessionRegistry({
    store,
    directory,
    gateway: { emitFrame() {} } as HostGateway,
    ompFactory: {
      create() {
        throw new Error("cold deletion must not start OMP");
      },
    },
  });
  try {
    await registry.createSession({ sessionId: "unrelated", workspaceId: "ws", workspacePath: cwd });
    await registry.deleteSession(logicalId);
    const reopened = createOmpStore(env);
    assert.equal(await reopened.findSession!(cwd, logicalId), null);
    assert.equal(await reopened.findSession!(cwd, stableId), null);
    assert.deepEqual(await reopened.readCommandOutputs!(cwd, logicalId), []);
    assert.deepEqual(await reopened.listSessions(cwd), []);
    assert.ok(registry.getEngine("unrelated"));
  } finally {
    await registry.dispose();
  }
});

test("OMP 只分配路径未落盘时保留 UUID 冷锚点，不将空文件路径传给 resume", async (context) => {
  const { store, env } = await scratch(context);
  const nativePath = join(
    env.OMP_CONFIG_ROOT,
    "agent",
    "sessions",
    "-",
    `2026-10-08T00-00-00-000Z_${stableId}.jsonl`,
  );
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  const reopened = createOmpStore(env);
  const summaries = await reopened.listSessions(cwd);
  assert.equal(summaries[0]?.sessionId, stableId);
  assert.equal(summaries[0]?.commandOutputOnly, true);
  assert.equal(summaries[0]?.sessionPath, "");
  const fixture = registryWith(reopened);
  const engine = await fixture.registry.resumeSession({
    sessionId: stableId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  assert.equal(engine.ompSessionFile, null);
  assert.ok(
    engine.projection
      .rowsRange(undefined, 20)
      .rows.some((row) => row.kind === "assistantText" && row.text === output.text),
  );
  await fixture.registry.deleteSession(stableId);
  assert.equal(fixture.directory.sentDirectoryCommands.length, 0);
  assert.deepEqual(await store.readCommandOutputs!(cwd, logicalId), []);
  await fixture.registry.dispose();
});

test("首次真正落盘后记录文件事实，外部删除原生会话不会被派生文本复活", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: nativePath }, output);
  assert.equal((await store.listSessions(cwd))[0]?.commandOutputOnly, true);
  await mkdir(nativeDirectory, { recursive: true });
  await writeFile(nativePath, `${JSON.stringify({ type: "session", id: stableId, cwd })}\n`);
  assert.equal((await store.listSessions(cwd))[0]?.commandOutputOnly, undefined);
  await rm(nativePath);
  assert.deepEqual(await createOmpStore(env).listSessions(cwd), []);
});

test("派生历史写入失败会显式拒绝，flush 不冒充落盘成功", async (context) => {
  const { root } = await scratch(context);
  const blockedRoot = join(root, "blocked");
  await writeFile(`${blockedRoot}_ompcode`, "not a directory");
  const store = createOmpStore({ OMP_CONFIG_ROOT: blockedRoot });
  await assert.rejects(
    store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output),
  );
  await assert.rejects(store.flushCommandOutputs!());
});

test("派生数据仅写 OmpCode 根，旧 PI_CONFIG_DIR 不改变默认应用根，profile 隔离", async (context) => {
  const { root, env, store } = await scratch(context);
  const named = createOmpStore({ ...env, OMP_PROFILE: "work" });
  await store.appendCommandOutput!({ cwd, sessionId: logicalId, sessionPath: null }, output);
  assert.deepEqual(await named.listSessions(cwd), []);
  assert.equal(
    ompCommandOutputsRoot(env),
    join(`${env.OMP_CONFIG_ROOT}_ompcode`, "cli", "omp-command-output", "default"),
  );
  assert.equal(
    ompCommandOutputsRoot({ PI_CONFIG_DIR: join(root, "legacy") }, root),
    join(root, ".ompcode", "cli", "omp-command-output", "default"),
  );
  assert.equal(
    ompCommandOutputsRoot({ ZCODE_DATA_BASE_DIR: root }, "other-home"),
    join(root, ".ompcode", "cli", "omp-command-output", "default"),
  );
});

test("仅 display:true custom 的原生结果没有 parent journal 时，ACK 后保存并双链路冷恢复", async (context) => {
  const { store, env } = await scratch(context);
  const nativePath = join(
    env.OMP_CONFIG_ROOT,
    "agent",
    "sessions",
    "-",
    `2026-10-08T00-00-00-000Z_${stableId}.jsonl`,
  );
  let handlers!: OmpSessionProcessHandlers;
  let promptCount = 0;
  const registry = new SessionRegistry({
    store,
    directory: createDirectoryStub(),
    gateway: { emitFrame() {} } as HostGateway,
    ompFactory: {
      create(options) {
        handlers = options;
        return {
          ompSessionFile: nativePath,
          async start() {},
          async dispose() {},
          respondUi() {},
          async refreshState() {
            return { sessionFile: nativePath };
          },
          async readContextReport() {
            return null;
          },
          async send(command) {
            if (command.type === "prompt") promptCount++;
            return { success: true, data: { agentInvoked: false } };
          },
        };
      },
    },
  });
  const engine = await registry.createSession({
    sessionId: logicalId,
    workspaceId: "ws",
    workspacePath: cwd,
  });
  const message = {
    role: "custom",
    customType: "team-result",
    content: "## team-result\n真实最终方案",
    display: true,
    timestamp: 2000,
  };
  await engine.sendText("/team read-only task", "team", "client");
  handlers.onEvent({ type: "message_end", message: { ...message, display: false } });
  handlers.onEvent({ type: "message_start", message });
  assert.equal(
    engine.projection.rowsRange(undefined, 100).rows.filter((row) => row.kind === "assistantText")
      .length,
    0,
  );
  handlers.onEvent({ type: "message_end", message });
  const live = engine.projection
    .rowsRange(undefined, 100)
    .rows.filter((row) => row.kind === "assistantText");
  assert.equal(live.length, 1);
  await registry.closeSession(logicalId);
  await registry.dispose();
  await assert.rejects(readFile(nativePath, "utf8"), { code: "ENOENT" });
  const fixture = registryWith(createOmpStore(env));
  try {
    const cold = await fixture.registry.resumeSession({
      sessionId: logicalId,
      workspaceId: "ws",
      workspacePath: cwd,
    });
    for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
      cold.subscribe({ connectionId: mode, clientMode: mode });
      const rows = cold.projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "assistantText");
      assert.deepEqual(
        rows.map((row) => [row.entityId, row.text]),
        live.map((row) => [row.entityId, row.text]),
      );
    }
    assert.equal(fixture.starts(), 0);
    assert.equal(promptCount, 1);
  } finally {
    await fixture.registry.dispose();
  }
});

test("已写 journal 的 custom 不保存派生副本；迟到原生落盘按类型和文本计数去重", async (context) => {
  const { store, env } = await scratch(context);
  const nativeDirectory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(nativeDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const session = { cwd, sessionId: logicalId, sessionPath: nativePath };
  const custom = { ...output, customType: "team-result", nativeTimestamp: 1000 };
  await store.appendCommandOutput!(session, custom);
  await store.appendCommandOutput!(session, {
    ...custom,
    id: "second-custom",
    createdAt: 1001,
    nativeTimestamp: 1001,
  });
  const entries = [
    { type: "session", id: stableId, cwd },
    {
      type: "custom_message",
      customType: custom.customType,
      content: custom.text,
      display: true,
      timestamp: new Date(1000).toISOString(),
    },
    {
      type: "message",
      message: {
        role: "custom",
        customType: custom.customType,
        content: custom.text,
        display: true,
        timestamp: 1001,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: custom.text }],
        timestamp: 3000,
      },
    },
  ];
  await mkdir(nativeDirectory, { recursive: true });
  const journal = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(nativePath, journal);
  await store.appendCommandOutput!(session, { ...custom, id: "already-native", createdAt: 2000 });
  const records = await store.readCommandOutputs!(cwd, logicalId);
  assert.equal(records.length, 2, "journal 已持有的事件不能保存第二份");
  const merged = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    [...records, records[0]!],
    entries,
    stableId,
  );
  assert.equal(
    merged.filter((row) => row.kind === "assistantText" && row.text === custom.text).length,
    3,
  );
  assert.ok(merged.every((row) => !row.entityId.startsWith("omp-command-output:")));
  assert.equal(await readFile(nativePath, "utf8"), journal);
  const fixture = registryWith(createOmpStore(env));
  try {
    const cold = await fixture.registry.resumeSession({
      sessionId: logicalId,
      workspaceId: "ws",
      workspacePath: cwd,
    });
    assert.equal(
      cold.projection.rowsRange(undefined, 100).rows.filter((row) => row.kind === "assistantText")
        .length,
      3,
    );
    assert.equal(fixture.starts(), 0);
  } finally {
    await fixture.registry.dispose();
  }
});

test("同文 custom 的旧 journal t1000 不能吞掉未落盘新事件 t2000", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: stableId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(1000).toISOString(),
    },
  ];
  await writeFile(nativePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: nativePath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  assert.equal((await store.readCommandOutputs!(cwd, logicalId)).length, 1);
  const fixture = registryWith(createOmpStore(env));
  try {
    const cold = await fixture.registry.resumeSession({
      sessionId: logicalId,
      workspaceId: "ws",
      workspacePath: cwd,
    });
    const visible = cold.projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "assistantText");
    assert.deepEqual(
      visible.map((row) => row.text),
      [output.text, output.text],
    );
    assert.deepEqual(
      visible.map((row) => row.createdAt),
      [1000, 2000],
    );
  } finally {
    await fixture.registry.dispose();
  }
});

test("同事件 frame/entry 时间微差按源因果顺序冷去重，不猜时间容差", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const nativePath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: stableId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(2001).toISOString(),
    },
  ];
  await writeFile(nativePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: nativePath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  assert.equal(
    (await store.readCommandOutputs!(cwd, logicalId)).length,
    1,
    "时间不同不能在保存前假定已落盘",
  );
  const fixture = registryWith(createOmpStore(env));
  try {
    const cold = await fixture.registry.resumeSession({
      sessionId: logicalId,
      workspaceId: "ws",
      workspacePath: cwd,
    });
    assert.deepEqual(
      cold.projection
        .rowsRange(undefined, 100)
        .rows.filter((row) => row.kind === "assistantText")
        .map((row) => row.text),
      [output.text],
    );
  } finally {
    await fixture.registry.dispose();
  }
});

test("原生 file/UUID 变化后，旧 epoch derived 不匹配新 file 的同文 custom", async (context) => {
  const { store, env } = await scratch(context);
  const directory = join(env.OMP_CONFIG_ROOT, "agent", "sessions", "-");
  const originalPath = join(directory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const newId = "01a0d66e-1891-7035-ab59-f8e5f0a33704";
  const newPath = join(directory, `2026-10-08T00-00-01-000Z_${newId}.jsonl`);
  await store.appendCommandOutput!(
    { cwd, sessionId: logicalId, sessionPath: originalPath },
    { ...output, createdAt: 2000, nativeTimestamp: 2000, customType: "team-result" },
  );
  await mkdir(directory, { recursive: true });
  const entries = [
    { type: "session", id: newId, cwd },
    {
      type: "custom_message",
      customType: "team-result",
      content: output.text,
      display: true,
      timestamp: new Date(3000).toISOString(),
    },
  ];
  await writeFile(newPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await store.associateCommandOutputs!({ cwd, sessionId: logicalId, sessionPath: newPath });
  assert.equal((await store.readCommandOutputs!(cwd, logicalId))[0]!.nativeSessionId, stableId);
  const fixture = registryWith(createOmpStore(env));
  try {
    const cold = await fixture.registry.resumeSession({
      sessionId: logicalId,
      workspaceId: "ws",
      workspacePath: cwd,
    });
    const visible = cold.projection
      .rowsRange(undefined, 100)
      .rows.filter((row) => row.kind === "assistantText");
    assert.deepEqual(
      visible.map((row) => row.text),
      [output.text, output.text],
    );
    assert.deepEqual(
      visible.map((row) => row.createdAt),
      [2000, 3000],
    );
  } finally {
    await fixture.registry.dispose();
  }
});
