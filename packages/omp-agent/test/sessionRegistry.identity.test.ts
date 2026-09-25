import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import type { HostGateway, OmpProcessFactory, OmpStorePort } from "../src/app/ports.js";

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
});
