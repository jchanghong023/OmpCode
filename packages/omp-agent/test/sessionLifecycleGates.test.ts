// 生命周期域回归 UT（交叉评审 XR-A 指认的零覆盖修复；2026-10-07 适配目录拓扑重写）：
// S7-4（sessionRegistryGates.ts）：删除/关闭墓碑 + settleColdHydration 登记门——
//   deleteSession/closeSession/dispose 进行中或完成后，同身份在途冷恢复（resume 的
//   loadSessionForResume 链）不得把引擎与索引行复活（幽灵引擎 + 幽灵行）；删除失败时
//   墓碑回滚，会话身份仍有效；重复 delete 按错误语义拒绝且无残留副作用。
// 删除权威 = 目录进程 delete_session（omp 权威；失败/抛错均回滚墓碑）；
// resume 的在途异步点 = 冷历史读取（store.readSessionEntries）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
// 精简其他场景后，删除失败回滚场景仍需验证真实引擎实例，不能移除该运行时导入。
import { ConversationEngine } from "../src/app/conversationEngine.js";
import { ProtocolError } from "../src/app/errors.js";
import type {
  HostGateway,
  OmpProcessFactory,
  OmpStorePort,
  OmpStoreSessionSummary,
} from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";
import type { OmpDirectoryCommand } from "../src/domain/ompForkFrames.js";

// ---------------------------------------------------------------------------
// S7-4 共享 harness：冷存储 + v3 目录进程（delete_session 以 present 集合为权威）。
// ---------------------------------------------------------------------------

const hostGateway = {
  emitFrame: () => {},
  requestUserInput: async () => ({ action: "cancel" as const }),
} as unknown as HostGateway;

/** 惰性进程工厂：本组测试走冷恢复（无子进程），factory.create 被调用即失败。 */
const refusingFactory = {
  create: () => {
    throw new Error("omp process must not start in this test");
  },
} as unknown as OmpProcessFactory;

function coldSummary(sessionId: string): OmpStoreSessionSummary {
  return {
    sessionId,
    sessionPath: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
    title: sessionId,
    firstUserText: "hello",
    createdAt: 1,
    updatedAt: 2,
  };
}

/** 可变冷存储：present 模拟 omp 会话文件落盘事实（OMP 删除成功 = 从重扫中消失）。 */
function makeStore(initial: OmpStoreSessionSummary[]) {
  const present = new Map(initial.map((session) => [session.sessionId, session]));
  const store: OmpStorePort = {
    listSessions: async () => [...present.values()],
    findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
    readSessionEntries: async () => [],
    readSubagentEntries: async () => [],
    deleteSession: async () => true,
  };
  return {
    store,
    present,
    removeCold: (sessionId: string) => present.delete(sessionId),
  };
}

interface RegistryOverrides {
  /** 目录 delete_session 行为（默认以 present 为权威）。 */
  deleteSession?: (
    sessionId: string,
  ) => Promise<{ success: boolean; error?: string; code?: string }>;
  /** 冷历史读取门（resume 在途异步点；缺省立即返回空行）。 */
  readSessionEntries?: () => Promise<unknown[]>;
}

function newRegistry(
  present: Map<string, OmpStoreSessionSummary>,
  overrides: RegistryOverrides = {},
): SessionRegistry {
  const directory = createDirectoryStub(() => ({ success: true, data: {} }));
  // delete_session 行为注入：默认以 present 为权威（不在册 → not_found；在册 → 删除成功）。
  const deleteHandler = overrides.deleteSession;
  const directoryAsync = {
    ...directory,
    async sendDirectory(command: OmpDirectoryCommand) {
      if (command.type === "delete_session" && deleteHandler) {
        return deleteHandler(command.sessionId);
      }
      if (command.type === "delete_session") {
        if (!present.has(command.sessionId)) {
          return {
            success: false,
            error: `Unknown session: ${command.sessionId}`,
            code: "not_found",
          };
        }
        present.delete(command.sessionId);
        return { success: true, data: { sessionId: command.sessionId, deleted: true } };
      }
      return directory.sendDirectory(command);
    },
  } as typeof directory;
  directoryAsync.setForkSurface(true);
  return new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [...present.values()],
      findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
      readSessionEntries: overrides.readSessionEntries ?? (async () => []),
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway: hostGateway,
    directory: directoryAsync,
  });
}

const resumeParamsOf = (sessionId: string) => ({
  sessionId,
  workspaceId: "ws",
  workspacePath: "C:/work",
});

