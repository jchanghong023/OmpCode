// 生命周期域回归 UT（交叉评审 XR-A 指认的零覆盖修复）：
// S7-4（sessionRegistryGates.ts）：删除/关闭墓碑 + settleColdHydration 登记门——
//   deleteSession/closeSession/dispose 进行中或完成后，同身份在途冷恢复（resume 的
//   loadSessionForResume 链）不得把引擎与索引行复活（幽灵引擎 + 幽灵行）；删除失败时
//   墓碑回滚，会话身份仍有效；重复 delete 按错误语义拒绝且无残留副作用。
// S7-1（ompEngineProcess.ts 项目分支）：共享项目进程在「通道获取 → 引导完成」窗口内死亡
//   时，死通道不得留在引擎上（setProcess(null) + dispose + 可重试失败），下次调用经
//   gateway.acquireSessionChannel 幂等重建。

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import { SessionRegistryGates } from "../src/app/sessionRegistryGates.js";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import { startEngineProcess, type EngineProcessStartHost } from "../src/app/ompEngineProcess.js";
import { ProtocolError } from "../src/app/errors.js";
import type { OmpInteractionProxy } from "../src/app/ompInteractionProxy.js";
import type {
  HostGateway,
  OmpCommandOutcome,
  OmpProcessFactory,
  OmpProjectGatewayPort,
  OmpProjectSessionSummaryPort,
  OmpSessionProcess,
  OmpSessionProcessHandlers,
  OmpStorePort,
  OmpStoreSessionSummary,
} from "../src/app/ports.js";

// ---------------------------------------------------------------------------
// S7-4 共享 harness：冷存储 + 可控项目网关（fake 形状对齐 sessionRegistryConcurrency）。
// ---------------------------------------------------------------------------

const hostGateway = {
  emitFrame: () => {},
  requestUserInput: async () => ({ action: "cancel" as const }),
} as unknown as HostGateway;

/** 旧拓扑进程工厂：本组测试走项目模式冷恢复（惰性、无子进程），factory.create 被调用即失败。 */
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

interface ProjectOverrides {
  resumeSession?: (sessionId: string) => Promise<OmpProjectSessionSummaryPort>;
  deleteSession?: (sessionId: string) => Promise<OmpCommandOutcome>;
}

/**
 * 项目模式网关 fake：默认 resume/delete 以 present 集合为权威（不在册即 not found），
 * acquireSessionChannel 被调用即失败——冷恢复必须保持惰性（幽灵引擎不得挂进程）。
 */
function projectPort(
  present: Map<string, OmpStoreSessionSummary>,
  overrides: ProjectOverrides = {},
): OmpProjectGatewayPort {
  const summaryOf = (sessionId: string): OmpProjectSessionSummaryPort => ({
    sessionId,
    sessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
    name: sessionId,
  });
  return {
    available: async () => true,
    availability: async () => "available",
    createSession: async () => {
      throw new Error("createSession must not be called in this test");
    },
    resumeSession:
      overrides.resumeSession ??
      (async (sessionId) => {
        if (!present.has(sessionId)) {
          throw new Error(`omp: session not found: ${sessionId}`);
        }
        return summaryOf(sessionId);
      }),
    deleteSession:
      overrides.deleteSession ??
      (async (sessionId) => {
        if (!present.has(sessionId)) {
          return { success: false, error: `Unknown session: ${sessionId}`, code: "not_found" };
        }
        present.delete(sessionId);
        return { success: true };
      }),
    sendProject: async () => ({ success: true, data: {} }),
    acquireSessionChannel: async () => {
      throw new Error("acquireSessionChannel must not be called in this test");
    },
    dispose: async () => {},
  };
}

