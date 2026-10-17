import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  createZCodeTaskIndexSyncer,
  type ZCodeTaskIndexSyncer,
} from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "../src/zcode-agent/zcodeAgent.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import {
  resolveWorkspaceKey,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  zcodeWorkspaceTaskListChangedSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeTaskMeta,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type { SessionsIndexTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";

/**
 * 修复回归（评审 P3）：applySessionsIndexFrame 原实现对任何 session.upserted 都先
 * 无条件清空 pendingRekeyFrom，UUID 形状判断在其后；中途到达的非匹配 upserted 会
 * 无谓丢弃 rekey 候选，temp 任务行不随迁、被下轮快照对账整行标 deleted。
 * 本测试验证：removed(temp) 与 upserted(uuid) 之间插入其他会话的 upserted 时，
 * pending 不被误清，uuid 到达后 rekey 仍成功建立。
 */

type WireHandler = (wire: SessionsIndexTopicWireCandidate) => void;

function wireFrame(
  topic: string,
  subscriptionId: string,
  fromSeq: number,
  toSeq: number,
  payload: Record<string, unknown>,
): SessionsIndexTopicWireCandidate {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "online",
    logicalFrameId: `frame-${toSeq}`,
    logicalFrameOrdinal: toSeq,
    topic,
    subscriptionId,
    frame: { topic, subscriptionId, fromSeq, toSeq, sentAt: Date.now(), payload },
  } as unknown as SessionsIndexTopicWireCandidate;
}

