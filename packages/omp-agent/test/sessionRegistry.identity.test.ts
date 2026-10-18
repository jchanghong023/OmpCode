// Registry 身份与索引时序通过真实 stdio/v4 观察，不直接改投影或注入 OMP 端口。
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  commandAckSchema,
  sessionsIndexTopicFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  TopicWireFrameAssembler,
  v4SessionsIndexSubscribeResultSchema,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

const workspaceId = "real-e2e-workspace";
const topic = `sessions-index/${workspaceId}`;
const listSchema = z.object({ sessions: z.array(z.looseObject({ sessionId: z.string() })) });

function indexFrames(harness: RealOmpHarness): SessionsIndexTopicFrame[] {
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const logical: SessionsIndexTopicFrame[] = [];
  for (const envelope of harness.frames) {
    if (envelope.method !== "v4/conversation/frame") continue;
    const params = envelope.params;
    if (!params || typeof params !== "object" || !("topic" in params) || params.topic !== topic)
      continue;
    for (const event of assembler.accept(sessionsIndexTopicWireFrameSchema.parse(params))) {
      assert.notEqual(event.kind, "fault", JSON.stringify(event));
      if (event.kind !== "fault") logical.push(event.frame);
    }
  }
  return logical;
}

test(
  "真实身份：临时地址先终结再迁移唯一 UUID，旧/新 topic 与索引恢复连续",
  { skip: realOmpSkip },
  async () => {
    let release!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = "IDENTITY_REAL_RESPONSE";
    const harness = await startRealOmpHarness({
      handler: async () => {
        await modelGate;
        return { content: [marker] };
      },
    });
    try {
      const subscription = v4SessionsIndexSubscribeResultSchema.parse(
        await harness.request("v4/conversation/subscribe", {
          topic,
          connectionId: "identity-index",
          clientMode: "desktop-continuous",
        }),
      );
      const draft = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "create-identity-draft",
          clientId: "identity",
          sessionId: null,
          type: "createSession",
          payload: { workspaceId },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(draft.status, "accepted");
      const temporaryId = z.object({ sessionId: z.string() }).parse(draft.result).sessionId;
      assert.match(temporaryId, /^omp-session-/u);
      await harness.subscribe(temporaryId);
      const sent = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "identity-first-input",
          clientId: "identity",
          sessionId: temporaryId,
          type: "sendText",
          payload: { text: "Keep this identity through completion." },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(sent.status, "accepted");
      await harness.waitUntil(() => harness.mock.calls.length > 0);
      assert.deepEqual(
        listSchema
          .parse(await harness.request(zcodeProtocolMethods.sessionList, {}))
          .sessions.map((session) => session.sessionId),
        [temporaryId],
        "真实模型仍等待时不能提前发布另一条 UUID 会话",
      );
      release();
      await harness.waitUntil(() => harness.terminal(temporaryId));
      assert.equal(harness.terminal(temporaryId)?.state, "completedSuccess");
      const listed = listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {}));
      assert.equal(listed.sessions.length, 1);
      const stableId = z.uuid().parse(listed.sessions[0]!.sessionId);
      assert.notEqual(stableId, temporaryId);
      const deltas = await harness.waitUntil(() => {
        const observed = indexFrames(harness).flatMap((frame) =>
          frame.payload.kind === "deltas" ? frame.payload.deltas : [],
        );
        return observed.some(
          (delta) => delta.op === "session.upserted" && delta.session.sessionId === stableId,
        )
          ? observed
          : undefined;
      });
      const terminal = deltas.findIndex(
        (delta) =>
          delta.op === "session.upserted" &&
          delta.session.sessionId === temporaryId &&
          delta.session.phase === "completedSuccess",
      );
      const removed = deltas.findIndex(
        (delta) => delta.op === "session.removed" && delta.sessionId === temporaryId,
      );
      const stable = deltas.findIndex(
        (delta) => delta.op === "session.upserted" && delta.session.sessionId === stableId,
      );
      assert.ok(terminal >= 0 && removed > terminal && stable > removed, JSON.stringify(deltas));

      await Promise.all([harness.subscribe(temporaryId), harness.subscribe(stableId)]);
      for (const id of [temporaryId, stableId]) {
        await harness.waitUntil(() =>
          [...harness.rows(id).values()].find(
            (row) => row.kind === "assistantText" && String(row.text ?? "").includes(marker),
          ),
        );
        const snapshot = z
          .object({
            session: z.looseObject({ sessionId: z.string() }),
            projection: z.looseObject({ sessionId: z.string() }),
          })
          .parse(await harness.request(zcodeProtocolMethods.sessionRead, { sessionId: id }));
        assert.equal(snapshot.session.sessionId, id);
        assert.equal(snapshot.projection.sessionId, id);
      }
      const recoveryStart = indexFrames(harness).length;
      const recoveryAck = z
        .object({ ack: z.object({ subscriptionId: z.string(), mode: z.literal("snapshot") }) })
        .parse(
          await harness.request("v4/conversation/resync", {
            topic,
            subscriptionId: subscription.ack.subscriptionId,
            base: null,
            forceSnapshot: true,
          }),
        );
      assert.equal(recoveryAck.ack.subscriptionId, subscription.ack.subscriptionId);
      // stdio 是 ACK-first：响应不证明后置通知已经读到，且后面还可跟在线 delta。
      // 只等待本次 forceSnapshot 之后、属于原订阅的完整快照，不把最后一帧当快照。
      const recovery = await harness.waitUntil(() =>
        indexFrames(harness)
          .slice(recoveryStart)
          .find(
            (frame) =>
              frame.subscriptionId === subscription.ack.subscriptionId &&
              frame.payload.kind === "snapshot",
          ),
      );
      if (recovery.payload.kind !== "snapshot") throw new Error("expected real recovery snapshot");
      assert.deepEqual(
        recovery.payload.snapshot.sessions.map((session) => session.sessionId),
        [stableId],
      );
      const renamed = commandAckSchema.parse(
        await harness.request("v4/command", {
          commandId: "rename-after-recovery",
          clientId: "identity",
          sessionId: stableId,
          type: "renameSession",
          payload: { title: "Identity after recovery" },
          issuedAt: Date.now(),
        }),
      );
      assert.equal(renamed.status, "accepted");
      const continuation = await harness.waitUntil(() => {
        const frames = indexFrames(harness).slice(recoveryStart);
        const snapshotIndex = frames.findIndex(
          (frame) =>
            frame.subscriptionId === subscription.ack.subscriptionId &&
            frame.payload.kind === "snapshot",
        );
        const following = frames
          .slice(snapshotIndex + 1)
          .filter((frame) => frame.subscriptionId === subscription.ack.subscriptionId);
        return following.some(
          (frame) =>
            frame.payload.kind === "deltas" &&
            frame.payload.deltas.some(
              (delta) =>
                delta.op === "session.upserted" &&
                delta.session.sessionId === stableId &&
                delta.session.title === "Identity after recovery",
            ),
        )
          ? following
          : undefined;
      });
      let seq = recovery.toSeq;
      for (const frame of continuation) {
        assert.equal(frame.fromSeq, seq, "恢复后的每条真实 delta 必须连续");
        assert.ok(frame.toSeq > seq);
        seq = frame.toSeq;
      }
      harness.mock.assertHealthy();
    } finally {
      release();
      await harness.close();
    }
  },
);

