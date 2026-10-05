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
import type {
  HostGateway,
  OmpProjectGatewayPort,
  OmpStorePort,
  OmpProcessFactory,
} from "../src/app/ports.js";

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

function fakeProjectPort(overrides: {
  createSession?: () => Promise<{ sessionId: string }>;
  resumeSession?: (sessionId: string) => Promise<{ sessionId: string } | Error>;
}): OmpProjectGatewayPort {
  return {
    available: async () => true,
    availability: async () => "available",
    createSession: overrides.createSession ?? (async () => ({ sessionId: "unexpected" })),
    resumeSession:
      overrides.resumeSession ??
      (async (sessionId: string) => {
        throw new Error(`resumeSession must not be called (got ${sessionId})`);
      }),
    deleteSession: async () => ({ success: true }),
    sendProject: async () => ({ success: true, data: {} }),
    acquireSessionChannel: async () => {
      throw new Error("channel must not be acquired in this test");
    },
    dispose: async () => {},
  } as unknown as OmpProjectGatewayPort;
}

test("C7②: createSession 在途时并发 resumeSession 等待登记后返回活引擎", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumed = false;
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: coldStore([]),
    gateway,
    project: fakeProjectPort({
      createSession: async () => {
        await gate;
        return { sessionId: "proj-s1" };
      },
      resumeSession: async () => {
        resumed = true;
        return { sessionId: "proj-s1" };
      },
    }),
  });
  const creating = registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  const resuming = registry.resumeSession({
    sessionId: "proj-s1",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  release();
  const [created, resumedEngine] = await Promise.all([creating, resuming]);
  assert.ok(created instanceof ConversationEngine);
  assert.equal(resumedEngine, created, "resume 必须返回已登记的活引擎，而不是新建冷引擎覆盖");
  assert.equal(registry.getEngine("proj-s1"), created);
  assert.equal(resumed, false, "已有活引擎时不得再走底层 resume_session");
});

test("C7③/C8: create 失败不连坐无关会话的 resume（屏障等待但不传播失败）", async () => {
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: coldStore([]),
    gateway,
    project: fakeProjectPort({
      createSession: async () => {
        await new Promise((sleep) => setTimeout(sleep, 20));
        throw new Error("create failed on purpose");
      },
      resumeSession: async (sessionId) => ({ sessionId }),
    }),
  });
  const failing = registry.createSession({ workspaceId: "ws", workspacePath: "C:/work" });
  // 在途 create 注定失败；无关会话 other-1 的 resume 只需等待屏障，不得继承 create 的错误
  //（修复前 Promise.all 会把 create 的 rejection 传播给本调用）。
  const resuming = registry.resumeSession({
    sessionId: "other-1",
    workspaceId: "ws",
    workspacePath: "C:/work",
  });
  const other = await resuming;
  assert.ok(other instanceof ConversationEngine, "无关会话 resume 应正常完成");
  assert.equal(other.sessionId, "other-1");
  await assert.rejects(() => failing, /create failed on purpose/);
  // 失败 create 不留残留引擎/注册项。
  assert.equal(registry.getEngine("other-1"), other);
});
