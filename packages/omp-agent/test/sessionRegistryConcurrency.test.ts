// Registry concurrency is accepted through the real stdio/v4 and legacy surfaces.
// A test-owned real file-read boundary also fences the close/cold-resume interleaving.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  commandAckSchema,
  conversationTopicFrameSchema,
  conversationTopicWireFrameSchema,
  sessionsIndexTopicFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  TopicWireFrameAssembler,
  v4ConversationSubscribeResultSchema,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
  type SessionReadBarrier,
} from "./fixtures/realOmpHarness.js";

const workspaceId = "real-e2e-workspace";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function indexSessionIds(harness: RealOmpHarness) {
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const ids = new Set<string>();
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const wire = sessionsIndexTopicWireFrameSchema.safeParse(frame.params);
    if (!wire.success || wire.data.topic !== `sessions-index/${workspaceId}`) continue;
    for (const event of assembler.accept(wire.data)) {
      if (event.kind === "fault") assert.fail(JSON.stringify(event.fault));
      const payload = event.frame.payload;
      if (payload.kind === "snapshot") {
        ids.clear();
        for (const session of payload.snapshot.sessions) ids.add(session.sessionId);
      } else {
        for (const delta of payload.deltas) {
          if (delta.op === "session.upserted") ids.add(delta.session.sessionId);
          if (delta.op === "session.removed") ids.delete(delta.sessionId);
        }
      }
    }
  }
  return [...ids];
}
const inputs = { a: "REGISTRY_SESSION_A_INPUT", b: "REGISTRY_SESSION_B_INPUT" };
const replies = { a: "REGISTRY_SESSION_A_REPLY", b: "REGISTRY_SESSION_B_REPLY" };
const nextInputs = { a: "REGISTRY_SESSION_A_NEXT", b: "REGISTRY_SESSION_B_NEXT" };
const nextReplies = { a: "REGISTRY_SESSION_A_CONTINUED", b: "REGISTRY_SESSION_B_CONTINUED" };
type SessionKey = keyof typeof inputs;
type Subscription = { sessionId: string; subscriptionId: string };
const legacySnapshotSchema = z.object({
  session: z.object({ sessionId: z.string() }),
  projection: z.object({ sessionId: z.string() }),
  messages: z.array(
    z.object({
      info: z.object({ sessionId: z.string() }),
      parts: z.array(z.looseObject({ text: z.string().optional() })),
    }),
  ),
});

function envelope(sessionId: string | null, commandId: string, type: string, payload: unknown) {
  return {
    sessionId,
    commandId,
    clientId: "registry-concurrency",
    issuedAt: Date.now(),
    type,
    payload,
  };
}

async function subscribe(
  harness: RealOmpHarness,
  sessionId: string,
  connectionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): Promise<Subscription> {
  const { ack } = v4ConversationSubscribeResultSchema.parse(
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId,
      clientMode,
    }),
  );
  return { sessionId, subscriptionId: ack.subscriptionId };
}

function latestSnapshot(harness: RealOmpHarness, subscription: Subscription) {
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  let snapshot: ConversationSnapshot | undefined;
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const wire = conversationTopicWireFrameSchema.safeParse(frame.params);
    if (!wire.success || wire.data.subscriptionId !== subscription.subscriptionId) continue;
    assert.equal(wire.data.topic, `conversation/${subscription.sessionId}`);
    for (const event of assembler.accept(wire.data)) {
      if (event.kind === "fault") assert.fail(JSON.stringify(event.fault));
      if (event.frame.payload.kind === "snapshot") snapshot = event.frame.payload.snapshot;
    }
  }
  if (snapshot) assert.equal(snapshot.sessionId, subscription.sessionId);
  return snapshot;
}