function expectUnavailable(error: unknown, messagePattern: RegExp): boolean {
  assert.ok(error instanceof ProtocolError, `必须是 ProtocolError（实际 ${String(error)}）`);
  assert.equal(error.code, -32004);
  assert.match(error.message, messagePattern);
  return true;
}

// ---------------------------------------------------------------------------
// S7-4a：deleteSession 完成 + 在途 resume settle → 登记门拒绝，无幽灵引擎/幽灵行。
// ---------------------------------------------------------------------------

test("S7-4a: deleteSession 完成后，在途冷恢复被登记门拒绝——不复活引擎与索引行", async () => {
  const { present, removeCold } = makeStore([coldSummary("s1")]);
  let parked = () => {};
  const resumeParked = new Promise<void>((resolve) => {
    parked = resolve;
  });
  let release!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frames: string[] = [];
  const frameGateway = {
    emitFrame: (frame: unknown) => frames.push(JSON.stringify(frame)),
    requestUserInput: async () => ({ action: "cancel" as const }),
  } as unknown as HostGateway;
  const directory = createDirectoryStub();
  directory.setForkSurface(true);
  const deletingDirectory = {
    ...directory,
    async sendDirectory(command: OmpDirectoryCommand) {
      if (command.type === "delete_session") {
        removeCold(command.sessionId);
        return { success: true, data: { sessionId: command.sessionId, deleted: true } };
      }
      return directory.sendDirectory(command);
    },
  } as typeof directory;
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [...present.values()],
      findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
      // 冷历史读取门：resume 已过 findSession 后悬挂；delete 于此窗口内完成。
      readSessionEntries: async () => {
        parked();
        await resumeGate;
        return [];
      },
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway: frameGateway,
    directory: deletingDirectory,
  });
  const ack = await registry.subscribeSessionsIndex({
    workspaceId: "ws",
    workspacePath: "C:/work",
    connectionId: "s7-4a",
  });
  const resuming = registry.resumeSession(resumeParamsOf("s1"));
  await resumeParked;
  // 删除在 resume 在途期间完成：墓碑登记 + OMP 侧删除成功（磁盘会话文件消失）。
  await registry.deleteSession("s1");
  release();

  // 冷恢复完成时的登记必须被墓碑拒绝，按「会话不可用」报错。
  await assert.rejects(
    () => resuming,
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(registry.getEngine("s1"), null, "已删会话不得留下幽灵引擎");
  assert.equal(
    (await registry.listLegacySessions("C:/work", "ws")).some(
      (session) => session.sessionId === "s1",
    ),
    false,
    "已删会话不得在会话列表复活幽灵行",
  );
  // 水合期间短暂写入的索引行必须被登记门清理：强制重发快照验证最终索引状态。
  registry.resyncIndexOrConfig(ack.subscriptionId, null, true);
  type IndexFrame = {
    topic?: string;
    frame?: { payload?: { kind?: string; snapshot?: { sessions?: { sessionId: string }[] } } };
  };
  const snapshots = frames
    .map((frame) => JSON.parse(frame) as IndexFrame)
    .filter(
      (frame) => frame.topic === "sessions-index/ws" && frame.frame?.payload?.kind === "snapshot",
    );
  const lastSnapshot = snapshots.at(-1);
  assert.ok(lastSnapshot, "必须能取到 sessions-index 快照");
  assert.equal(
    lastSnapshot.frame?.payload?.snapshot?.sessions?.some((session) => session.sessionId === "s1"),
    false,
    `sessions-index 不得残留已删会话行：${JSON.stringify(lastSnapshot.frame?.payload?.snapshot?.sessions)}`,
  );
});

// ---------------------------------------------------------------------------
// S7-4b：删除失败（结果失败 / 抛错）→ 墓碑回滚，后续 resume 仍可正常加载。
// ---------------------------------------------------------------------------

test("S7-4b1: 目录 delete_session 返回失败时墓碑回滚，同身份 resume 仍可正常加载", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  const registry = newRegistry(present, {
    deleteSession: async () => ({
      success: false,
      error: "denied by omp policy",
      code: "unsupported",
    }),
  });
  await assert.rejects(() => registry.deleteSession("s1"), /denied by omp policy/);
  const engine = await registry.resumeSession(resumeParamsOf("s1"));
  assert.ok(engine instanceof ConversationEngine);
  assert.equal(registry.getEngine("s1"), engine, "删除失败回滚墓碑后，会话身份仍有效可加载");
});

