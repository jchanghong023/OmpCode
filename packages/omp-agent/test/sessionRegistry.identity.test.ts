import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "../src/app/ports.js";
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
      listSessions: async () => [{ sessionId: stableId, sessionPath, title: "test", firstUserText: "test", createdAt: 1, updatedAt: 2 }],
      readSessionEntries: async () => [],
      deleteSession: async () => true,
    } as OmpStorePort,
    gateway: { send: () => {} } as unknown as HostGateway,
  });
  const engine = await registry.createSession({ sessionId: "omp-session-temporary", workspaceId: "ws", workspacePath: "C:/work" });
  await engine.ensureOmpStarted();
  const sessions = await registry.listLegacySessions("C:/work", "ws");
  assert.deepEqual(sessions.map((item) => item.sessionId), ["omp-session-temporary"]);
  assert.equal(registry.getEngine(stableId), engine);
  assert.equal(registry.getEngine("omp-session-temporary"), engine);
});

test("运行中保持临时 ID，先结算该 ID 的终态再切到稳定 UUID", async () => {
  const stableId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  const temporaryId = "omp-session-automation";
  const sessionPath = `C:/sessions/2026-09-25T04-28-16-187Z_${stableId}.jsonl`;
  const frames: string[] = [];
  const registry = new SessionRegistry({
    ompFactory: { create: () => ({
      ompSessionFile: sessionPath, start: async () => {}, send: async () => ({ success: true }),
      respondUi: () => {}, refreshState: async () => null, readContextReport: async () => null,
      dispose: async () => {},
    }) } as OmpProcessFactory,
    store: {
      listSessions: async () => [{ sessionId: stableId, sessionPath, title: "test", firstUserText: "test", createdAt: 1, updatedAt: 2 }],
      readSessionEntries: async () => [], deleteSession: async () => true,
    } as OmpStorePort,
    gateway: { emitFrame: (frame: unknown) => frames.push(JSON.stringify(frame)) } as HostGateway,
  });
  const engine = await registry.createSession({ sessionId: temporaryId, workspaceId: "ws", workspacePath: "C:/work" });
  await engine.ensureOmpStarted();
  engine.projection.beginUserTurn({ text: "run", inputId: "input-auto", sourceCommandId: "cmd-auto", clientId: "client" });
  registry.upsertEngineSummary(engine);
  await registry.subscribeSessionsIndex({ workspaceId: "ws", workspacePath: "C:/work", connectionId: "test" });
  assert.deepEqual((await registry.listLegacySessions("C:/work", "ws")).map((item) => item.sessionId), [temporaryId]);
  engine.projection.finishTurn("success");
  registry.upsertEngineSummary(engine);
  const terminal = frames.findIndex((frame) => frame.includes('"session.upserted"') && frame.includes(temporaryId) && frame.includes("completedSuccess"));
  const removed = frames.findIndex((frame) => frame.includes('"session.removed"') && frame.includes(temporaryId));
  const stable = frames.findIndex((frame) => frame.includes('"session.upserted"') && frame.includes(stableId));
  assert.ok(terminal >= 0 && removed > terminal && stable > removed, JSON.stringify(frames.slice(-5)));
  assert.deepEqual((await registry.listLegacySessions("C:/work", "ws")).map((item) => item.sessionId), [stableId]);
  const tempAck = engine.subscribe({ sessionId: temporaryId, connectionId: "old", clientMode: "desktop-continuous" });
  const stableAck = engine.subscribe({ sessionId: stableId, connectionId: "new", clientMode: "web-remote-replayable" });
  assert.ok(frames.some((frame) => frame.includes(`"topic":"conversation/${temporaryId}"`) && frame.includes(tempAck.subscriptionId)));
  assert.ok(frames.some((frame) => frame.includes(`"topic":"conversation/${stableId}"`) && frame.includes(stableAck.subscriptionId)));
  const legacy = buildLegacySnapshot({ engine, sessionId: stableId, workspaceKey: "ws", workspacePath: "C:/work" });
  assert.equal((legacy.session as { sessionId: string }).sessionId, stableId);
  assert.equal((legacy.projection as { sessionId: string }).sessionId, stableId);
});

test("sessions-index 与 workspace-config 恢复后从当前水位继续发 delta", async () => {
  type Wire = { kind: string; topic: string; subscriptionId: string; deliveryKind: string; frame?: { fromSeq: number; toSeq: number } };
  const frames: Wire[] = [];
  const registry = new SessionRegistry({
    ompFactory: { create: () => { throw new Error("unexpected omp process"); } } as OmpProcessFactory,
    store: { listSessions: async () => [] } as unknown as OmpStorePort,
    gateway: { emitFrame: (frame: Wire) => frames.push(frame) } as unknown as HostGateway,
  });
  const engine = await registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  const index = await registry.subscribeSessionsIndex({ workspaceId: "ws", workspacePath: "C:/work", connectionId: "test" });
  registry.upsertEngineSummary(engine);
  registry.resyncIndexOrConfig(index.subscriptionId, null, true);
  registry.upsertEngineSummary(engine);
  const indexFrames = frames.filter((frame) => frame.topic === "sessions-index/ws" && frame.subscriptionId === index.subscriptionId);
  assert.equal(indexFrames.at(-2)?.deliveryKind, "recovery");
  assert.equal(indexFrames.at(-2)?.frame?.toSeq, 2);
  assert.equal(indexFrames.at(-1)?.frame?.fromSeq, 2);

  const config = { configOptions: [], slashCommands: [] };
  const configAck = registry.subscribeWorkspaceConfig({ workspaceId: "ws", config });
  registry.updateWorkspaceConfig("ws", config);
  registry.resyncIndexOrConfig(configAck.subscriptionId, null, true);
  registry.updateWorkspaceConfig("ws", config);
  const configFrames = frames.filter((frame) => frame.topic === "workspace-config/ws" && frame.subscriptionId === configAck.subscriptionId);
  assert.equal(configFrames.at(-2)?.deliveryKind, "recovery");
  assert.equal(configFrames.at(-2)?.frame?.toSeq, 2);
  assert.equal(configFrames.at(-1)?.frame?.fromSeq, 2);
});