function summary(input: {
  sessionId: string;
  phase: "completedSuccess" | "running";
  title?: string;
}) {
  return {
    sessionId: input.sessionId,
    workspaceId: "ws",
    title: input.title ?? `任务 ${input.sessionId}`,
    phase: input.phase,
    sessionEnded: input.phase !== "running",
    hasBackgroundWork: false,
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("omp 临时会话 rekey：中间插入的非匹配 upserted 不丢弃 rekey 候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-rekey-delta-"));
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const workspacePath = join(root, "workspace");
  const tempId = "omp-session-temp";
  const otherTempId = "omp-session-other";
  const uuidId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  const topic = `sessions-index/${workspacePath}`;
  const subscriptionId = "sub-1";

  const indexHandlers: WireHandler[] = [];
  const agentService = {
    async subscribeSessionsIndexV4() {
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch-1" } };
    },
    async unsubscribeSessionsIndexV4() {},
    onDynamicSessionsIndexFrame() {
      return (handler: WireHandler) => {
        indexHandlers.push(handler);
        return { dispose: () => {} };
      };
    },
    async subscribeWorkspaceConfigV4() {
      return { ack: { subscriptionId: "cfg-1", mode: "snapshot", logEpoch: "epoch-1" } };
    },
    async unsubscribeWorkspaceConfigV4() {},
    onDynamicWorkspaceConfigFrame() {
      return () => ({ dispose: () => {} });
    },
    async readSession() {
      throw new Error("existing-only 回源在测试中不应被真实满足");
    },
  } as unknown as IZCodeAgentService;

  let syncer: ZCodeTaskIndexSyncer | null = null;
  try {
    syncer = createZCodeTaskIndexSyncer({ agentService, taskIndexRepo: repo });
    const seeded = deferred();
    const migrationCommitted = deferred();
    syncer.onDynamicWorkspaceEvent({ workspacePath })((event) => {
      if (event.type !== "workspace_task_list_changed") return;
      if (event.reason === "task_meta_changed" && event.taskId === undefined) seeded.resolve();
      if (
        event.taskIdMigration?.fromTaskId === tempId &&
        event.taskIdMigration.toTaskId === uuidId
      ) {
        migrationCommitted.resolve();
      }
    });
    syncer.ensureWorkspaceSubscription({ workspacePath });
    assert.equal(indexHandlers.length, 1, "sessions-index 帧监听应已安装");
    const deliver = (fromSeq: number, toSeq: number, payload: Record<string, unknown>) =>
      indexHandlers[0](wireFrame(topic, subscriptionId, fromSeq, toSeq, payload));

    // 1) initial snapshot：temp 终态会话进入基线并静默补行。
    deliver(0, 1, {
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "ws",
        logEpoch: "epoch-1",
        sessions: [summary({ sessionId: tempId, phase: "completedSuccess" })],
      },
    });
    await seeded.promise;
    assert.ok(
      await repo.getTaskMeta({ workspacePath, taskId: tempId }),
      "基线 seed 应为 temp 会话建立 task 行",
    );

    // 2) temp removed：进入 rekey 挂起态。
    deliver(1, 2, { kind: "deltas", deltas: [{ op: "session.removed", sessionId: tempId }] });

    // 3) 中途插入其他会话的非匹配 upserted（修复前会在此清空 pending）。
    deliver(2, 3, {
      kind: "deltas",
      deltas: [
        { op: "session.upserted", session: summary({ sessionId: otherTempId, phase: "running" }) },
      ],
    });

    // 4) uuid upserted：rekey 应照常发生，temp 行迁移到 uuid 且产品壳状态随迁。
    deliver(3, 4, {
      kind: "deltas",
      deltas: [
        {
          op: "session.upserted",
          session: summary({
            sessionId: uuidId,
            phase: "completedSuccess",
            title: "任务 omp-session-temp",
          }),
        },
      ],
    });
    await migrationCommitted.promise;

    assert.equal(
      await repo.getTaskMeta({ workspacePath, taskId: tempId }),
      null,
      "rekey 后旧 temp 行应已迁移",
    );
    const migrated = await repo.getTaskMeta({ workspacePath, taskId: uuidId });
    assert.ok(migrated, "rekey 后 uuid 行应存在");
    assert.equal(migrated.taskId, uuidId);
  } finally {
    syncer?.disposeAll();
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nativeTempId = "omp-session-native-first";
const nativeUuidId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";

async function nativeFirstFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-native-rekey-"));
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const target = { workspacePath: join(root, "workspace"), workspaceIdentity: "remote-a" };
  const workspaceKey = resolveWorkspaceKey(target);
  const subscribed = deferred();
  const terminalRead = deferred();
  const rekeyed = deferred<ZCodeTaskMeta | null>();
  let handler: WireHandler | undefined;
  let lifecycle: ((event: ZCodeAgentRuntimeLifecycleEvent) => void) | undefined;
  let subscription = 0;
  const agentService = {
    async subscribeSessionsIndexV4() {
      subscribed.resolve();
      return {
        ack: { subscriptionId: `index-${++subscription}`, mode: "snapshot", logEpoch: "epoch" },
      };
    },
    async unsubscribeSessionsIndexV4() {},
    onDynamicSessionsIndexFrame() {
      return (listener: WireHandler) => {
        handler = listener;
        return { dispose() {} };
      };
    },
    async subscribeWorkspaceConfigV4() {
      return { ack: { subscriptionId: "config", mode: "snapshot", logEpoch: "epoch" } };
    },
    async unsubscribeWorkspaceConfigV4() {},
    onDynamicWorkspaceConfigFrame() {
      return () => ({ dispose() {} });
    },
    onAgentRuntimeLifecycle(listener: typeof lifecycle) {
      lifecycle = listener;
      return { dispose() {} };
    },
    async readSession(params: { sessionId: string }) {
      if (params.sessionId === nativeTempId) terminalRead.resolve();
      throw new Error("The fixture does not start or hydrate an agent runtime");
    },
    async resumeSession() {
      return snapshot(nativeTempId);
    },
    disposeAll() {},
  } as unknown as IZCodeAgentService;
  const syncer = createZCodeTaskIndexSyncer({ agentService, taskIndexRepo: repo });
  const events: ZCodeWorkspaceTaskListChanged[] = [];
  syncer.onDynamicWorkspaceEvent(target)((event) => {
    if (event.type === "workspace_task_list_changed") {
      events.push(zcodeWorkspaceTaskListChangedSchema.parse(event));
    }
  });
  t.after(async () => {
    syncer.disposeAll();
    repo.close();
    await rm(root, { recursive: true, force: true });
  });
  const realRekey = repo.rekeyTaskId.bind(repo);
  t.mock.method(repo, "rekeyTaskId", async (params: Parameters<typeof realRekey>[0]) => {
    const result = await realRekey(params);
    rekeyed.resolve(result);
    return result;
  });
  function runtime(state: "available" | "unavailable", generation = 1) {
    assert.ok(lifecycle);
    lifecycle({
      ...target,
      workspaceKey,
      state,
      runtimeIdentity: { generation, identity: `native-test-${generation}`, workspaceKey },
    });
  }
  function snapshot(sessionId: string, updatedAt = 2): ZCodeSessionStateSnapshot {
    return zcodeSessionStateSnapshotSchema.parse({
      protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
      session: {
        sessionId,
        workspace: { ...target, workspaceKey },
        sessionKind: "interactive",
        title: "/goal show",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt,
      },
      settings: {
        model: { available: [] },
        thoughtLevel: { enabled: false, available: [] },
        mode: { current: "build" },
      },
      projection: {
        sessionId,
        status: "idle",
        mode: "build",
        turnCount: 0,
        totalTokenCount: 0,
        contextUsed: 0,
        contextWindow: 200000,
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
      },
      runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
      messages: [
        {
          info: {
            messageId: "native-input",
            sessionId,
            role: "user",
            time: { created: 1 },
            agent: "build",
          },
          parts: [
            {
              partId: "native-input-text",
              messageId: "native-input",
              sessionId,
              type: "text",
              text: "/goal show",
            },
          ],
        },
      ],
    });
  }
  let seq = 0;
  function deliver(payload: Record<string, unknown>) {
    assert.ok(handler);
    handler(
      wireFrame(`sessions-index/${workspaceKey}`, `index-${subscription}`, seq, ++seq, payload),
    );
  }
  async function terminal(waitForRead = true) {
    deliver({
      kind: "deltas",
      deltas: [
        {
          op: "session.upserted",
          session: summary({
            sessionId: nativeTempId,
            phase: "completedSuccess",
            title: "/goal show",
          }),
        },
      ],
    });
    if (waitForRead) await terminalRead.promise;
  }
  function migrate() {
    deliver({
      kind: "deltas",
      deltas: [
        { op: "session.removed", sessionId: nativeTempId },
        {
          op: "session.upserted",
          session: summary({
            sessionId: nativeUuidId,
            phase: "completedSuccess",
            title: "/goal show",
          }),
        },
      ],
    });
    return rekeyed.promise;
  }
  async function assertOnlyCanonical() {
    assert.equal(await repo.getTaskMeta({ ...target, taskId: nativeTempId }), null);
    const list = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: [target],
      sortBy: "updated",
    });
    assert.deepEqual(
      list.items.map((item) => item.taskId),
      [nativeUuidId],
    );
    const grouped = await repo.queryGroupedTaskView({ workspaceScopes: [target] });
    assert.deepEqual(
      grouped.nodes.flatMap((node) =>
        node.type === "group" ? node.tasks.map((task) => task.taskId) : [node.task.taskId],
      ),
      [nativeUuidId],
    );
  }
  runtime("available");
  await subscribed.promise;
  deliver({
    kind: "snapshot",
    snapshot: {
      protocolVersion: 1,
      workspaceId: "ws",
      logEpoch: "epoch",
      sessions: [
        {
          ...summary({ sessionId: nativeTempId, phase: "running", title: "/goal show" }),
          phase: "draft",
          sessionEnded: false,
        },
      ],
    },
  });
  return {
    repo,
    databasePath: join(root, "tasks.sqlite"),
    target,
    syncer,
    agentService,
    events,
    deliver,
    snapshot,
    terminal,
    migrate,
    runtime,
    assertOnlyCanonical,
  };
}

