import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { IZCodeAgentService } from "@zcode/services";
import {
  clientHelloSchema,
  conversationSnapshotSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  type ConversationResyncParams,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type TopicFrameDeliveryKind,
  type TopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { createAgentConversationTransport } from "../src/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";

const topic = "conversation/budget-session";
const workspaceKey = "budget-workspace";
const timeoutMs = PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function snapshot(seq = 10): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "budget-session",
    logEpoch: "budget-epoch",
    seq,
    revision: seq,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, { allowed: true }]),
    ),
    inputRouting: { mode: "startNow" },
    meta: { title: "wire recovery baseline ".repeat(200), titleSource: "custom" },
    config: { provider: "test", model: "test", thought: "", followupMode: "queue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
}

// 只替换 Host RPC/event 边界；真实 transport、ACK barrier、wire codec/assembler 与 store 均参与。
// Host 不自动回显任何帧：每个成功、损坏、缺片与迟到帧由场景独立发布。
function fixture(t: TestContext, clientMode: HelloMessage["clientMode"]) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let wireListener: ((wire: ConversationTopicWireCandidate) => void) | undefined;
  let lifecycleListener:
    | Parameters<NonNullable<IZCodeAgentService["onAgentRuntimeLifecycle"]>>[0]
    | undefined;
  const restartListeners = new Set<Parameters<IZCodeAgentService["onAgentRuntimeRestarted"]>[0]>();
  let runtimeGeneration = 0;
  let mode: "snapshot" | "resume" = "snapshot";
  let subscribeBarrier: Promise<void> | null = null;
  let releaseSubscribe: (() => void) | undefined;
  const subscriptions: string[] = [];
  const subscribeBases: Array<{ logEpoch: string; seq: number } | undefined> = [];
  const resyncs: ConversationResyncParams[] = [];
  const unsubscriptions: string[] = [];
  const ordinals = new Map<string, number>();
  const port: Partial<IZCodeAgentService> = {
    async helloConversationV4() {
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: "budget-connection",
        clientMode,
        deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      };
    },
    async initializeConversationV4(hello) {
      assert.equal(
        clientHelloSchema.parse(hello).clientKind,
        clientMode === "desktop-continuous" ? "desktop" : "web",
      );
    },
    async subscribeConversationV4(params) {
      subscribeBases.push(params.base);
      const id = `budget-sub-${subscriptions.length + 1}`;
      subscriptions.push(id);
      const pending = subscribeBarrier;
      subscribeBarrier = null;
      if (pending) await pending;
      return {
        ack: {
          subscriptionId: id,
          mode: params.base ? mode : "snapshot",
          logEpoch: "budget-epoch",
        },
      };
    },
    async resyncConversationV4(params) {
      resyncs.push(params);
      return {
        ack: { subscriptionId: params.subscriptionId, mode: "snapshot", logEpoch: "budget-epoch" },
      };
    },
    async unsubscribeConversationV4(params) {
      unsubscriptions.push(params.subscriptionId);
    },
    onDynamicConversationFrame: () => (listener) => {
      wireListener = listener;
      return {
        dispose() {
          wireListener = undefined;
        },
      };
    },
    onAgentRuntimeRestarted(listener) {
      restartListeners.add(listener);
      return {
        dispose() {
          restartListeners.delete(listener);
        },
      };
    },
    onAgentRuntimeLifecycle(listener) {
      lifecycleListener = listener;
      return {
        dispose() {
          lifecycleListener = undefined;
        },
      };
    },
  };
  const transport = createAgentConversationTransport(port as IZCodeAgentService, {
    workspacePath: "/budget-workspace",
    workspaceIdentity: workspaceKey,
  });
  const store = new ConversationProjectionStore(topic, transport);
  const offFrame = transport.onFrame((frame, delivery) => store.handleFrame(frame, delivery));
  t.after(async () => {
    await store.close();
    offFrame();
  });

  function encode(frame: ConversationTopicFrame, deliveryKind: TopicFrameDeliveryKind) {
    const ordinal = (ordinals.get(frame.subscriptionId) ?? 0) + 1;
    ordinals.set(frame.subscriptionId, ordinal);
    return encodeTopicWireFrames(frame, {
      topic,
      subscriptionId: frame.subscriptionId,
      deliveryKind,
      logicalFrameOrdinal: ordinal,
      logicalFrameId: `${frame.subscriptionId}-${ordinal}`,
      maxPhysicalFrameBytes: 768,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
  }
  function snapshotFrame(subscriptionId: string, seq = 10): ConversationTopicFrame {
    return {
      topic,
      subscriptionId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot: snapshot(seq) },
    };
  }
  function publish(wires: TopicWireFrame<ConversationTopicFrame>[]) {
    for (const wire of wires) wireListener?.(wire);
  }
  function base(
    delivery: TopicFrameDeliveryKind = "initial",
    subscriptionId = store.getState().subscriptionId!,
    seq = 10,
  ) {
    publish(encode(snapshotFrame(subscriptionId, seq), delivery));
  }
  function broken(delivery: TopicFrameDeliveryKind) {
    const wires = encode(snapshotFrame(store.getState().subscriptionId!), delivery);
    assert.ok(wires.length > 1, "the regression must exercise physical fragment assembly");
    publish(
      wires.map((wire) => {
        assert.equal(wire.kind, "fragment");
        if (wire.kind !== "fragment") throw new Error("expected fragments");
        return {
          ...wire,
          checksum: {
            algorithm: "crc32" as const,
            value: wire.checksum.value === "00000000" ? "11111111" : "00000000",
          },
        };
      }),
    );
  }
  async function failedRound(kind: "corrupt" | "timeout" | "partial" = "corrupt") {
    if (kind === "partial")
      publish(encode(snapshotFrame(store.getState().subscriptionId!), "initial").slice(0, 1));
    if (kind === "corrupt") broken("initial");
    else t.mock.timers.tick(timeoutMs);
    await flush();
    if (kind === "partial")
      publish(encode(snapshotFrame(store.getState().subscriptionId!), "recovery").slice(0, 1));
    if (kind === "corrupt") broken("recovery");
    else t.mock.timers.tick(timeoutMs);
    await flush();
  }
  return {
    store,
    subscriptions,
    subscribeBases,
    resyncs,
    unsubscriptions,
    base,
    broken,
    failedRound,
    encode,
    publish,
    snapshotFrame,
    holdSubscribe() {
      subscribeBarrier = new Promise<void>((resolve) => {
        releaseSubscribe = resolve;
      });
    },
    releaseSubscribe() {
      releaseSubscribe?.();
    },
    resume() {
      mode = "resume";
    },
    unavailable() {
      lifecycleListener?.({
        workspaceKey,
        workspacePath: "/budget-workspace",
        state: "unavailable",
        runtimeIdentity: {
          workspaceKey,
          generation: runtimeGeneration,
          identity: `runtime-${runtimeGeneration}`,
        },
      });
    },
    available() {
      runtimeGeneration += 1;
      for (const listener of restartListeners) listener({ workspaceKey });
      lifecycleListener?.({
        workspaceKey,
        workspacePath: "/budget-workspace",
        state: "available",
        runtimeIdentity: {
          workspaceKey,
          generation: runtimeGeneration,
          identity: `runtime-${runtimeGeneration}`,
        },
      });
    },
  };
}

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const failure of ["corrupt", "timeout", "partial"] as const) {
    test(`${clientMode}: successful ACKs do not replenish ${failure} recovery budget`, async (t) => {
      const f = fixture(t, clientMode);
      await f.store.connect();
      for (let round = 0; round < 3; round += 1) {
        await f.failedRound(failure);
        assert.equal(f.subscriptions.length, Math.min(round + 2, 3));
      }
      assert.equal(f.store.getState().status, "error");
      assert.equal(
        f.store.getState().lastError,
        failure === "corrupt"
          ? "fault.subscription.recoveryFailed"
          : "fault.subscription.recoveryFrameTimedOut",
      );
      assert.equal(f.resyncs.length, 3);
      assert.ok(
        f.resyncs.every((request) => request.forceSnapshot === true && request.base === null),
      );
      assert.deepEqual(f.subscribeBases, [undefined, undefined, undefined]);
      f.broken("recovery");
      t.mock.timers.tick(timeoutMs * 5);
      await flush();
      assert.equal(f.subscriptions.length, 3, "error is terminal until explicit retry");
    });
  }

  test(`${clientMode}: only complete base application starts a new recovery cycle`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    await f.failedRound();
    await f.failedRound();
    const wires = f.encode(f.snapshotFrame(f.store.getState().subscriptionId!, 20), "initial");
    f.publish(wires.slice(0, 1));
    assert.equal(f.store.getState().snapshot, null, "partial fragments are not an applied base");
    f.publish(wires.slice(1));
    assert.equal(f.store.getState().snapshot?.seq, 20);
    f.publish(
      f.encode(
        {
          topic,
          subscriptionId: f.store.getState().subscriptionId!,
          fromSeq: 20,
          toSeq: 21,
          sentAt: Date.now(),
          payload: {
            kind: "deltas",
            deltas: [
              {
                op: "state.updated",
                patch: { meta: { title: "after baseline", titleSource: "custom" } },
              },
            ],
          },
        },
        "online",
      ),
    );
    assert.equal(f.store.getState().snapshot?.seq, 21);
    assert.equal(f.store.getState().snapshot?.meta.title, "after baseline");
    for (let round = 0; round < 3; round += 1) await f.failedRound();
    assert.equal(f.subscriptions.length, 5);
    assert.equal(f.store.getState().status, "error");
  });

  test(`${clientMode}: old subscription successes cannot replenish a newer generation`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    f.base();
    const oldSubscription = f.store.getState().subscriptionId!;
    await f.failedRound();
    const superseded = f.store.getState().subscriptionId!;
    f.holdSubscribe();
    const pending = f.store.connect({ forceSnapshot: true });
    await flush();
    // ACK 尚未返回，store 的展示 subId 仍是旧代；真实 wire 路由也仍允许它到达。
    f.base("online", superseded, 50);
    assert.equal(f.store.getState().snapshot?.seq, 10);
    f.releaseSubscribe();
    await pending;
    f.base("initial", oldSubscription, 60);
    assert.equal(f.store.getState().snapshot?.seq, 10);
    await f.failedRound();
    await f.failedRound();
    assert.equal(
      f.subscriptions.length,
      4,
      "one manual connect plus the two automatic attempts only",
    );
    assert.equal(f.store.getState().status, "error");
  });

  test(`${clientMode}: an aligned empty resume is a successful baseline, not an ACK`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    f.base();
    await f.failedRound();
    await f.failedRound();
    f.resume();
    await f.store.connect();
    assert.deepEqual(f.subscribeBases.at(-1), { logEpoch: "budget-epoch", seq: 10 });
    f.publish(
      f.encode(
        {
          topic,
          subscriptionId: f.store.getState().subscriptionId!,
          fromSeq: 10,
          toSeq: 10,
          sentAt: Date.now(),
          payload: { kind: "deltas", deltas: [] },
        },
        "initial",
      ),
    );
    for (let round = 0; round < 3; round += 1) await f.failedRound();
    assert.equal(f.subscriptions.length, 6);
    assert.equal(f.store.getState().status, "error");
  });

  test(`${clientMode}: stale recovery frames and partial assemblies do not restore the budget`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    f.base();
    await f.failedRound();
    await f.failedRound();
    f.resume();
    await f.store.connect();
    f.publish(
      f.encode(
        {
          topic,
          subscriptionId: f.store.getState().subscriptionId!,
          fromSeq: 0,
          toSeq: 9,
          sentAt: Date.now(),
          payload: { kind: "deltas", deltas: [] },
        },
        "initial",
      ),
    );
    t.mock.timers.tick(timeoutMs);
    await flush();
    f.publish(
      f.encode(
        {
          topic,
          subscriptionId: f.store.getState().subscriptionId!,
          fromSeq: 0,
          toSeq: 9,
          sentAt: Date.now(),
          payload: { kind: "deltas", deltas: [] },
        },
        "recovery",
      ),
    );
    assert.equal(f.store.getState().snapshot?.seq, 10);
    // 陈旧 logical success 不能收口 flight；超时升级到 snapshot 后仍只交付第一片。
    t.mock.timers.tick(timeoutMs);
    await flush();
    const partial = f.encode(f.snapshotFrame(f.store.getState().subscriptionId!, 20), "recovery");
    f.publish(partial.slice(0, 1));
    t.mock.timers.tick(timeoutMs);
    await flush();
    assert.equal(f.subscriptions.length, 4);
    assert.equal(f.store.getState().status, "error");
    assert.equal(f.store.getState().snapshot?.seq, 10);
  });

  test(`${clientMode}: snapshot watermarks must agree before the budget resets`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    await f.failedRound();
    await f.failedRound();
    const inconsistent = f.snapshotFrame(f.store.getState().subscriptionId!, 30);
    f.publish(f.encode({ ...inconsistent, toSeq: 31 }, "initial"));
    await flush();
    assert.equal(f.store.getState().snapshot, null);
    f.broken("recovery");
    await flush();
    assert.equal(f.subscriptions.length, 3);
    assert.equal(f.store.getState().status, "error");
  });

  test(`${clientMode}: a complete same-sub recovery snapshot restores a new cycle`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    await f.failedRound();
    await f.failedRound();
    f.broken("initial");
    await flush();
    f.base("recovery", f.store.getState().subscriptionId!, 30);
    assert.equal(f.store.getState().snapshot?.seq, 30);
    for (let round = 0; round < 3; round += 1) await f.failedRound();
    assert.equal(f.subscriptions.length, 5);
    assert.equal(f.store.getState().status, "error");
  });

  test(`${clientMode}: complete baseline independently restores runtime recycle backoff`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      f.unavailable();
      f.available();
      await flush();
    }
    f.base();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      f.unavailable();
      f.available();
      await flush();
    }
    assert.equal(f.store.getState().status, "live");
    f.unavailable();
    assert.equal(f.store.getState().status, "error");
    assert.equal(f.subscriptions.length, 7);
  });

  test(`${clientMode}: runtime availability and ACK cannot replenish recycle backoff`, async (t) => {
    const f = fixture(t, clientMode);
    await f.store.connect();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      f.unavailable();
      f.available();
      await flush();
    }
    f.unavailable();
    assert.equal(f.store.getState().status, "error");
    f.available();
    await flush();
    assert.equal(f.subscriptions.length, 4);
  });

  for (const pending of ["initial", "recovery", "recycle"] as const) {
    test(`${clientMode}: closing clears the ${pending} deadline`, async (t) => {
      const f = fixture(t, clientMode);
      await f.store.connect();
      if (pending === "recovery") {
        f.broken("initial");
        await flush();
      } else if (pending === "recycle") {
        f.unavailable();
      }
      const resyncCount = f.resyncs.length;
      await f.store.close();
      t.mock.timers.tick(timeoutMs * 5);
      await flush();
      assert.equal(f.subscriptions.length, 1);
      assert.equal(f.resyncs.length, resyncCount);
      assert.equal(f.unsubscriptions.length, pending === "recycle" ? 0 : 1);
      assert.equal(f.store.getState().status, "closed");
    });
  }
}
