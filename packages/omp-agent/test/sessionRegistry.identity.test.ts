import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V4_METHODS,
  commandAckSchema,
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { ServerApp } from "../src/app/serverApp.js";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";
import { buildLegacySnapshot } from "../src/app/legacySnapshot.js";

test("omp 稳定会话 ID 绑定后，legacy 列表与引擎查找不重复", async () => {
  const stableId = "01a0d66e-1891-7035-ab59-f8e5f0a33703";
  const sessionPath = `C:/sessions/2026-09-25T02-38-54-609Z_${stableId}.jsonl`;
  const registry = new SessionRegistry({
    ompFactory: {
      create: () => ({
        ompSessionFile: sessionPath,
        start: async () => {},
        send: async () => ({ success: true }),
        respondUi: () => {},
        refreshState: async () => null,
        readContextReport: async () => null,
        dispose: async () => {},
      }),
    } as OmpProcessFactory,
    store: {
      listSessions: async () => [
        {
          sessionId: stableId,
          sessionPath,
          title: "test",
          firstUserText: "test",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      readSessionEntries: async () => [],
      deleteSession: async () => true,
    } as OmpStorePort,
    gateway: { send: () => {} } as unknown as HostGateway,
  });
  const engine = await registry.createSession({
    sessionId: "omp-session-temporary",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await engine.ensureOmpStarted();
  // draft 相位不再进 legacy 列表（isDraftSession 过滤）；身份语义测试需真实会话相位。
  engine.projection.beginUserTurn({
    text: "x",
    inputId: "t1",
    sourceCommandId: "c1",
    clientId: "test",
  });
  const sessions = await registry.listLegacySessions("C:/work", "ws");
  assert.deepEqual(
    sessions.map((item) => item.sessionId),
    ["omp-session-temporary"],
  );
  assert.equal(registry.getEngine(stableId), engine);
  assert.equal(registry.getEngine("omp-session-temporary"), engine);
});

test("运行中保持临时 ID，先结算该 ID 的终态再切到稳定 UUID", async () => {
  const stableId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  const temporaryId = "omp-session-automation";
  const sessionPath = `C:/sessions/2026-09-25T04-28-16-187Z_${stableId}.jsonl`;
  const frames: string[] = [];
  const registry = new SessionRegistry({
    ompFactory: {
      create: () => ({
        ompSessionFile: sessionPath,
        start: async () => {},
        send: async () => ({ success: true }),
        respondUi: () => {},
        refreshState: async () => null,
        readContextReport: async () => null,
        dispose: async () => {},
      }),
    } as OmpProcessFactory,
    store: {
      listSessions: async () => [
        {
          sessionId: stableId,
          sessionPath,
          title: "test",
          firstUserText: "test",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      readSessionEntries: async () => [],
      deleteSession: async () => true,
    } as OmpStorePort,
    gateway: { emitFrame: (frame: unknown) => frames.push(JSON.stringify(frame)) } as HostGateway,
  });
  const engine = await registry.createSession({
    sessionId: temporaryId,
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  await engine.ensureOmpStarted();
  engine.projection.beginUserTurn({
    text: "run",
    inputId: "input-auto",
    sourceCommandId: "cmd-auto",
    clientId: "client",
  });
  registry.upsertEngineSummary(engine);
  await registry.subscribeSessionsIndex({
    workspaceId: "ws",
    workspacePath: "C:/work",
    connectionId: "test",
  });
  assert.deepEqual(
    (await registry.listLegacySessions("C:/work", "ws")).map((item) => item.sessionId),
    [temporaryId],
  );
  engine.projection.finishTurn("success");
  registry.upsertEngineSummary(engine);
  const terminal = frames.findIndex(
    (frame) =>
      frame.includes('"session.upserted"') &&
      frame.includes(temporaryId) &&
      frame.includes("completedSuccess"),
  );
  const removed = frames.findIndex(
    (frame) => frame.includes('"session.removed"') && frame.includes(temporaryId),
  );
  const stable = frames.findIndex(
    (frame) => frame.includes('"session.upserted"') && frame.includes(stableId),
  );
  assert.ok(
    terminal >= 0 && removed > terminal && stable > removed,
    JSON.stringify(frames.slice(-5)),
  );
  assert.deepEqual(
    (await registry.listLegacySessions("C:/work", "ws")).map((item) => item.sessionId),
    [stableId],
  );
  const tempAck = engine.subscribe({
    sessionId: temporaryId,
    connectionId: "old",
    clientMode: "desktop-continuous",
  });
  const stableAck = engine.subscribe({
    sessionId: stableId,
    connectionId: "new",
    clientMode: "web-remote-replayable",
  });
  assert.ok(
    frames.some(
      (frame) =>
        frame.includes(`"topic":"conversation/${temporaryId}"`) &&
        frame.includes(tempAck.subscriptionId),
    ),
  );
  assert.ok(
    frames.some(
      (frame) =>
        frame.includes(`"topic":"conversation/${stableId}"`) &&
        frame.includes(stableAck.subscriptionId),
    ),
  );
  const legacy = buildLegacySnapshot({
    engine,
    sessionId: stableId,
    workspaceKey: "ws",
    workspacePath: "C:/work",
  });
  assert.equal((legacy.session as { sessionId: string }).sessionId, stableId);
  assert.equal((legacy.projection as { sessionId: string }).sessionId, stableId);
});

test("sessions-index 与 workspace-config 恢复后从当前水位继续发 delta", async () => {
  type Wire = {
    kind: string;
    topic: string;
    subscriptionId: string;
    deliveryKind: string;
    frame?: { fromSeq: number; toSeq: number };
  };
  const frames: Wire[] = [];
  const registry = new SessionRegistry({
    ompFactory: {
      create: () => {
        throw new Error("unexpected omp process");
      },
    } as OmpProcessFactory,
    store: { listSessions: async () => [] } as unknown as OmpStorePort,
    gateway: { emitFrame: (frame: Wire) => frames.push(frame) } as unknown as HostGateway,
  });
  const engine = await registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  // draft 相位不入 sessions-index（isDraftSession 过滤）；本测试验证恢复水位，需非 draft 相位。
  engine.projection.beginUserTurn({
    text: "x",
    inputId: "t1",
    sourceCommandId: "c1",
    clientId: "test",
  });
  const index = await registry.subscribeSessionsIndex({
    workspaceId: "ws",
    workspacePath: "C:/work",
    connectionId: "test",
  });
  registry.upsertEngineSummary(engine);
  registry.resyncIndexOrConfig(index.subscriptionId, null, true);
  registry.upsertEngineSummary(engine);
  const indexFrames = frames.filter(
    (frame) => frame.topic === "sessions-index/ws" && frame.subscriptionId === index.subscriptionId,
  );
  assert.equal(indexFrames.at(-2)?.deliveryKind, "recovery");
  assert.equal(indexFrames.at(-2)?.frame?.toSeq, 2);
  assert.equal(indexFrames.at(-1)?.frame?.fromSeq, 2);

  const config = { configOptions: [], slashCommands: [] };
  const configAck = registry.subscribeWorkspaceConfig({ workspaceId: "ws", config });
  registry.updateWorkspaceConfig("ws", config);
  registry.resyncIndexOrConfig(configAck.subscriptionId, null, true);
  registry.updateWorkspaceConfig("ws", config);
  const configFrames = frames.filter(
    (frame) =>
      frame.topic === "workspace-config/ws" && frame.subscriptionId === configAck.subscriptionId,
  );
  assert.equal(configFrames.at(-2)?.deliveryKind, "recovery");
  assert.equal(configFrames.at(-2)?.frame?.toSeq, 2);
  assert.equal(configFrames.at(-1)?.frame?.fromSeq, 2);
});

test("C6: renameColdSession 下发 rename_session 并同步 sessions-index 标题；失败透传错误码", async () => {
  const frames: string[] = [];
  const sent: unknown[] = [];
  let failRename = false;
  // omp 落盘新标题后，适配器 store 重扫应读到新值（fake store 以可变标题模拟该事实）。
  let storeTitle = "old title";
  const directory = createDirectoryStub((command) => {
    if (command.type !== "rename_session") return { success: true, data: {} };
    if (failRename) {
      return { success: false, error: "Unknown session: cold-1", code: "not_found" };
    }
    storeTitle = command.name;
    return { success: true, data: { sessionId: command.sessionId, name: command.name } };
  });
  const cold = () => [
    {
      sessionId: "cold-1",
      sessionPath: "C:/sessions/cold-1.jsonl",
      title: storeTitle,
      firstUserText: "hello",
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  const registry = new SessionRegistry({
    ompFactory: {
      create: () => {
        throw new Error("unexpected omp process");
      },
    } as OmpProcessFactory,
    store: {
      listSessions: async () => cold(),
      findSession: async () => null,
      readSessionEntries: async () => [],
      deleteSession: async () => true,
    } as unknown as OmpStorePort,
    gateway: { emitFrame: (frame: unknown) => frames.push(JSON.stringify(frame)) } as HostGateway,
    directory,
  });
  directory.setForkSurface(true);
  // createSession 只为建立 primaryWorkspace（冷改名索引回写需要）。
  await registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  await registry.subscribeSessionsIndex({
    workspaceId: "ws",
    workspacePath: "C:/work",
    connectionId: "c6",
  });
  assert.ok(
    frames.some((frame) => frame.includes("old title")),
    "冷会话应先以旧标题进索引",
  );
  const ok = await registry.renameColdSession("cold-1", "new title");
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(sent.length, 0, "v1 目录车道不得承载 rename");
  assert.deepEqual(
    directory.sentDirectoryCommands.filter((command) => command.type === "rename_session"),
    [{ type: "rename_session", sessionId: "cold-1", name: "new title" }],
  );
  assert.ok(
    frames.some(
      (frame) => frame.includes('"session.upserted"') && frame.includes("new title"),
      `改名后 sessions-index 应回写新标题：${frames.slice(-3).join("|")}`,
    ),
  );
  // 失败透传：omp not_found 的错误与错误码原样交还调用方（v4 命令层据此报 -32004）。
  failRename = true;
  const failed = await registry.renameColdSession("cold-1", "again");
  assert.deepEqual(failed, {
    ok: false,
    unsupported: false,
    error: "Unknown session: cold-1",
    code: "not_found",
  });
  // 旧核（v3 能力缺失）：明确 unsupported，调用方维持既有 -32004 语义。
  directory.setForkSurface(false);
  const unsupported = await registry.renameColdSession("cold-1", "third");
  assert.deepEqual(unsupported, { ok: false, unsupported: true });
});

for (const identityKind of ["local-fallback", "explicit-local", "remote"] as const) {
  test(`F016: 公开 v4 createSession 严格绑定 ${identityKind} 身份，拒绝先于创建和附件处理`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "omp-create-identity-"));
    const workspacePath = join(root, "workspace");
    const filesPath = join(root, "sessions");
    await mkdir(workspacePath);
    await mkdir(filesPath);
    const workspaceKey =
      identityKind === "local-fallback"
        ? workspacePath
        : identityKind === "explicit-local"
          ? "local:bound-project"
          : "ssh:host:bound-project";
    const frames: unknown[] = [];
    const processCwds: string[] = [];
    const prompts: string[] = [];
    const app = new ServerApp({
      workspacePath,
      workspaceKey,
      ...(identityKind !== "local-fallback" ? { workspaceIdentity: workspaceKey } : {}),
      loadWorkspaceConfig: async () => ({ configOptions: [], slashCommands: [] }),
      loadWorkspaceSkillCommands: async () => [],
      directory: createDirectoryStub(),
      store: {
        listSessions: async () => [],
        readSessionEntries: async () => [],
        readSubagentEntries: async () => [],
        deleteSession: async () => true,
      },
      gateway: {
        emitFrame: (frame) => frames.push(frame),
        requestUserInput: async () => ({ action: "cancel" }),
      },
      ompFactory: {
        create(options) {
          processCwds.push(options.cwd);
          const sessionFile = join(filesPath, `process-${processCwds.length}.jsonl`);
          return {
            ompSessionFile: sessionFile,
            start: async () => {
              await writeFile(sessionFile, '{"type":"session"}\\n');
            },
            send: async (command) => {
              if (command.type === "prompt") {
                prompts.push(command.message);
                return { success: true, data: { agentInvoked: false } };
              }
              return { success: true, data: {} };
            },
            refreshState: async () => null,
            readContextReport: async () => null,
            respondUi: () => {},
            dispose: async () => {},
          };
        },
      },
    });
    context.after(async () => {
      await app.registry.dispose();
      await rm(root, { recursive: true, force: true });
    });
    let creates = 0;
    const createSession = app.registry.createSession.bind(app.registry);
    app.registry.createSession = (params) => {
      creates += 1;
      return createSession(params);
    };
    const envelope = (commandId: string, payload: CommandPayloadMap["createSession"]) => ({
      commandId,
      clientId: "identity-test",
      sessionId: null,
      type: "createSession",
      issuedAt: 1,
      payload,
    });
    // 显式身份和远程身份不能把同一执行路径当作另一合法 workspace key。
    const wrongWorkspace = identityKind === "local-fallback" ? "other-workspace" : workspacePath;
    for (const firstInput of [
      undefined,
      { text: "must not send" },
      {
        text: "must not inspect attachment",
        attachments: [
          { ref: "missing-reference", fileName: "test.txt", mime: "text/plain", bytes: 1 },
        ],
      },
    ]) {
      const commandId = `wrong-${firstInput?.text ?? "draft"}`;
      const request = envelope(commandId, {
        workspaceId: wrongWorkspace,
        ...(firstInput ? { firstInput } : {}),
      });
      const [first, concurrent] = await Promise.all([
        app.handleRequest(V4_METHODS.command, request),
        app.handleRequest(V4_METHODS.command, request),
      ]);
      const rejected = commandAckSchema.parse(first);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.reasonCode, "fault.command.workspaceMismatch");
      assert.deepEqual(concurrent, first);
      assert.deepEqual(await app.handleRequest(V4_METHODS.command, request), first);
      // 同一 command ID 即使换成匹配 payload，也不能把已决拒绝改成创建。
      assert.deepEqual(
        await app.handleRequest(
          V4_METHODS.command,
          envelope(commandId, { workspaceId: workspaceKey }),
        ),
        first,
      );
    }
    assert.equal(creates, 0, "不构造任何会话引擎");
    assert.deepEqual(processCwds, [], "不构造任何 omp 进程");
    assert.deepEqual(prompts, [], "不发送首问");
    assert.deepEqual(await readdir(filesPath), [], "不落盘会话文件");
    for (const key of [workspaceKey, wrongWorkspace]) {
      await app.handleRequest(V4_METHODS.conversationSubscribe, {
        topic: `sessions-index/${key}`,
        connectionId: "index-test",
      });
      const wire = sessionsIndexTopicWireFrameSchema.parse(frames.at(-1));
      assert.equal(wire.kind, "complete");
      if (wire.kind === "complete") {
        assert.equal(wire.frame.payload.kind, "snapshot");
        if (wire.frame.payload.kind === "snapshot")
          assert.deepEqual(wire.frame.payload.snapshot.sessions, []);
      }
    }
    const draft = commandAckSchema.parse(
      await app.handleRequest(
        V4_METHODS.command,
        envelope("matching-draft", { workspaceId: workspaceKey }),
      ),
    );
    assert.equal(draft.status, "accepted");
    assert.equal(creates, 1);
    assert.deepEqual(processCwds, [], "匹配的空会话仍惰性启动");
    const accepted = commandAckSchema.parse(
      await app.handleRequest(
        V4_METHODS.command,
        envelope("matching-input", {
          workspaceId: workspaceKey,
          firstInput: { text: "bound first input" },
        }),
      ),
    );
    assert.equal(accepted.status, "accepted");
    assert.equal(creates, 2);
    assert.deepEqual(processCwds, [workspacePath]);
    assert.deepEqual(prompts, ["bound first input"]);
    assert.equal((await readdir(filesPath)).length, 1);
    assert.ok(accepted.result?.type === "createSession");
    if (accepted.result?.type !== "createSession") throw new Error("expected create result");
    const engine = app.registry.requireEngine(accepted.result.sessionId);
    assert.equal(engine.workspaceId, workspaceKey);
    assert.equal(engine.workspacePath, workspacePath);
    app.registry.upsertEngineSummary(engine);
    await app.handleRequest(V4_METHODS.conversationSubscribe, {
      topic: `sessions-index/${workspaceKey}`,
      connectionId: "index-positive",
    });
    const index = sessionsIndexTopicWireFrameSchema.parse(frames.at(-1));
    assert.equal(index.kind, "complete");
    if (index.kind === "complete" && index.frame.payload.kind === "snapshot") {
      const session = index.frame.payload.snapshot.sessions.find(
        (item) => item.sessionId === engine.sessionId,
      );
      assert.equal(session?.workspaceId, workspaceKey);
    } else throw new Error("expected complete index snapshot");
    await app.handleRequest(V4_METHODS.conversationSubscribe, {
      topic: `conversation/${engine.sessionId}`,
      sessionId: engine.sessionId,
      connectionId: "session-positive",
      clientMode: "desktop-continuous",
    });
    const conversation = conversationTopicWireFrameSchema.parse(frames.at(-1));
    assert.equal(conversation.topic, `conversation/${engine.sessionId}`);
  });
}