for (const targetExists of [false, true]) {
  test(`native-first owned alias persists when UUID commits ${targetExists ? "before" : "after"} identity`, async (t) => {
    const f = await nativeFirstFixture(t);
    if (targetExists) {
      await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
        broadcastReason: "task_created",
      });
    }
    await f.terminal();
    const rekeyResult = await f.migrate();
    assert.equal(rekeyResult?.taskIdMigration, undefined);
    const canonical = await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
      broadcastReason: "task_created",
    });
    const migration = { fromTaskId: nativeTempId, toTaskId: nativeUuidId };
    assert.equal(canonical.taskId, nativeUuidId);
    assert.deepEqual(canonical.taskIdMigration, migration);
    const afterIdentity = f.events.length;
    const late = await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeTempId, 3), {
      broadcastReason: "task_status_changed",
    });
    assert.equal(late.taskId, nativeUuidId);
    assert.deepEqual(late.taskIdMigration, migration);
    await f.assertOnlyCanonical();
    const lateEvents = f.events.slice(afterIdentity);
    assert.ok(lateEvents.length > 0, "the late snapshot must reach consumers under the UUID");
    assert.ok(
      lateEvents.every(
        (event) => event.taskId === nativeUuidId && event.taskMeta?.taskId === nativeUuidId,
      ),
    );
    assert.equal(
      f.events.filter((event) => event.taskIdMigration).length,
      1,
      "one committed owned identity produces one live migration",
    );
    assert.deepEqual(
      f.events.find((event) => event.taskIdMigration)?.taskMeta?.taskIdMigration,
      migration,
    );
    const replay: ZCodeWorkspaceTaskListChanged[] = [];
    f.syncer.onDynamicWorkspaceEvent(f.target)((event) => {
      if (event.type === "workspace_task_list_changed")
        replay.push(zcodeWorkspaceTaskListChangedSchema.parse(event));
    });
    assert.deepEqual(
      replay.map((event) => event.taskIdMigration),
      [migration],
    );
    f.repo.close();
    assert.deepEqual(
      (await f.repo.getTaskMeta({ ...f.target, taskId: nativeUuidId }))?.taskIdMigration,
      migration,
    );
    const coldList = await f.repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: [f.target],
      sortBy: "updated",
    });
    assert.deepEqual(
      coldList.items.map((item) => item.taskIdMigration),
      [migration],
    );
    const coldGrouped = await f.repo.queryGroupedTaskView({ workspaceScopes: [f.target] });
    assert.deepEqual(
      coldGrouped.nodes.flatMap((node) =>
        node.type === "group"
          ? node.tasks.map((task) => task.taskIdMigration)
          : [node.task.taskIdMigration],
      ),
      [migration],
    );
    await f.assertOnlyCanonical();
  });
}