test("S7-4b2: 目录进程传输层抛错时墓碑同样回滚，后续 resume 不受影响", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  const directory = createDirectoryStub(() => {
    throw new Error("omp rpc broken");
  });
  directory.setForkSurface(true);
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [...present.values()],
      findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway: hostGateway,
    directory,
  });
  await assert.rejects(() => registry.deleteSession("s1"), /omp rpc broken/);
  const engine = await registry.resumeSession(resumeParamsOf("s1"));
  assert.equal(registry.getEngine("s1"), engine);
});

// ---------------------------------------------------------------------------
// S7-4c：closeSession 与在途 resume 的语义（关闭后重开 = 全新冷加载，不复活旧实例）。
// ---------------------------------------------------------------------------

test("S7-4c1: closeSession 完成后 resume 得到全新引擎——被关闭实例不复活", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  let hydrationReads = 0;
  const registry = newRegistry(present, {
    readSessionEntries: async () => {
      hydrationReads += 1;
      return [];
    },
  });
  const closed = await registry.resumeSession(resumeParamsOf("s1"));
  assert.equal(registry.getEngine("s1"), closed);
  await registry.closeSession("s1");
  assert.equal(registry.getEngine("s1"), null, "关闭后引擎必须卸载");

  // 关闭完成后重新打开：必须是全新的冷加载（重新走一次冷历史水合），而不是把已
  // dispose 的旧实例重新塞回注册表。
  const reopened = await registry.resumeSession(resumeParamsOf("s1"));
  assert.notEqual(reopened, closed, "重新打开必须得到全新引擎实例");
  assert.equal(registry.getEngine("s1"), reopened);
  assert.equal(hydrationReads, 2, "重开必须重新走一次冷加载");
});

test("S7-4c2: closeSession 与在途冷恢复并发、close 先完成时按重开语义正常登记", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  let parked = () => {};
  const resumeParked = new Promise<void>((resolve) => {
    parked = resolve;
  });
  let release!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = newRegistry(present, {
    readSessionEntries: async () => {
      parked();
      await resumeGate;
      return [];
    },
  });
  const resuming = registry.resumeSession(resumeParamsOf("s1"));
  await resumeParked;
  // 无引擎在册的 close 是墓碑窗口极短的收尾：close 完成后 tombstone 解除，
  // 在途冷恢复按「关闭完成后重新打开不受影响」语义正常登记。
  await registry.closeSession("s1");
  release();
  const engine = await resuming;
  assert.equal(registry.getEngine("s1"), engine, "close 完成后 settle 的冷恢复按重开语义登记");
});

// ---------------------------------------------------------------------------
// S7-4d：重复 delete 第二次按 OMP 错误语义拒绝，且无墓碑残留副作用。
// ---------------------------------------------------------------------------

test("S7-4d: 重复 delete 第二次按错误语义拒绝，且无墓碑残留副作用", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  const registry = newRegistry(present);
  await registry.deleteSession("s1"); // 第一次：OMP 删除成功（会话文件消失）
  // 第二次：OMP 侧会话已不存在，按错误语义拒绝。
  await assert.rejects(
    () => registry.deleteSession("s1"),
    (error: unknown) => expectUnavailable(error, /Unknown session: s1/),
  );
  // 失败回滚后无残留副作用：读面无幽灵行；resume 拿到真实的 unavailable 错误而非悬挂。
  assert.equal(registry.getEngine("s1"), null);
  assert.deepEqual(
    (await registry.listLegacySessions("C:/work", "ws")).map((session) => session.sessionId),
    [],
  );
  await assert.rejects(
    () => registry.resumeSession(resumeParamsOf("s1")),
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(registry.getEngine("s1"), null, "失败的 resume 不得登记引擎");
});

// ---------------------------------------------------------------------------
// S7-4：registry.dispose 作废在途冷恢复的登记（disposing 门）。
// ---------------------------------------------------------------------------

test("S7-4: registry.dispose 后完成的冷恢复不得重新登记引擎", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  let parked = () => {};
  const resumeParked = new Promise<void>((resolve) => {
    parked = resolve;
  });
  let release!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = newRegistry(present, {
    readSessionEntries: async () => {
      parked();
      await resumeGate;
      return [];
    },
  });
  const resuming = registry.resumeSession(resumeParamsOf("s1"));
  await resumeParked;
  await registry.dispose(); // beginDispose → 销毁期间/之后完成的登记一律作废
  release();
  await assert.rejects(
    () => resuming,
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(registry.getEngine("s1"), null, "dispose 后不得重新登记引擎");
});
