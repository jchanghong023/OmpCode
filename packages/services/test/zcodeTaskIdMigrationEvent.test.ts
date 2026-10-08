import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  resolveWorkspaceKey,
  zcodeWorkspaceTaskListChangedSchema,
  type SessionsIndexTopicWireCandidate,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "../src/zcode-agent/zcodeAgent.js";

const fromTaskId = "omp-session-temp";
const toTaskId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
const turn = () => new Promise<void>((done) => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext, workspaceIdentity?: string, withLifecycle = false) {
  const root = await mkdtemp(join(tmpdir(), "task-migration-event-"));
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  const target = { workspacePath: join(root, "workspace"), workspaceIdentity };
  const workspaceKey = resolveWorkspaceKey(target);
  let handler: ((wire: SessionsIndexTopicWireCandidate) => void) | undefined;
  let restart: ((event: { workspaceKey: string }) => void) | undefined;
  let lifecycle: ((event: ZCodeAgentRuntimeLifecycleEvent) => void) | undefined;
  let subscription = 0;
  const service = {
    async subscribeSessionsIndexV4() {
      return {
        ack: { subscriptionId: `index-${++subscription}`, mode: "snapshot", logEpoch: "epoch" },
      };
    },
    async unsubscribeSessionsIndexV4() {},
    onDynamicSessionsIndexFrame() {
      return (listener: typeof handler) => {
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
    onAgentRuntimeRestarted(listener: typeof restart) {
      restart = listener;
      return { dispose() {} };
    },
    onAgentRuntimeLifecycle: withLifecycle
      ? (listener: typeof lifecycle) => {
          lifecycle = listener;
          return { dispose() {} };
        }
      : undefined,
    async readSession() {
      throw new Error("No runtime is started by the migration test");
    },
  } as unknown as IZCodeAgentService;
  const syncer = createZCodeTaskIndexSyncer({ agentService: service, taskIndexRepo: repo });
  t.after(async () => {
    syncer.disposeAll();
    repo.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("task-migration-event-"));
    await rm(root, { recursive: true, force: true });
  });
  const events: ZCodeWorkspaceTaskListChanged[] = [];
  syncer.onDynamicWorkspaceEvent(target)((event: ZCodeWorkspaceEvent) => {
    if (event.type === "workspace_task_list_changed")
      events.push(zcodeWorkspaceTaskListChangedSchema.parse(event));
  });
  await repo.syncTaskMeta({
    meta: {
      ...target,
      taskId: fromTaskId,
      traceId: "trace",
      title: "task",
      createdAt: 1,
      updatedAt: 1,
      mode: "build",
      provider: "glm",
    },
  });
  const runtimeEvent = (state: "available" | "unavailable"): ZCodeAgentRuntimeLifecycleEvent => ({
    ...target,
    workspaceKey,
    state,
    runtimeIdentity: { generation: 1, identity: "isolated-test", workspaceKey },
  });
  if (withLifecycle) {
    assert.ok(lifecycle);
    lifecycle(runtimeEvent("available"));
  }
  syncer.ensureWorkspaceSubscription(target);
  await turn();
  const summary = (sessionId: string) => ({
    sessionId,
    workspaceId: "workspace",
    title: "task",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    createdAt: 1,
    lastActivityAt: 1,
  });
  const deliver = (fromSeq: number, toSeq: number, payload: unknown) => {
    const topic = `sessions-index/${workspaceKey}`;
    assert.ok(handler);
    handler({
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "online",
      logicalFrameId: `frame-${toSeq}`,
      logicalFrameOrdinal: toSeq,
      topic,
      subscriptionId: `index-${subscription}`,
      frame: {
        topic,
        subscriptionId: `index-${subscription}`,
        fromSeq,
        toSeq,
        sentAt: Date.now(),
        payload,
      },
    } as SessionsIndexTopicWireCandidate);
  };
  deliver(0, 1, {
    kind: "snapshot",
    snapshot: {
      protocolVersion: 1,
      workspaceId: "workspace",
      logEpoch: "epoch",
      sessions: [summary(fromTaskId)],
    },
  });
  await turn();
  await turn();
  const migrate = () =>
    deliver(1, 2, {
      kind: "deltas",
      deltas: [
        { op: "session.removed", sessionId: fromTaskId },
        { op: "session.upserted", session: summary(toTaskId) },
      ],
    });
  return {
    repo,
    target,
    syncer,
    events,
    migrate,
    restart: () => {
      assert.ok(restart);
      restart({ workspaceKey });
    },
    unavailable: () => {
      assert.ok(lifecycle);
      lifecycle(runtimeEvent("unavailable"));
    },
  };
}

test("committed SQLite migration publishes stable task/meta and replays to a late workspace listener", async (t) => {
  const f = await fixture(t);
  const committed = new Promise<ZCodeWorkspaceTaskListChanged>((done) =>
    f.syncer.onDynamicWorkspaceEvent(f.target)((event) => {
      if (event.type === "workspace_task_list_changed" && event.taskIdMigration) done(event);
    }),
  );
  f.migrate();
  const event = await committed;
  assert.deepEqual(event.taskIdMigration, { fromTaskId, toTaskId });
  assert.equal(event.taskId, toTaskId);
  assert.equal(event.taskMeta?.taskId, toTaskId);
  assert.equal(await f.repo.getTaskMeta({ ...f.target, taskId: fromTaskId }), null);
  assert.ok(await f.repo.getTaskMeta({ ...f.target, taskId: toTaskId }));
  f.migrate(); // 已应用水位的重复帧不得再次提交或重复广播。
  await turn();
  assert.equal(f.events.filter((item) => item.taskIdMigration).length, 1);
  const replay: ZCodeWorkspaceEvent[] = [];
  f.syncer.onDynamicWorkspaceEvent(f.target)((item) => replay.push(item));
  assert.equal(
    replay.filter((item) => item.type === "workspace_task_list_changed" && item.taskIdMigration)
      .length,
    1,
  );
});

test("failed SQLite rekey never publishes a successful identity migration", async (t) => {
  const f = await fixture(t);
  const finished = deferred();
  t.mock.method(f.repo, "rekeyTaskId", async () => {
    finished.resolve();
    throw new Error("Synthetic rekey failure");
  });
  f.migrate();
  await finished.promise;
  await turn();
  assert.equal(f.events.filter((item) => item.taskIdMigration).length, 0);
  assert.ok(await f.repo.getTaskMeta({ ...f.target, taskId: fromTaskId }));
});

for (const boundary of ["restart", "dispose", "unavailable"] as const) {
  test(`late SQLite completion after ${boundary} rejects the old generation migration event`, async (t) => {
    const f = await fixture(t, undefined, boundary === "unavailable");
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    const rekey = f.repo.rekeyTaskId.bind(f.repo);
    t.mock.method(f.repo, "rekeyTaskId", async (params: Parameters<typeof rekey>[0]) => {
      started.resolve();
      await release.promise;
      const meta = await rekey(params);
      finished.resolve();
      return meta;
    });
    f.migrate();
    await started.promise;
    if (boundary === "restart") f.restart();
    else if (boundary === "unavailable") f.unavailable();
    else f.syncer.disposeAll();
    release.resolve();
    await finished.promise;
    await turn();
    assert.equal(f.events.filter((item) => item.taskIdMigration).length, 0);
  });
}

test("same path remote identity subscriptions cannot receive another workspace migration", async (t) => {
  const f = await fixture(t, "remote-a");
  const otherEvents: ZCodeWorkspaceEvent[] = [];
  f.syncer.onDynamicWorkspaceEvent({ ...f.target, workspaceIdentity: "remote-b" })((item) =>
    otherEvents.push(item),
  );
  const done = new Promise<void>((resolve) =>
    f.syncer.onDynamicWorkspaceEvent(f.target)((event) => {
      if (event.type === "workspace_task_list_changed" && event.taskIdMigration) resolve();
    }),
  );
  f.migrate();
  await done;
  assert.equal(otherEvents.length, 0);
  assert.equal(f.events.find((event) => event.taskIdMigration)?.workspaceIdentity, "remote-a");
});