for (const grouped of [false, true]) {
  for (const pauseAfterCommit of [false, true]) {
    test(`snapshot persistence crossing native identity change returns and broadcasts only UUID (grouped: ${grouped}, committed: ${pauseAfterCommit})`, async (t) => {
      const f = await nativeFirstFixture(t);
      await f.terminal();
      const entered = deferred();
      const release = deferred();
      let paused = false;
      if (grouped) {
        const persist = f.repo.syncTaskMetaAtGroupedTop.bind(f.repo);
        t.mock.method(
          f.repo,
          "syncTaskMetaAtGroupedTop",
          async (params: Parameters<typeof persist>[0]) => {
            if (params.meta.taskId !== nativeTempId || paused) return persist(params);
            paused = true;
            const committed = pauseAfterCommit ? await persist(params) : undefined;
            entered.resolve();
            await release.promise;
            return committed ?? persist(params);
          },
        );
      } else {
        const persist = f.repo.syncTaskMeta.bind(f.repo);
        t.mock.method(f.repo, "syncTaskMeta", async (params: Parameters<typeof persist>[0]) => {
          if (params.meta.taskId !== nativeTempId || paused) return persist(params);
          paused = true;
          const committed = pauseAfterCommit ? await persist(params) : undefined;
          entered.resolve();
          await release.promise;
          return committed ?? persist(params);
        });
      }
      const pending = f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeTempId, 3), {
        broadcastReason: "task_status_changed",
        moveGroupedTaskToTop: grouped,
      });
      await entered.promise;
      try {
        const initialMigration = await f.migrate();
        assert.deepEqual(
          initialMigration?.taskIdMigration,
          pauseAfterCommit ? { fromTaskId: nativeTempId, toTaskId: nativeUuidId } : undefined,
        );
        await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId, 4), {
          broadcastReason: "task_created",
        });
      } finally {
        release.resolve();
      }
      const afterIdentity = f.events.length;
      const persisted = await pending;
      assert.equal(persisted.taskId, nativeUuidId);
      await f.assertOnlyCanonical();
      const lateEvents = f.events.slice(afterIdentity);
      assert.ok(
        lateEvents.some(
          (event) => event.reason === (grouped ? "task_created" : "task_status_changed"),
        ),
      );
      assert.ok(
        lateEvents.every(
          (event) => event.taskId === nativeUuidId && event.taskMeta?.taskId === nativeUuidId,
        ),
      );
      assert.equal(
        f.events.filter((event) => event.taskIdMigration).length,
        1,
        "one persisted owned identity publishes its migration once",
      );
      for (const event of f.events.filter((item) => item.taskIdMigration)) {
        assert.deepEqual(event.taskIdMigration, {
          fromTaskId: nativeTempId,
          toTaskId: nativeUuidId,
        });
        assert.equal(event.taskId, nativeUuidId);
        assert.equal(event.taskMeta?.taskId, nativeUuidId);
        assert.deepEqual(
          (await f.repo.getTaskMeta({ ...f.target, taskId: nativeUuidId }))?.taskIdMigration,
          event.taskIdMigration,
        );
      }
    });
  }
}

