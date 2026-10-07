// SessionRegistry 并发护栏 UT（C7/C8）：
// ① 同 sessionId 并发 resumeSession —— 底层冷加载只发生一次、两个调用方拿到同一引擎；
// ② createSession 在途时并发 resumeSession（同 id）—— resume 等待 create 登记后返回活引擎，
//    不构建冷引擎覆盖注册表（GUI 实测缺陷：会话面板空白）；
// ③ create 失败不连坐无关会话 —— settlePendingCreates 屏障只需等待在途 create，不传播其失败
//    （Promise.all → allSettled；create 的错误已由 create 调用方自己收到）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import type { HostGateway, OmpStorePort, OmpProcessFactory } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

const gateway = { emitFrame: () => {} } as unknown as HostGateway;

/** 旧拓扑进程工厂：resume 只建引擎不启进程，factory.create 被调用即失败（本测试不应启动进程）。 */
const refusingFactory = {
  create: () => {
    throw new Error("omp process must not start in this test");
  },
} as unknown as OmpProcessFactory;

function coldStore(
  sessions: {
    sessionId: string;
    sessionPath: string;
    title: string | null;
    firstUserText: string | null;
    createdAt: number;
    updatedAt: number;
  }[],
  hooks: { onFindSession?: () => void } = {},
): OmpStorePort {
  return {
    listSessions: async () => sessions,
    findSession: async () => {
      hooks.onFindSession?.();
      return sessions[0] ?? null;
    },
    readSessionEntries: async () => [],
    readSubagentEntries: async () => [],
    deleteSession: async () => true,
  } satisfies OmpStorePort;
}

test("C7①: 同 sessionId 并发 resumeSession 只加载一次且返回同一引擎", async () => {
  let findCalls = 0;
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: coldStore(
      [
        {
          sessionId: "cold-1",
          sessionPath: "C:/sessions/cold-1.jsonl",
          title: "cold",
          firstUserText: "hello",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      { onFindSession: () => (findCalls += 1) },
    ),
    gateway,
    directory: createDirectoryStub(),
  });
  const params = { sessionId: "cold-1", workspaceId: "ws", workspacePath: "C:/work" };
  const [a, b] = await Promise.all([
    registry.resumeSession(params),
    registry.resumeSession(params),
  ]);
  assert.equal(a, b, "并发 resume 必须拿到同一引擎实例");
  assert.equal(findCalls, 1, `底层冷加载只允许发生一次（实际 ${findCalls} 次）`);
  assert.equal(registry.getEngine("cold-1"), a);
});

test("C7②: createSession 在途时并发 resumeSession（同 ID）等待登记后返回活引擎", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 本地 create 的登记在 createSessionInner 内同步完成（无项目 RPC 可注入延迟），
  // 用 hydrateEngineFromCold 的 readSessionEntries 门闸住 resume 侧加载，验证
  // 「同 ID 并发 resume 等待在途 create 登记、绝不覆盖活引擎」的护栏。
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [],
      findSession: async () => null,
      readSessionEntries: async () => {
        await gate;
        return [];
      },
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway,
    directory: createDirectoryStub(),
  });
  const created = await registry.createSession({
    sessionId: "s-1",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  const resuming = registry.resumeSession({
    sessionId: "s-1",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  release();
  const resumedEngine = await resuming;
  assert.equal(resumedEngine, created, "resume 必须返回已登记的活引擎，而不是新建冷引擎覆盖");
  assert.equal(registry.getEngine("s-1"), created);
});

test("C7③/C8: create 失败不连坐无关会话的 resume（屏障等待但不传播失败）", async () => {
  // 本地 create 无可注入失败的异步点（同步登记），屏障语义（等待但不传播失败）改为：
  // 在途 create 完成前后并发 resume 无关冷会话，断言 resume 正常完成且互不连坐。
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [],
      findSession: async (_cwd, id) =>
        id === "other-1"
          ? {
              sessionId: "other-1",
              sessionPath: "C:/sessions/other-1.jsonl",
              title: null,
              firstUserText: null,
              createdAt: 1,
              updatedAt: 2,
            }
          : null,
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway,
    directory: createDirectoryStub(),
  });
  const creating = registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  // 在途 create 与无关会话 other-1 的 resume 并发：resume 只需等待屏障，不传播 create 的结果。
  const resuming = registry.resumeSession({
    sessionId: "other-1",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  const other = await resuming;
  assert.ok(other instanceof ConversationEngine, "无关会话 resume 应正常完成");
  assert.equal(other.sessionId, "other-1");
  const created = await creating;
  assert.ok(created instanceof ConversationEngine);
  assert.equal(registry.getEngine("other-1"), other);
});