test(
  "F016: 真实公开 createSession 拒绝错误 workspace、缺失附件及重复改写，不创建幽灵会话",
  { skip: realOmpSkip },
  async () => {
    const harness = await startRealOmpHarness({
      responses: [{ content: ["IDENTITY_BOUND_INPUT"] }],
    });
    try {
      for (const [index, firstInput] of [
        undefined,
        { text: "must not send" },
        {
          text: "must not inspect attachment",
          attachments: [
            { ref: "missing-reference", fileName: "test.txt", mime: "text/plain", bytes: 1 },
          ],
        },
      ].entries()) {
        const envelope = {
          commandId: `wrong-workspace-${index}`,
          clientId: "identity",
          sessionId: null,
          type: "createSession",
          issuedAt: Date.now(),
          payload: { workspaceId: harness.workspace, ...(firstInput ? { firstInput } : {}) },
        };
        const [first, second] = await Promise.all([
          harness.request("v4/command", envelope),
          harness.request("v4/command", envelope),
        ]);
        const ack = commandAckSchema.parse(first);
        assert.equal(ack.status, "rejected");
        assert.equal(ack.reasonCode, "fault.command.workspaceMismatch");
        assert.deepEqual(second, first);
        assert.deepEqual(
          await harness.request("v4/command", {
            ...envelope,
            payload: { workspaceId },
          }),
          first,
          "同 commandId 不能把已决 workspace 拒绝变成创建",
        );
      }
      assert.equal(harness.mock.calls.length, 0);
      assert.deepEqual(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions,
        [],
      );
      const sessionId = await harness.create(
        "bound-identity",
        "Use the matching workspace identity.",
      );
      await harness.waitUntil(() => harness.terminal(sessionId));
      assert.equal(harness.terminal(sessionId)?.state, "completedSuccess");
      const snapshot = z
        .object({
          session: z.object({
            workspace: z.object({ workspaceKey: z.string(), workspacePath: z.string() }),
          }),
        })
        .parse(await harness.request(zcodeProtocolMethods.sessionRead, { sessionId }));
      assert.equal(snapshot.session.workspace.workspaceKey, workspaceId);
      assert.equal(snapshot.session.workspace.workspacePath, harness.workspace);
      assert.equal(
        listSchema.parse(await harness.request(zcodeProtocolMethods.sessionList, {})).sessions
          .length,
        1,
      );
      harness.mock.assertHealthy();
    } finally {
      await harness.close();
    }
  },
);