function assertRows(rows: ConversationRow[], key: SessionKey, continued = false) {
  const other = key === "a" ? "b" : "a";
  assert.equal(
    rows.filter((row) => row.kind === "userInput" && row.text === inputs[key]).length,
    1,
  );
  assert.equal(
    rows.filter((row) => row.kind === "assistantText" && row.text === replies[key]).length,
    1,
  );
  const text = JSON.stringify(rows);
  for (const foreign of [inputs[other], replies[other], nextInputs[other], nextReplies[other]]) {
    assert.ok(!text.includes(foreign), `session ${key} must not contain ${foreign}`);
  }
  if (continued) {
    assert.equal(
      rows.filter((row) => row.kind === "userInput" && row.text === nextInputs[key]).length,
      1,
    );
    assert.equal(
      rows.filter((row) => row.kind === "assistantText" && row.text === nextReplies[key]).length,
      1,
    );
  }
}

function assertLegacy(raw: unknown, sessionId: string, key: SessionKey, continued = false) {
  const snapshot = legacySnapshotSchema.parse(raw);
  assert.equal(snapshot.session.sessionId, sessionId);
  assert.equal(snapshot.projection.sessionId, sessionId);
  const text = snapshot.messages
    .flatMap((message) => message.parts.map((part) => part.text ?? ""))
    .join("\n");
  assert.ok(text.includes(inputs[key]));
  assert.ok(text.includes(replies[key]));
  const other = key === "a" ? "b" : "a";
  assert.ok(!text.includes(inputs[other]));
  assert.ok(!text.includes(replies[other]));
  if (continued) assert.ok(text.includes(nextReplies[key]));
}

async function terminal(harness: RealOmpHarness, sessionId: string, commandId: string) {
  const row = await harness.waitUntil(() =>
    [...harness.rows(sessionId).values()].find(
      (row) =>
        row.kind === "turnHeader" &&
        row.sourceCommandId === commandId &&
        ["completedSuccess", "completedInterrupted", "failed"].includes(String(row.state)),
    ),
  );
  if (row.state !== "completedSuccess") {
    const subscription = await subscribe(
      harness,
      sessionId,
      `failure-${commandId}`,
      "desktop-continuous",
    );
    const failed = await harness.waitUntil(() => latestSnapshot(harness, subscription));
    assert.fail(
      JSON.stringify({
        sessionId,
        commandId,
        terminal: row,
        control: failed.control,
        lastError: failed.control.lastError,
        rows: failed.rows.window,
        modelCalls: harness.mock.calls.map((call) => ({
          userMessages: call.context.messages
            .filter((message: { role: string }) => message.role === "user")
            .map((message: { content: unknown }) => message.content),
        })),
        adapterDiagnostics: harness.diagnostics(),
      }),
    );
  }
}