test("adapter history snapshot read cannot resurrect the removed temp identity", async (t) => {
  const f = await nativeFirstFixture(t);
  await f.terminal();
  await f.migrate();
  await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
    broadcastReason: "task_created",
  });
  const otherTarget = { ...f.target, workspaceIdentity: "remote-b" };
  const otherEvents: ZCodeWorkspaceTaskListChanged[] = [];
  f.syncer.onDynamicWorkspaceEvent(otherTarget)((event) => {
    if (event.type === "workspace_task_list_changed") otherEvents.push(event);
  });
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: f.agentService,
    taskIndexRepo: f.repo,
    taskIndexSyncer: f.syncer,
  });
  try {
    const afterIdentity = f.events.length;
    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      const snapshot = await service.getTaskSnapshot({
        ...f.target,
        taskId: nativeTempId,
        clientMode,
      });
      assert.ok(snapshot);
      assert.equal(snapshot.meta.taskId, nativeUuidId);
      assert.equal(snapshot.meta.title, "/goal show");
      assert.deepEqual(snapshot.meta.taskIdMigration, {
        fromTaskId: nativeTempId,
        toTaskId: nativeUuidId,
      });
      assert.deepEqual(
        snapshot.messages.map(({ role, content }) => ({ role, content })),
        [{ role: "user", content: "/goal show" }],
      );
    }
    await f.assertOnlyCanonical();
    assert.ok(f.events.slice(afterIdentity).every((event) => event.taskId === nativeUuidId));
    assert.equal(otherEvents.length, 0);
    const otherSnapshot = f.snapshot(nativeTempId);
    otherSnapshot.session.workspace = {
      ...otherTarget,
      workspaceKey: resolveWorkspaceKey(otherTarget),
    };
    const unrelated = await f.syncer.syncSnapshotAndBroadcast(otherSnapshot, {
      broadcastReason: "task_status_changed",
    });
    assert.equal(unrelated.taskId, nativeTempId, "aliases cannot cross remote workspace identity");
    assert.ok(await f.repo.getTaskMeta({ ...otherTarget, taskId: nativeTempId }));
    assert.equal(await f.repo.getTaskMeta({ ...otherTarget, taskId: nativeUuidId }), null);
    assert.equal(unrelated.taskIdMigration, undefined);
    await f.assertOnlyCanonical();
    assert.equal(otherEvents.at(-1)?.taskId, nativeTempId);
  } finally {
    f.syncer.disposeAll();
  }
});

for (const boundary of ["unavailable", "replaced", "dispose"] as const) {
  test(`old runtime read completing after ${boundary} cannot create or broadcast a task`, async (t) => {
    const f = await nativeFirstFixture(t);
    const started = deferred();
    const release = deferred();
    t.mock.method(f.agentService, "readSession", async () => {
      started.resolve();
      await release.promise;
      return f.snapshot(nativeTempId);
    });
    await f.terminal(false);
    await started.promise;
    const beforeBoundary = f.events.length;
    if (boundary === "dispose") f.syncer.disposeAll();
    else {
      f.runtime("unavailable");
      if (boundary === "replaced") f.runtime("available", 2);
    }
    release.resolve();
    // Drain the released read's promise continuations, not a wall-clock retry.
    await tick();
    assert.deepEqual(await f.repo.listTaskMetas({ ...f.target, provider: "glm" }), []);
    assert.deepEqual(f.events.slice(beforeBoundary), []);
  });

  test(`snapshot write completing after ${boundary} rejects stale ownership without broadcasting`, async (t) => {
    const f = await nativeFirstFixture(t);
    await f.terminal();
    await f.migrate();
    await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
      broadcastReason: "task_created",
    });
    const started = deferred();
    const release = deferred();
    const persist = f.repo.syncTaskMeta.bind(f.repo);
    t.mock.method(f.repo, "syncTaskMeta", async (params: Parameters<typeof persist>[0]) => {
      const meta = await persist(params);
      started.resolve();
      await release.promise;
      return meta;
    });
    const pending = f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeTempId, 3), {
      broadcastReason: "task_status_changed",
    });
    const rejected = assert.rejects(pending, Error);
    await started.promise;
    const beforeBoundary = f.events.length;
    if (boundary === "dispose") f.syncer.disposeAll();
    else {
      f.runtime("unavailable");
      if (boundary === "replaced") f.runtime("available", 2);
    }
    release.resolve();
    await rejected;
    await f.assertOnlyCanonical();
    assert.deepEqual(f.events.slice(beforeBoundary), []);
    assert.equal(f.events.filter((event) => event.taskIdMigration).length, 1);
  });
}