function newRegistry(
  present: Map<string, OmpStoreSessionSummary>,
  overrides: ProjectOverrides = {},
): SessionRegistry {
  return new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [...present.values()],
      findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway: hostGateway,
    project: projectPort(present, overrides),
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
  const registry = new SessionRegistry({
    ompFactory: refusingFactory,
    store: {
      listSessions: async () => [...present.values()],
      findSession: async (_cwd, sessionId) => present.get(sessionId) ?? null,
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    } satisfies OmpStorePort,
    gateway: frameGateway,
    project: projectPort(present, {
      // resume 已被 OMP 接受后在途悬挂；delete 于此窗口内完成。
      resumeSession: async (sessionId) => {
        parked();
        await resumeGate;
        return {
          sessionId,
          sessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
          name: sessionId,
        };
      },
      deleteSession: async (sessionId) => {
        removeCold(sessionId);
        return { success: true };
      },
    }),
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

test("S7-4b1: project.deleteSession 返回失败时墓碑回滚，同身份 resume 仍可正常加载", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  const registry = newRegistry(present, {
    deleteSession: async () => ({ success: false, error: "denied by omp policy" }),
  });
  await assert.rejects(() => registry.deleteSession("s1"), /denied by omp policy/);
  const engine = await registry.resumeSession(resumeParamsOf("s1"));
  assert.ok(engine instanceof ConversationEngine);
  assert.equal(registry.getEngine("s1"), engine, "删除失败回滚墓碑后，会话身份仍有效可加载");
});

test("S7-4b2: project.deleteSession 抛错时墓碑同样回滚，后续 resume 不受影响", async () => {
  const { present } = makeStore([coldSummary("s1")]);
  const registry = newRegistry(present, {
    deleteSession: async () => {
      throw new Error("omp rpc broken");
    },
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
  let resumeCalls = 0;
  const registry = newRegistry(present, {
    resumeSession: async (sessionId) => {
      if (!present.has(sessionId)) {
        throw new Error(`omp: session not found: ${sessionId}`);
      }
      resumeCalls += 1;
      return {
        sessionId,
        sessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
        name: sessionId,
      };
    },
  });
  const closed = await registry.resumeSession(resumeParamsOf("s1"));
  assert.equal(registry.getEngine("s1"), closed);
  await registry.closeSession("s1");
  assert.equal(registry.getEngine("s1"), null, "关闭后引擎必须卸载");

  // 关闭完成后重新打开：必须是全新的冷加载（重新执行 resume_session），而不是把已
  // dispose 的旧实例重新塞回注册表。
  const reopened = await registry.resumeSession(resumeParamsOf("s1"));
  assert.notEqual(reopened, closed, "重新打开必须得到全新引擎实例");
  assert.equal(registry.getEngine("s1"), reopened);
  assert.equal(resumeCalls, 2, "重开必须重新走一次底层 resume_session");
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
    resumeSession: async (sessionId) => {
      parked();
      await resumeGate;
      return {
        sessionId,
        sessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
        name: sessionId,
      };
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
    resumeSession: async (sessionId) => {
      parked();
      await resumeGate;
      return {
        sessionId,
        sessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_${sessionId}.jsonl`,
        name: sessionId,
      };
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

// ---------------------------------------------------------------------------
// S7-4 登记门单元语义（SessionRegistryGates）：墓碑窗口、回滚、winner、dispose。
// ---------------------------------------------------------------------------

function gateFixture() {
  const engines = new Map<string, ConversationEngine>();
  const removed: string[] = [];
  const gates = new SessionRegistryGates({
    engines,
    getEngine: (sessionId) => engines.get(sessionId) ?? null,
    removeIndexSession: (workspaceId, sessionId) => removed.push(`${workspaceId}/${sessionId}`),
  });
  return { gates, engines, removed };
}

function fakeGateEngine(sessionId: string, workspaceId = "ws") {
  let disposals = 0;
  const engine = {
    sessionId,
    workspaceId,
    dispose: async () => {
      disposals += 1;
    },
  } as unknown as ConversationEngine;
  return {
    engine,
    get disposals() {
      return disposals;
    },
  };
}

test("S7-4 门: 删除墓碑在位时冷恢复登记被拒绝并清理索引行，回滚后恢复登记", async () => {
  const { gates, engines, removed } = gateFixture();
  const candidate = fakeGateEngine("s1");
  gates.markDeleted("s1");
  // settleColdHydration 同步抛错；assert.rejects 只捕获拒绝，需经 async 边界转成 rejection。
  await assert.rejects(
    async () => gates.settleColdHydration("s1", candidate.engine),
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(
    candidate.disposals,
    1,
    "被拒绝的冷恢复引擎必须被丢弃销毁（无子进程，dispose 无副作用）",
  );
  assert.ok(removed.includes("ws/s1"), "复活路径写入的索引行必须被登记门清理");
  assert.equal(engines.get("s1"), undefined, "墓碑在位时不得登记引擎");

  gates.rollbackDeleted("s1");
  const settled = gates.settleColdHydration("s1", candidate.engine);
  assert.equal(settled, candidate.engine, "回滚后同身份冷恢复可正常登记");
  assert.equal(engines.get("s1"), candidate.engine);
});

test("S7-4 门: 关闭墓碑只在 close 窗口内拒绝登记，解除后重新打开不受影响", async () => {
  const { gates, engines } = gateFixture();
  const duringClose = fakeGateEngine("s1");
  gates.markClosing("s1");
  await assert.rejects(
    async () => gates.settleColdHydration("s1", duringClose.engine),
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(duringClose.disposals, 1);
  assert.equal(engines.get("s1"), undefined, "正在关闭的会话不得被在途冷恢复登记复活");

  gates.endClosing("s1");
  const reopened = fakeGateEngine("s1");
  const settled = gates.settleColdHydration("s1", reopened.engine);
  assert.equal(settled, reopened.engine, "close 结束后重新打开不受影响");
  assert.equal(engines.get("s1"), reopened.engine);
});

test("S7-4 门: 更早登记的并发实例获胜，后完成的冷恢复不覆盖注册表", async () => {
  const { gates, engines } = gateFixture();
  const first = fakeGateEngine("s1");
  engines.set("s1", first.engine);
  const second = fakeGateEngine("s1");
  const winner = gates.settleColdHydration("s1", second.engine);
  assert.equal(winner, first.engine, "已有更早登记的实例时必须返回已登记引擎");
  assert.equal(engines.get("s1"), first.engine, "注册表不得被后完成的冷恢复覆盖");
});

test("S7-4 门: dispose 置位后所有冷恢复登记被作废", async () => {
  const { gates, engines } = gateFixture();
  gates.beginDispose();
  const candidate = fakeGateEngine("s1");
  await assert.rejects(
    async () => gates.settleColdHydration("s1", candidate.engine),
    (error: unknown) => expectUnavailable(error, /session unavailable: s1/),
  );
  assert.equal(candidate.disposals, 1);
  assert.equal(engines.size, 0, "dispose 期间不得再进表");
});

// ---------------------------------------------------------------------------
// S7-1：共享项目进程死亡 → 死通道不留在引擎上，可经网关幂等重建重试。
// ---------------------------------------------------------------------------

type FakeChannel = OmpSessionProcess & { alive?: boolean; disposeCalls: number };

function fakeChannel(options: { alive?: boolean; sendSucceeds?: boolean } = {}): FakeChannel {
  let disposals = 0;
  const sendSucceeds = options.sendSucceeds ?? true;
  const channel: FakeChannel = {
    ompSessionFile: `C:/sessions/2026-10-01T00-00-00-000Z_ch.jsonl`,
    projectMode: true,
    alive: options.alive,
    start: async () => {},
    send: async () =>
      sendSucceeds
        ? ({ success: true, data: { commands: [{ name: "help" }], subagents: [] } } as Awaited<
            ReturnType<OmpSessionProcess["send"]>
          >)
        : ({ success: false, error: "omp project core is not running" } as Awaited<
            ReturnType<OmpSessionProcess["send"]>
          >),
    respondUi: () => {},
    refreshState: async () => null,
    readContextReport: async () => null,
    dispose: async () => {
      disposals += 1;
    },
    get disposeCalls() {
      return disposals;
    },
  };
  return channel;
}

function engineStartHost(options: {
  acquire: (handlers: OmpSessionProcessHandlers) => Promise<OmpSessionProcess>;
  bootstrap?: (process: OmpSessionProcess) => Promise<void>;
}): { host: EngineProcessStartHost; current: () => OmpSessionProcess | null } {
  let current: OmpSessionProcess | null = null;
  const host: EngineProcessStartHost = {
    workspacePath: "C:/work",
    resumeSessionPath: undefined,
    ompFactory: undefined,
    acquireProjectProcess: options.acquire,
    interaction: {} as OmpInteractionProxy,
    onEvent: () => {},
    onExit: () => {},
    onCommandOutput: () => {},
    onPromptResult: () => {},
    onSessionInfoUpdate: () => {},
    onConfigUpdate: () => {},
    onCommandsUpdate: undefined,
    onSubagentFrame: () => {},
    currentProcess: () => current,
    setProcess: (process) => {
      current = process;
    },
    bootstrap: options.bootstrap ?? (async () => {}),
  };
  return { host, current: () => current };
}

test("S7-1: bootstrap 完成后发现死通道——置空引擎引用并 dispose，按可重试失败抛出", async () => {
  // 通道在获取时存活，引导窗口内随共享项目进程死亡（start/refreshState 吞错，引导“成功”）。
  const channel = fakeChannel({ alive: true, sendSucceeds: false });
  const first = engineStartHost({
    acquire: async () => channel,
    bootstrap: async () => {
      channel.alive = false;
    },
  });
  await assert.rejects(
    () => startEngineProcess(first.host),
    /omp project core exited while bootstrapping session channel/,
    "死通道必须按可重试失败抛出，而不是把死通道留在引擎上",
  );
  assert.equal(first.current(), null, "死通道不得留在引擎上（ompProcess 置空）");
  assert.equal(channel.disposeCalls, 1, "死通道必须被 dispose 回收");
});

test("S7-1: 失败后重试经 gateway.acquireSessionChannel 幂等重建活通道成功", async () => {
  const live = fakeChannel({ alive: true });
  const second = engineStartHost({ acquire: async () => live });
  await startEngineProcess(second.host);
  assert.equal(second.current(), live, "重试后引擎持有重建的活通道");
  assert.equal(live.disposeCalls, 0, "活通道不得被误清理");
});

test("S7-1: bootstrap 抛错且通道已死——同语义清理后按原错误抛出", async () => {
  const channel = fakeChannel({ alive: false, sendSucceeds: false });
  const host = engineStartHost({
    acquire: async () => channel,
    bootstrap: async () => {
      throw new Error("omp bootstrap io failure");
    },
  });
  await assert.rejects(() => startEngineProcess(host.host), /omp bootstrap io failure/);
  assert.equal(host.current(), null, "死通道上的引导失败必须置空引擎引用");
  assert.equal(channel.disposeCalls, 1, "死通道必须被 dispose 回收");
});

test("S7-1: bootstrap 抛错但通道存活——保持不清空、可重试的既有语义", async () => {
  const channel = fakeChannel({ alive: true });
  const host = engineStartHost({
    acquire: async () => channel,
    bootstrap: async () => {
      throw new Error("omp bootstrap io failure");
    },
  });
  await assert.rejects(() => startEngineProcess(host.host), /omp bootstrap io failure/);
  assert.equal(host.current(), channel, "活通道与会话仍在（OMP 侧已加载），不得清空引擎引用");
  assert.equal(channel.disposeCalls, 0, "活通道不得被 dispose（下次调用原通道可重试）");
});

test("S7-1: 引擎级——死通道启动失败后，下次 ensureOmpStarted 经网关重建并可用", async () => {
  const dead = fakeChannel({ alive: false, sendSucceeds: false });
  const live = fakeChannel({ alive: true });
  let acquisitions = 0;
  const engine = new ConversationEngine({
    sessionId: "s1",
    workspaceId: "ws",
    workspacePath: "C:/work",
    gateway: hostGateway,
    onIndexChange: () => {},
    acquireProjectProcess: async () => {
      acquisitions += 1;
      return acquisitions === 1 ? dead : live;
    },
  });
  // 首次启动：通道已死（进程死亡窗口），按可重试失败抛出且引擎不保留死通道。
  await assert.rejects(
    () => engine.ensureOmpStarted(),
    /omp project core exited while bootstrapping session channel/,
  );
  // 重试：经 acquireProjectProcess（真实拓扑中即 gateway.acquireSessionChannel）重建。
  await engine.ensureOmpStarted();
  // 引擎此刻持有的通道是重建后的活通道：命令目录经它成功取回。
  const commands = await engine.loadSkillCommands();
  assert.deepEqual(commands, [{ name: "help" }]);
  assert.equal(dead.disposeCalls, 1, "死通道已被回收，不会随引擎继续存活");
});