test(
  "real registry: parallel v4/legacy create, cold resume and subscriptions retain one identity without cross-session state",
  {
    skip: realOmpSkip,
  },
  async () => {
    const harness = await startRealOmpHarness({
      handler(context: { messages: { role: string; content: unknown }[] }) {
        const user = [...context.messages].reverse().find((message) => message.role === "user");
        const text = JSON.stringify(user?.content);
        for (const key of ["a", "b"] as const) {
          if (text?.includes(nextInputs[key])) return { content: [nextReplies[key]] };
          if (text?.includes(inputs[key])) return { content: [replies[key]] };
        }
        throw new Error(`unexpected registry model input: ${text}`);
      },
    });
    try {
      await harness.request("v4/conversation/subscribe", {
        topic: `sessions-index/${workspaceId}`,
        connectionId: "registry-identity-index",
        clientMode: "desktop-continuous",
      });
      const [createdV4, createdLegacy] = await Promise.all([
        harness.request("v4/command", envelope(null, "create-a", "createSession", { workspaceId })),
        harness.request("session/create", {}),
      ]);
      const createAck = commandAckSchema.parse(createdV4);
      assert.equal(createAck.status, "accepted");
      const a = z.object({ sessionId: z.string() }).parse(createAck.result).sessionId;
      const b = legacySnapshotSchema.parse(createdLegacy).session.sessionId;
      assert.notEqual(a, b, "concurrent creates own distinct real identities");
      await Promise.all([harness.subscribe(a), harness.subscribe(b)]);

      // Concurrent readers must not replace the active owner with an empty cold engine.
      const first = await Promise.all([
        harness.request("v4/command", envelope(a, "first-a", "sendText", { text: inputs.a })),
        harness.request("v4/command", envelope(b, "first-b", "sendText", { text: inputs.b })),
        harness.request("session/resume", { sessionId: a }),
        harness.request("session/resume", { sessionId: b }),
        subscribe(harness, a, "create-race-a", "web-remote-replayable"),
        subscribe(harness, b, "create-race-b", "web-remote-replayable"),
      ]);
      assert.equal(commandAckSchema.parse(first[0]).status, "accepted");
      assert.equal(commandAckSchema.parse(first[1]).status, "accepted");
      assert.equal(legacySnapshotSchema.parse(first[2]).session.sessionId, a);
      assert.equal(legacySnapshotSchema.parse(first[3]).session.sessionId, b);
      await Promise.all([terminal(harness, a, "first-a"), terminal(harness, b, "first-b")]);
      // A terminal row is not an identity-metadata fence. Wait for both actual
      // UUID bindings to be published before addressing cold history by UUID.
      const indexedIds = await harness.waitUntil(() => {
        const ids = indexSessionIds(harness);
        return ids.length === 2 && ids.every((id) => uuidPattern.test(id)) ? ids : undefined;
      });

      const listed = z
        .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
        .parse(await harness.request("session/list", {}));
      assert.equal(listed.sessions.length, 2);
      assert.deepEqual(
        listed.sessions.map((session) => session.sessionId).sort(),
        indexedIds.sort(),
      );
      const stable = {} as Record<SessionKey, string>;
      for (const { sessionId } of listed.sessions) {
        assert.match(sessionId, uuidPattern);
        const raw = await harness.request("session/read", { sessionId });
        const text = JSON.stringify(legacySnapshotSchema.parse(raw).messages);
        const key = text.includes(inputs.a) ? "a" : "b";
        assertLegacy(raw, sessionId, key);
        assert.equal(stable[key], undefined, "one stable identity per first input");
        stable[key] = sessionId;
      }
      assert.ok(stable.a && stable.b);
      assert.notEqual(stable.a, stable.b);
      await Promise.all(
        Object.values(stable).map((sessionId) => harness.request("session/close", { sessionId })),
      );

      // All requests cross the actual stdio boundary. Failures are public requests,
      // not injected exceptions or barriers in a substitute store/process factory.
      const [
        a1,
        a2,
        b1,
        b2,
        resumeA1,
        resumeA2,
        resumeB1,
        resumeB2,
        legacySubA,
        legacySubB,
        extraV4,
        extraLegacy,
        rejectedCreate,
        missingResume,
      ] = await Promise.all([
        subscribe(harness, stable.a, "cold-a-desktop", "desktop-continuous"),
        subscribe(harness, stable.a, "cold-a-web", "web-remote-replayable"),
        subscribe(harness, stable.b, "cold-b-desktop", "desktop-continuous"),
        subscribe(harness, stable.b, "cold-b-web", "web-remote-replayable"),
        harness.request("session/resume", { sessionId: stable.a }),
        harness.request("session/resume", { sessionId: stable.a }),
        harness.request("session/resume", { sessionId: stable.b }),
        harness.request("session/resume", { sessionId: stable.b }),
        harness.request("session/subscribe", { sessionId: stable.a }),
        harness.request("session/subscribe", { sessionId: stable.b }),
        harness.request(
          "v4/command",
          envelope(null, "create-during-cold", "createSession", { workspaceId }),
        ),
        harness.request("session/create", {}),
        harness.request(
          "v4/command",
          envelope(null, "reject-during-cold", "createSession", {
            workspaceId: "foreign-registry-workspace",
            firstInput: { text: "must never reach model" },
          }),
        ),
        harness.rawRequest("session/resume", { sessionId: randomUUID() }),
      ]);
      for (const resumed of [resumeA1, resumeA2]) assertLegacy(resumed, stable.a, "a");
      for (const resumed of [resumeB1, resumeB2]) assertLegacy(resumed, stable.b, "b");
      assert.equal(z.object({ sessionId: z.string() }).parse(legacySubA).sessionId, stable.a);
      assert.equal(z.object({ sessionId: z.string() }).parse(legacySubB).sessionId, stable.b);
      assert.equal(commandAckSchema.parse(rejectedCreate).status, "rejected");
      assert.equal(z.object({ code: z.number() }).parse(missingResume.error).code, -32004);
      const extraAck = commandAckSchema.parse(extraV4);
      assert.equal(extraAck.status, "accepted");
      const draftIds = [
        z.object({ sessionId: z.string() }).parse(extraAck.result).sessionId,
        legacySnapshotSchema.parse(extraLegacy).session.sessionId,
      ];
      assert.equal(new Set([...Object.values(stable), ...draftIds]).size, 4);
      for (const id of draftIds) {
        const subscription = await subscribe(harness, id, `extra-${id}`, "desktop-continuous");
        const draft = await harness.waitUntil(() => latestSnapshot(harness, subscription));
        assert.equal(draft.control.phase, "draft");
        assert.equal(draft.rows.window.length, 0);
      }
      const subscriptions = { a: [a1, a2], b: [b1, b2] };
      for (const key of ["a", "b"] as const) {
        const snapshots = await Promise.all(
          subscriptions[key].map((subscription) =>
            harness.waitUntil(() => latestSnapshot(harness, subscription)),
          ),
        );
        for (const snapshot of snapshots) assertRows(snapshot.rows.window, key);
        assert.deepEqual(snapshots[0]!.rows.window, snapshots[1]!.rows.window);
      }
      assert.equal(
        harness.mock.calls.length,
        2,
        "cold subscriptions and failed requests never invoke the model",
      );

      const next = await Promise.all(
        (["a", "b"] as const).map((key) =>
          harness.request(
            "v4/command",
            envelope(stable[key], `next-${key}`, "sendText", { text: nextInputs[key] }),
          ),
        ),
      );
      for (const ack of next) assert.equal(commandAckSchema.parse(ack).status, "accepted");
      await Promise.all(
        (["a", "b"] as const).map((key) => terminal(harness, stable[key], `next-${key}`)),
      );
      for (const key of ["a", "b"] as const) {
        for (const subscription of subscriptions[key]) {
          // A lost/overwritten owner cannot service every original subscription's resync.
          await harness.request("v4/conversation/resync", {
            topic: `conversation/${stable[key]}`,
            subscriptionId: subscription.subscriptionId,
            base: null,
            forceSnapshot: true,
          });
          const recovered = await harness.waitUntil(() => {
            const current = latestSnapshot(harness, subscription);
            return current?.rows.window.some(
              (row) => row.kind === "assistantText" && row.text === nextReplies[key],
            )
              ? current
              : undefined;
          });
          assertRows(recovered.rows.window, key, true);
        }
        assertLegacy(
          await harness.request("session/read", { sessionId: stable[key] }),
          stable[key],
          key,
          true,
        );
      }
      const finalList = z
        .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
        .parse(await harness.request("session/list", {}));
      assert.deepEqual(
        finalList.sessions.map((session) => session.sessionId).sort(),
        Object.values(stable).sort(),
      );
      assert.equal(harness.mock.calls.length, 4);
    } finally {
      await harness.close();
    }
  },
);