for (const removed of ["unknown", "draft"] as const) {
  test(`UUID commits without migration when the removed temp is ${removed}, not an owned terminal`, async (t) => {
    const f = await nativeFirstFixture(t);
    f.deliver({
      kind: "deltas",
      deltas: [
        {
          op: "session.removed",
          sessionId: removed === "unknown" ? "omp-session-unowned" : nativeTempId,
        },
        {
          op: "session.upserted",
          session: summary({
            sessionId: nativeUuidId,
            phase: "completedSuccess",
            title: "/goal show",
          }),
        },
      ],
    });
    const meta = await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
      broadcastReason: "task_created",
    });
    assert.equal(meta.taskIdMigration, undefined);
    assert.ok(f.events.every((event) => event.taskIdMigration === undefined));
    f.repo.close();
    assert.equal(
      (await f.repo.getTaskMeta({ ...f.target, taskId: nativeUuidId }))?.taskIdMigration,
      undefined,
    );
  });
}

for (const pairedBeforeRestart of [false, true]) {
  test(`uncommitted owned identity cannot cross a runtime/subscription generation (paired: ${pairedBeforeRestart})`, async (t) => {
    const f = await nativeFirstFixture(t);
    await f.terminal();
    if (pairedBeforeRestart) await f.migrate();
    else {
      f.deliver({
        kind: "deltas",
        deltas: [{ op: "session.removed", sessionId: nativeTempId }],
      });
    }
    assert.equal(await f.repo.getTaskMeta({ ...f.target, taskId: nativeUuidId }), null);
    f.runtime("unavailable");
    f.runtime("available", 2);
    await tick();
    f.deliver({
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        workspaceId: "ws",
        logEpoch: "epoch-2",
        sessions: [],
      },
    });
    f.deliver({
      kind: "deltas",
      deltas: [
        {
          op: "session.upserted",
          session: summary({ sessionId: nativeUuidId, phase: "completedSuccess" }),
        },
      ],
    });
    const meta = await f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
      broadcastReason: "task_created",
    });
    assert.equal(meta.taskIdMigration, undefined);
    assert.ok(f.events.every((event) => event.taskIdMigration === undefined));
    const replay: ZCodeWorkspaceTaskListChanged[] = [];
    f.syncer.onDynamicWorkspaceEvent(f.target)((event) => {
      if (event.type === "workspace_task_list_changed") replay.push(event);
    });
    assert.ok(replay.every((event) => event.taskIdMigration === undefined));
  });
}

test("failed owned alias transaction cannot publish or replay migration", async (t) => {
  const f = await nativeFirstFixture(t);
  await f.terminal();
  await f.migrate();
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec(`
      CREATE TRIGGER fail_owned_alias BEFORE UPDATE OF meta_json ON tasks
      WHEN json_extract(NEW.meta_json, '$.taskIdMigration') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'owned alias commit rejected'); END;
    `);
    await assert.rejects(
      f.syncer.syncSnapshotAndBroadcast(f.snapshot(nativeUuidId), {
        broadcastReason: "task_created",
      }),
      /owned alias commit rejected/,
    );
  } finally {
    db.close();
  }
  assert.equal(
    (await f.repo.getTaskMeta({ ...f.target, taskId: nativeUuidId }))?.taskIdMigration,
    undefined,
  );
  assert.ok(f.events.every((event) => event.taskIdMigration === undefined));
  const replay: ZCodeWorkspaceTaskListChanged[] = [];
  f.syncer.onDynamicWorkspaceEvent(f.target)((event) => {
    if (event.type === "workspace_task_list_changed") replay.push(event);
  });
  assert.ok(replay.every((event) => event.taskIdMigration === undefined));
  await f.assertOnlyCanonical();
});