test(
  "real registry: close fences an in-flight cold resume across alias/canonical identities",
  { skip: realOmpSkip },
  async () => {
    const input = "CLOSE_RACE_PERSISTED_INPUT";
    const reply = "CLOSE_RACE_PERSISTED_REPLY";
    const harness = await startRealOmpHarness({
      responses: [{ content: [reply] }],
      sessionReadBarrier: true,
    });
    let barrier: SessionReadBarrier | undefined;
    try {
      // 与真实 alias 恢复验收相同：先让原生命令写入派生历史，再由普通轮绑定 UUID。
      // 不手写 session 文件/aliases，冷 alias 必须由产品自己的关联路径产生。
      const alias = legacySnapshotSchema.parse(await harness.request("session/create", {})).session
        .sessionId;
      assert.match(alias, /^omp-session-/u);
      await harness.subscribe(alias);
      for (const [commandId, text] of [
        ["close-race-native-history", "/goal show"],
        ["close-race-model-history", input],
      ] as const) {
        const ack = commandAckSchema.parse(
          await harness.request("v4/command", envelope(alias, commandId, "sendText", { text })),
        );
        assert.equal(ack.status, "accepted");
        await terminal(harness, alias, commandId);
      }
      const listed = z
        .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
        .parse(await harness.request("session/list", {}));
      assert.equal(listed.sessions.length, 1);
      const canonical = z.uuid().parse(listed.sessions[0]!.sessionId);
      assert.notEqual(alias, canonical);
      assert.equal(harness.mock.calls.length, 1);

      for (const resumeId of [canonical, alias]) {
        for (const closeId of [canonical, alias]) {
          // 同 raw ID 由真实协议队列串行，不能人为暂停前请求再等待后请求。
          // alias/UUID 的队列 key 不同，只有这两个同历史地址的交叉关闭确实可并发。
          if (resumeId === closeId) continue;
          await harness.request("session/close", { sessionId: canonical });
          // fs.read 已读取真实 JSONL，只有把结果交给真实 store 的回调被暂停。
          // 因而 close 必然发生在冷读取进入之后、owner 登记之前，绝不靠 sleep 抢时序。
          barrier = await harness.pauseNextSessionRead(canonical);
          const inFlight = harness.rawRequest("session/resume", { sessionId: resumeId });
          await barrier.reached();
          assert.deepEqual(await harness.request("session/close", { sessionId: closeId }), {
            closed: true,
          });
          barrier.release();
          barrier = undefined;
          const stale = await inFlight;
          assert.notEqual(
            stale.error,
            undefined,
            `close(${closeId}) returned, but earlier resume(${resumeId}) still succeeded`,
          );
          assert.equal(
            z.object({ code: z.number() }).parse(stale.error).code,
            -32004,
            `close(${closeId}) must invalidate the earlier resume(${resumeId})`,
          );
          for (const sessionId of [canonical, alias]) {
            // messages 只读已加载 owner，不像 read/resume 会主动冷加载；这是公开消费面。
            const unavailable = await harness.rawRequest("session/messages", { sessionId });
            assert.equal(z.object({ code: z.number() }).parse(unavailable.error).code, -32004);
          }

          const spawned = harness.coreLifecycle.filter(
            (record) => record.event === "omp_core_spawned" && record.sessionless === false,
          );
          assert.ok(spawned.length > 0, "必须先实际启动过真实会话 OMP，才能证明 close 回收它");
          await harness.waitUntil(() =>
            spawned.every((record) =>
              harness.coreLifecycle.some(
                (exit) =>
                  exit.event === "omp_core_exited" && exit.coreInstanceId === record.coreInstanceId,
              ),
            ),
          );
          for (const record of spawned) {
            const pid = z.number().int().positive().parse(record.peerPid);
            assert.throws(
              () => process.kill(pid, 0),
              (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
              "关闭返回且旧恢复结束后，真实会话进程必须已退出",
            );
          }

          for (const sessionId of [alias, canonical]) {
            const reopened = legacySnapshotSchema.parse(
              await harness.request("session/resume", { sessionId }),
            );
            assert.equal(reopened.session.sessionId, sessionId);
            assert.equal(reopened.projection.sessionId, sessionId);
            const history = JSON.stringify(reopened.messages);
            assert.ok(history.includes(input), "关闭只卸载 owner，不能删除同一历史输入");
            assert.ok(history.includes(reply), "关闭后新显式恢复仍读到原模型回复");
          }
          assert.equal(harness.mock.calls.length, 1, "关闭、旧恢复拒绝和新显式恢复均零模型重放");
        }
      }

      harness.mock.assertHealthy();
    } finally {
      barrier?.release();
      await harness.close();
    }
  },
);
