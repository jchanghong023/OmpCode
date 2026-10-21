// Runtime acceptance uses actual OMP commands, queues and tools. The loopback
// model controls only response intent; v4 state is always the adapter's projection.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { zcodeProtocolMethods } from "@zcode/shared";
import {
  commandAckSchema,
  queueStateSchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionsIndexTopicFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  TopicWireFrameAssembler,
  v4AttachmentCommitResultSchema,
  v4ConversationSubscribeResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

type Block = {
  type: string;
  text?: string;
  source?: { type: string; media_type: string; data: string };
};
type ModelContext = { messages: { role: string; content: string | Block[] }[] };
const workspaceId = "real-e2e-workspace";
const indexTopic = `sessions-index/${workspaceId}`;
// Exact envelope from OMP prompts/steering/user-interjection.md, not arbitrary XML.
const steeringNotice =
  "<system-notice>\n" +
  "User interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n" +
  "</system-notice>\n";

function latestInput(context: ModelContext) {
  const message = [...context.messages].reverse().find((item) => item.role === "user");
  assert.ok(message, "model request must contain a user message");
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim()
    .replace(
      /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+?'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
      "",
    );
  return { text, images: blocks.filter((block) => block.type === "image") };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function holdUntilReleased(released: Promise<void>, signal?: AbortSignal) {
  if (!signal) throw new Error("mock request lacks its HTTP cancellation signal");
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    await Promise.race([released, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function command(
  harness: RealOmpHarness,
  sessionId: string | null,
  commandId: string,
  type: string,
  payload: unknown,
  cas: { baseRevision?: number; baseLogEpoch?: string } = {},
) {
  return commandAckSchema.parse(
    await harness.request("v4/command", {
      commandId,
      clientId: "runtime-e2e",
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
      ...cas,
    }),
  );
}

async function createEmpty(harness: RealOmpHarness, id: string) {
  const ack = await command(harness, null, `create-${id}`, "createSession", { workspaceId });
  assert.equal(ack.status, "accepted");
  assert.ok(
    ack.result && "sessionId" in ack.result,
    "createSession must return its real session identity",
  );
  const sessionId = ack.result.sessionId;
  assert.ok(sessionId);
  await harness.subscribe(sessionId);
  return sessionId;
}

function indexFrames(harness: RealOmpHarness): SessionsIndexTopicFrame[] {
  const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
  const logical: SessionsIndexTopicFrame[] = [];
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const params = frame.params;
    if (
      !params ||
      typeof params !== "object" ||
      !("topic" in params) ||
      params.topic !== indexTopic
    )
      continue;
    for (const event of assembler.accept(sessionsIndexTopicWireFrameSchema.parse(params))) {
      assert.notEqual(event.kind, "fault", JSON.stringify(event));
      if (event.kind !== "fault") logical.push(event.frame);
    }
  }
  return logical;
}

function indexSessions(harness: RealOmpHarness) {
  const sessions = new Map<string, string>();
  for (const { payload } of indexFrames(harness)) {
    if (payload.kind === "snapshot") {
      sessions.clear();
      for (const session of payload.snapshot.sessions)
        sessions.set(session.sessionId, session.phase);
    } else
      for (const delta of payload.deltas) {
        if (delta.op === "session.upserted")
          sessions.set(delta.session.sessionId, delta.session.phase);
        else sessions.delete(delta.sessionId);
      }
  }
  return sessions;
}

const sessionListSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string().min(1) })),
});
// Compare consumer identity and content, not legacy tool timestamps synthesized
// at read time when the live projection has no persisted execution timestamps.
const sessionHistorySchema = z.object({
  session: z.object({ sessionId: z.string() }),
  messages: z.array(
    z.object({
      info: z.object({
        messageId: z.string(),
        role: z.string(),
        parentMessageId: z.string().optional(),
      }),
      parts: z.array(
        z.object({
          partId: z.string(),
          messageId: z.string(),
          type: z.string(),
          text: z.string().optional(),
          callId: z.string().optional(),
          tool: z.string().optional(),
          state: z
            .object({
              status: z.string(),
              input: z.unknown(),
              output: z.unknown().optional(),
            })
            .optional(),
        }),
      ),
    }),
  ),
});

async function singleSessionIndexPhase(harness: RealOmpHarness, alias: string, phase: string) {
  // The conversation keeps its live alias, but sessions-index removes that ID
  // when the first real journal supplies a UUID. Resolve through the public owner.
  const listed = sessionListSchema.parse(
    await harness.request(zcodeProtocolMethods.sessionList, {}),
  );
  assert.equal(listed.sessions.length, 1, "one real session must have one canonical list entry");
  const canonical = listed.sessions[0]!.sessionId;
  if (canonical !== alias) {
    const histories = await Promise.all(
      [alias, canonical].map(async (sessionId) => {
        const history = sessionHistorySchema.parse(
          await harness.request(zcodeProtocolMethods.sessionRead, { sessionId }),
        );
        assert.equal(history.session.sessionId, sessionId);
        return history.messages;
      }),
    );
    assert.deepEqual(
      histories[0],
      histories[1],
      "alias and canonical ID must address the same actual history",
    );
  }
  await harness.waitUntil(() => {
    const sessions = indexSessions(harness);
    return sessions.size === 1 && sessions.get(canonical) === phase;
  });
  return canonical;
}

function assertOrdinals(harness: RealOmpHarness, subscriptionId: string) {
  const frames = new Map<string, number>();
  for (const frame of harness.frames) {
    if (frame.method !== "v4/conversation/frame") continue;
    const params = frame.params;
    if (
      !params ||
      typeof params !== "object" ||
      !("subscriptionId" in params) ||
      params.subscriptionId !== subscriptionId
    )
      continue;
    const wire = sessionsIndexTopicWireFrameSchema.parse(params);
    frames.set(wire.logicalFrameId, wire.logicalFrameOrdinal);
  }
  const ordinals = [...frames.values()];
  assert.ok(ordinals.length > 1, "subscription must receive multiple complete logical frames");
  assert.deepEqual(
    ordinals,
    ordinals.map((_, index) => index + 1),
  );
}

async function subscribeIndex(harness: RealOmpHarness) {
  const result = v4SessionsIndexSubscribeResultSchema.parse(
    await harness.request("v4/conversation/subscribe", {
      topic: indexTopic,
      connectionId: "runtime-index",
      clientMode: "desktop-continuous",
    }),
  );
  assert.ok(result.ack.subscriptionId);
  await harness.request("v4/conversation/resync", {
    topic: indexTopic,
    subscriptionId: result.ack.subscriptionId,
    base: null,
    forceSnapshot: true,
  });
  return result.ack.subscriptionId;
}

async function uploadImage(harness: RealOmpHarness, sessionId: string, bytes: Buffer) {
  const common = { connectionId: "runtime-image", uploadId: `image-${sessionId}`, sessionId };
  await harness.request("v4/attachment/begin", {
    ...common,
    fileName: "runtime.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: 1,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  await harness.request("v4/attachment/chunk", {
    ...common,
    chunkIndex: 0,
    dataBase64: bytes.toString("base64"),
  });
  const committed = v4AttachmentCommitResultSchema.parse(
    await harness.request("v4/attachment/commit", common),
  );
  return { ref: committed.ref, fileName: "runtime.png", mime: "image/png", bytes: bytes.length };
}

async function setMode(harness: RealOmpHarness, sessionId: string, mode: "guide" | "queue") {
  const snapshot = await harness.waitUntil(() =>
    harness.conversationFrames(sessionId).find((frame) => frame.payload.kind === "snapshot"),
  );
  assert.equal(snapshot.payload.kind, "snapshot");
  if (snapshot.payload.kind !== "snapshot") throw new Error("missing snapshot");
  let baseRevision = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ack = await command(
      harness,
      sessionId,
      `mode-${mode}-${attempt}`,
      "setFollowupMode",
      { mode },
      {
        baseRevision,
        baseLogEpoch: snapshot.payload.snapshot.logEpoch,
      },
    );
    if (ack.status === "accepted") return;
    assert.equal(ack.status, "stale", JSON.stringify(ack));
    baseRevision = ack.revisionAtDecision;
  }
  assert.fail("setFollowupMode CAS did not converge");
}

function successfulRows(harness: RealOmpHarness, sessionId: string) {
  const rows = [...harness.rows(sessionId).values()];
  const headers = rows.filter((row) => row.kind === "turnHeader");
  const assistants = rows.filter((row) => row.kind === "assistantText");
  return (
    headers.length > 0 &&
    headers.every((row) => row.state === "completedSuccess") &&
    // every([]) 为真，不能让完全没有模型正文的终态冒充成功。
    assistants.length > 0 &&
    assistants.every(
      (row) => row.state === "complete" && typeof row.text === "string" && row.text.length > 0,
    )
  );
}

test(
  "real stop aborts an executing tool, publishes interrupted index and permits same-session recovery",
  { skip: realOmpSkip },
  async () => {
    let toolPid: number | undefined;
    const probe = createServer((request, response) => {
      const url = new URL(request.url!, "http://127.0.0.1");
      // Leave this actual Node HTTP request pending: the owned tool process blocks
      // on a socket, not a guessed sleep or a fabricated tool-execution event.
      if (url.pathname !== "/runtime-tool-started") {
        response.writeHead(404).end();
        return;
      }
      toolPid = Number(url.searchParams.get("pid"));
    });
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const source = `require('http').get('http://127.0.0.1:${address.port}/runtime-tool-started?pid='+process.pid,r=>r.resume())`;
    let issued = false;
    const harness = await startRealOmpHarness({
      handler(context: ModelContext) {
        const { text } = latestInput(context);
        if (text === "runtime-cancel-tool" && !issued) {
          issued = true;
          return {
            content: [
              {
                type: "toolCall",
                id: "runtime_wait_tool",
                name: "bash",
                arguments: {
                  command: `"${process.execPath.replaceAll("\\", "/")}" -e "${source}"`,
                  timeout: 0,
                  pty: false,
                },
              },
            ],
          };
        }
        if (text === "runtime-recover-after-cancel") return { content: ["RUNTIME_RECOVERED"] };
        throw new Error(`Unexpected cancellation scenario request: ${JSON.stringify(text)}`);
      },
    }).catch(async (error: unknown) => {
      probe.closeAllConnections();
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      throw error;
    });
    try {
      const subscriptionId = await subscribeIndex(harness);
      const sessionId = await harness.create("runtime-stop", "runtime-cancel-tool");
      await harness.waitUntil(() => toolPid);
      assert.ok(Number.isSafeInteger(toolPid) && toolPid! > 0);
      await harness.waitUntil(() =>
        [...harness.rows(sessionId).values()].some(
          (row) => row.kind === "toolCall" && row.toolName === "bash" && row.status === "running",
        ),
      );
      const stopped = await command(harness, sessionId, "runtime-stop", "stop", {});
      assert.equal(stopped.status, "accepted");
      await harness.waitUntil(() => harness.terminal(sessionId)?.state === "completedInterrupted");
      await singleSessionIndexPhase(harness, sessionId, "completedInterrupted");
      await harness.waitUntil(() => {
        try {
          process.kill(toolPid!, 0);
          return false;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
            return true;
          throw error;
        }
      });
      const tool = [...harness.rows(sessionId).values()].find((row) => row.kind === "toolCall");
      assert.ok(tool);
      assert.ok(typeof tool.rowId === "number");
      assert.equal(tool.status, "cancelled");
      const interruptedRowId = harness.terminal(sessionId)!.rowId;
      assert.ok(typeof interruptedRowId === "number");
      assert.equal(
        (
          await command(harness, sessionId, "runtime-recovery", "sendText", {
            text: "runtime-recover-after-cancel",
          })
        ).status,
        "accepted",
      );
      await harness.waitUntil(() =>
        [...harness.rows(sessionId).values()].some(
          (row) =>
            row.kind === "assistantText" &&
            row.text === "RUNTIME_RECOVERED" &&
            row.state === "complete",
        ),
      );
      await harness.waitUntil(() =>
        [...harness.rows(sessionId).values()].some(
          (row) =>
            row.kind === "turnHeader" &&
            row.rowId !== interruptedRowId &&
            row.state === "completedSuccess",
        ),
      );
      await singleSessionIndexPhase(harness, sessionId, "completedSuccess");
      assert.equal(
        harness.rows(sessionId).get(tool.rowId)?.status,
        "cancelled",
        "late tool updates must not resurrect the cancelled tool",
      );
      assert.equal(harness.rows(sessionId).get(interruptedRowId)?.state, "completedInterrupted");
      assert.equal(
        harness.mock.calls.filter(
          (call: { context: ModelContext }) =>
            latestInput(call.context).text === "runtime-recover-after-cancel",
        ).length,
        1,
      );
      assertOrdinals(harness, subscriptionId);
    } finally {
      try {
        await harness.close();
      } finally {
        probe.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);

for (const mode of ["guide", "queue"] as const) {
  test(
    `real ${mode} input carries image bytes through OMP, drains the queue and replays terminal state`,
    { skip: realOmpSkip },
    async () => {
      const released = deferred();
      const started = deferred();
      // Valid 200×200 PNG stays on OMP's small-image passthrough path (1×1
      // images are intentionally upscaled/transcoded), so byte identity is meaningful.
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX/AAAAAP9sof2OAAAAHElEQVR42u3BgQAAAADDoPlTX+EAVQEAAAAAfAYUUAABxFrmKwAAAABJRU5ErkJggg==",
        "base64",
      );
      const initial = `runtime-${mode}-initial`;
      const supplement = `runtime-${mode}-supplement`;
      let initialCalls = 0;
      let supplementalCalls = 0;
      const harness = await startRealOmpHarness({
        async handler(context: ModelContext, options: { signal?: AbortSignal }) {
          const input = latestInput(context);
          if (input.text === initial && ++initialCalls === 1) {
            assert.deepEqual(input.images, []);
            started.resolve();
            await holdUntilReleased(released.promise, options.signal);
            return { content: [`RUNTIME_${mode}_INITIAL_DONE`] };
          }
          const supplementalText =
            mode === "guide" && input.text.startsWith(steeringNotice)
              ? input.text.slice(steeringNotice.length)
              : input.text;
          if (supplementalText === supplement && ++supplementalCalls === 1) {
            assert.equal(
              input.text,
              mode === "guide" ? steeringNotice + supplement : supplement,
              "real steer carries OMP's interjection envelope; queued prompts remain plain",
            );
            assert.deepEqual(
              input.images.map(({ type, source }) => ({ type, source })),
              [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: bytes.toString("base64"),
                  },
                },
              ],
            );
            return { content: [`RUNTIME_${mode}_SUPPLEMENT_CONSUMED`] };
          }
          throw new Error(`Unexpected ${mode} request: ${JSON.stringify(input.text)}`);
        },
      });
      try {
        const sessionId = await createEmpty(harness, `runtime-${mode}`);
        await setMode(harness, sessionId, mode);
        await harness.waitUntil(
          () =>
            sessionConfigStateSchema.parse(harness.state(sessionId).config).followupMode === mode,
        );
        const image = await uploadImage(harness, sessionId, bytes);
        assert.equal(
          (await command(harness, sessionId, `${mode}-start`, "sendText", { text: initial }))
            .status,
          "accepted",
        );
        await harness.waitUntil(() => initialCalls === 1);
        await started.promise;
        const sent = await command(harness, sessionId, `${mode}-supplement`, "sendText", {
          text: supplement,
          attachments: [image],
        });
        assert.equal(sent.status, "accepted");
        // The ACK exposes app admission. Actual model consumption, rather than
        // native queue snapshots or the ACK itself, proves delivery below.
        if (mode === "queue") {
          assert.ok(
            sent.result && "delivery" in sent.result,
            "sendText must report queued admission",
          );
          assert.equal(sent.result.delivery, "queue");
        }
        assert.equal(
          supplementalCalls,
          0,
          "second input is accepted while the first real model call is still in flight",
        );
        if (mode === "queue")
          await harness.waitUntil(() => {
            const queue = queueStateSchema.parse(harness.state(sessionId).queue);
            return queue?.items.some((item) => item.sourceCommandId === `${mode}-supplement`);
          });
        released.resolve();
        await harness.waitUntil(() => supplementalCalls === 1);
        await harness.waitUntil(() =>
          [...harness.rows(sessionId).values()].some(
            (row) =>
              row.kind === "assistantText" &&
              row.text === `RUNTIME_${mode}_SUPPLEMENT_CONSUMED` &&
              row.state === "complete",
          ),
        );
        await harness.waitUntil(
          () =>
            successfulRows(harness, sessionId) &&
            queueStateSchema.parse(harness.state(sessionId).queue).items.length === 0,
        );
        const rows = [...harness.rows(sessionId).values()];
        assert.deepEqual(
          rows
            .filter((row) => row.kind === "turnHeader")
            .map((row) => row.sourceCommandId)
            .sort(),
          [`${mode}-start`, `${mode}-supplement`].sort(),
          "both accepted inputs must retain their own terminal turn",
        );
        assert.ok(
          rows.some(
            (row) =>
              row.kind === "assistantText" &&
              row.text === `RUNTIME_${mode}_INITIAL_DONE` &&
              row.state === "complete",
          ),
          "the initial real response must not disappear",
        );
        for (const text of [initial, supplement])
          assert.ok(
            rows.some((row) => row.kind === "userInput" && row.text === text),
            `missing consumed input ${text}`,
          );
        assert.equal(initialCalls, 1);
        assert.equal(supplementalCalls, 1);
        assert.equal(
          harness.mock.calls.length,
          2,
          "both model requests must pass through actual Anthropic HTTP",
        );
        const replay = v4ConversationSubscribeResultSchema.parse(
          await harness.request("v4/conversation/subscribe", {
            topic: `conversation/${sessionId}`,
            connectionId: `runtime-${mode}-web`,
            clientMode: "web-remote-replayable",
          }),
        );
        const snapshot = await harness.waitUntil(() =>
          harness
            .conversationFrames(sessionId)
            .find(
              (frame) =>
                frame.subscriptionId === replay.ack.subscriptionId &&
                frame.payload.kind === "snapshot",
            ),
        );
        assert.equal(snapshot.payload.kind, "snapshot");
        if (snapshot.payload.kind === "snapshot") {
          assert.deepEqual(snapshot.payload.snapshot.queue.items, []);
          assert.equal(snapshot.payload.snapshot.control.phase, "completedSuccess");
          assert.ok(
            snapshot.payload.snapshot.rows.window
              .filter((row) => row.kind === "turnHeader")
              .every((row) => row.state === "completedSuccess"),
          );
        }
      } finally {
        released.resolve();
        await harness.close();
      }
    },
  );
}

test(
  "instant native command delivers the final sessions-index phase without a model request",
  { skip: realOmpSkip },
  async () => {
    const harness = await startRealOmpHarness({
      handler() {
        throw new Error("/goal show must not invoke a model");
      },
    });
    try {
      const subscriptionId = await subscribeIndex(harness);
      const sessionId = await harness.create("runtime-instant", "/goal show");
      await harness.waitUntil(() => harness.terminal(sessionId)?.state === "completedSuccess");
      await singleSessionIndexPhase(harness, sessionId, "completedSuccess");
      assert.equal(harness.mock.calls.length, 0);
      assertOrdinals(harness, subscriptionId);
    } finally {
      await harness.close();
    }
  },
);

test(
  "real provider failure preserves failed/error facts across prompt completion and another session",
  { skip: realOmpSkip },
  async () => {
    let failedCalls = 0;
    let independentCalls = 0;
    const harness = await startRealOmpHarness({
      handler(context: ModelContext) {
        const { text } = latestInput(context);
        if (text === "runtime-provider-failure" && ++failedCalls === 1) {
          assert.equal(context.messages.length, 1, "失败请求不得带入其他会话历史");
          assert.deepEqual(latestInput(context).images, []);
          return {
            content: [],
            stopReason: "error",
            errorMessage: "401 Model not supported: runtime-provider-failure",
          };
        }
        if (text === "runtime-independent-probe" && ++independentCalls === 1) {
          assert.equal(context.messages.length, 1, "独立会话不得复用失败会话历史");
          assert.deepEqual(latestInput(context).images, []);
          return { content: ["RUNTIME_INDEPENDENT_DONE"] };
        }
        throw new Error(`Unexpected error scenario request: ${JSON.stringify(text)}`);
      },
    });
    try {
      await subscribeIndex(harness);
      const failedSession = await harness.create(
        "runtime-provider-failure",
        "runtime-provider-failure",
      );
      await harness.waitUntil(() => harness.terminal(failedSession)?.state === "failed");
      const failedIndexId = await singleSessionIndexPhase(harness, failedSession, "error");
      const otherSession = await harness.create("runtime-independent", "runtime-independent-probe");
      await harness.waitUntil(() => successfulRows(harness, otherSession));
      // 成功头部不足以证明隔离：另一会话必须恰好收到自己的唯一完整正文。
      assert.deepEqual(
        [...harness.rows(otherSession).values()]
          .filter((row) => row.kind === "assistantText")
          .map((row) => ({ text: row.text, state: row.state })),
        [{ text: "RUNTIME_INDEPENDENT_DONE", state: "complete" }],
      );
      assert.equal(failedCalls, 1);
      assert.equal(independentCalls, 1);
      assert.deepEqual(
        harness.mock.calls.map((call: { context: ModelContext }) => latestInput(call.context).text),
        ["runtime-provider-failure", "runtime-independent-probe"],
        "两个会话必须各对应恰一次实际 HTTP 请求，顺序正确且不能重试或串线",
      );
      assert.notEqual(otherSession, failedSession);
      await harness.waitUntil(() => indexSessions(harness).size === 2);
      const listed = sessionListSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionList, {}),
      );
      assert.equal(listed.sessions.length, 2);
      assert.deepEqual(
        [...indexSessions(harness).keys()].sort(),
        listed.sessions.map((session) => session.sessionId).sort(),
      );
      const resubscribe = v4ConversationSubscribeResultSchema.parse(
        await harness.request("v4/conversation/subscribe", {
          topic: `conversation/${failedSession}`,
          connectionId: "runtime-error-replay",
          clientMode: "web-remote-replayable",
        }),
      );
      await harness.waitUntil(() =>
        harness
          .conversationFrames(failedSession)
          .some(
            (frame) =>
              frame.subscriptionId === resubscribe.ack.subscriptionId &&
              frame.payload.kind === "snapshot",
          ),
      );
      const control = sessionControlSchema.parse(harness.state(failedSession).control);
      assert.equal(
        control.phase,
        "error",
        "agentInvoked prompt_result must not overwrite provider failure",
      );
      assert.equal(control.lastError?.code, "omp_provider_401");
      assert.match(
        control.lastError?.message ?? "",
        /401 Model not supported: runtime-provider-failure/u,
      );
      assert.equal(harness.terminal(failedSession)?.state, "failed");
      assert.equal(indexSessions(harness).get(failedIndexId), "error");
      assert.ok(
        ![...harness.rows(failedSession).values()].some(
          (row) => row.text === "RUNTIME_INDEPENDENT_DONE",
        ),
      );
      assert.ok(![...harness.rows(otherSession).values()].some((row) => row.state === "failed"));
      assert.deepEqual(
        [...harness.rows(otherSession).values()]
          .filter((row) => row.kind === "userInput")
          .map((row) => row.text),
        ["runtime-independent-probe"],
        "独立会话不能显示失败会话的用户输入",
      );
      assert.ok(
        ![...harness.rows(failedSession).values()].some(
          (row) => row.text === "runtime-independent-probe",
        ),
      );
      const independentControl = sessionControlSchema.parse(harness.state(otherSession).control);
      assert.equal(independentControl.phase, "completedSuccess");
      assert.ok(!independentControl.lastError, "独立会话不能继承其他会话的 provider error");
    } finally {
      await harness.close();
    }
  },
);

test(
  "队列按ID删除并提升非队首插话，保留图片、暂停策略和真实冷历史",
  { skip: realOmpSkip, timeout: 180000 },
  async () => {
    const initial = deferred();
    const interjection = deferred();
    const calls: { text: string; images: number }[] = [];
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX/AAAAAP9sof2OAAAAHElEQVR42u3BgQAAAADDoPlTX+EAVQEAAAAAfAYUUAABxFrmKwAAAABJRU5ErkJggg==",
      "base64",
    );
    const harness = await startRealOmpHarness({
      async handler(context: ModelContext, options: { signal?: AbortSignal }) {
        const input = latestInput(context);
        calls.push({ text: input.text, images: input.images.length });
        if (calls.length === 1) {
          assert.equal(input.text, "queue-actions-initial");
          await holdUntilReleased(initial.promise, options.signal);
          return { content: ["QUEUE_INITIAL_DONE"] };
        }
        if (calls.length === 2) {
          assert.equal(input.text, steeringNotice + "hello");
          assert.deepEqual(
            input.images.map((block) => block.source),
            [{ type: "base64", media_type: "image/png", data: bytes.toString("base64") }],
          );
          await holdUntilReleased(interjection.promise, options.signal);
          return { content: ["QUEUE_INTERJECTION_DONE"] };
        }
        assert.equal(calls.length, 3, "删除或重复插话不能额外调用模型");
        assert.equal(input.text, "hello");
        assert.deepEqual(input.images, []);
        return { content: ["QUEUE_FIFO_DONE"] };
      },
    });
    try {
      const sessionId = await createEmpty(harness, "queue-actions");
      await setMode(harness, sessionId, "queue");
      const casCommand = async (id: string, type: string, payload: unknown) => {
        const state = harness.state(sessionId);
        let baseRevision = z.number().parse(state.revision);
        const baseLogEpoch = z.string().parse(state.logEpoch);
        for (let attempt = 0; attempt < 5; attempt++) {
          const ack = await command(harness, sessionId, `${id}-${attempt}`, type, payload, {
            baseRevision,
            baseLogEpoch,
          });
          if (ack.status !== "stale") return ack;
          baseRevision = ack.revisionAtDecision;
        }
        throw new Error("queue action CAS did not converge");
      };
      assert.equal(
        (
          await command(harness, sessionId, "queue-initial", "sendText", {
            text: "queue-actions-initial",
          })
        ).status,
        "accepted",
      );
      await harness.waitUntil(() => calls.length === 1);
      assert.equal(
        (await casCommand("queue-pause", "setAutoDrain", { autoDrain: false })).status,
        "accepted",
      );
      const image = await uploadImage(harness, sessionId, bytes);
      for (let index = 0; index < 3; index++) {
        const ack = await command(harness, sessionId, `queue-item-${index}`, "sendText", {
          text: "hello",
          ...(index === 2 ? { attachments: [image] } : {}),
        });
        assert.equal(ack.status, "accepted");
      }
      const act = (id: string, type: string, queueItemId: string) =>
        casCommand(id, type, { queueItemId });
      const removed = await act("remove-middle", "deleteQueueItem", "queue-item-1");
      assert.equal(removed.status, "accepted");
      assert.equal((await act("remove-again", "deleteQueueItem", "queue-item-1")).status, "noop");
      assert.deepEqual(
        queueStateSchema
          .parse(harness.state(sessionId).queue)
          .items.map((item) => item.queueItemId),
        ["queue-item-0", "queue-item-2"],
      );
      assert.ok(
        [...harness.rows(sessionId).values()].every(
          (row) => row.sourceCommandId !== "queue-item-1",
        ),
      );
      const promoted = await act("promote", "sendQueuedNow", "queue-item-2");
      assert.equal(promoted.status, "accepted");
      assert.equal(
        (await act("promote-again", "sendQueuedNow", "queue-item-2")).reasonCode,
        "fault.command.queueItem.inFlight",
      );
      assert.equal(
        (await act("delete-in-flight", "deleteQueueItem", "queue-item-2")).reasonCode,
        "fault.command.queueItem.inFlight",
      );
      assert.equal(calls.length, 1, "插话接纳不应中断当前模型请求");
      initial.resolve();
      // HTTP 请求可先于 stdio 投影到达；消费断言必须等待权威队列真正移出目标项。
      await harness.waitUntil(
        () =>
          calls.length === 2 &&
          !queueStateSchema
            .parse(harness.state(sessionId).queue)
            .items.some((item) => item.queueItemId === "queue-item-2"),
      );
      const queue = queueStateSchema.parse(harness.state(sessionId).queue);
      assert.equal(queue.autoDrain, false);
      assert.deepEqual(
        queue.items.map((item) => item.queueItemId),
        ["queue-item-0"],
      );
      interjection.resolve();
      await harness.waitUntil(
        () =>
          sessionControlSchema.parse(harness.state(sessionId).control).phase === "completedSuccess",
      );
      assert.equal((await act("idle-send", "sendQueuedNow", "queue-item-0")).status, "accepted");
      await harness.waitUntil(
        () =>
          calls.length === 3 &&
          queueStateSchema.parse(harness.state(sessionId).queue).items.length === 0 &&
          sessionControlSchema.parse(harness.state(sessionId).control).phase === "completedSuccess",
      );
      assert.ok(harness.mock.requests.every((request: { aborted: boolean }) => !request.aborted));
      const listed = sessionListSchema.parse(
        await harness.request(zcodeProtocolMethods.sessionList, {}),
      );
      const stableId = z.uuid().parse(listed.sessions[0]?.sessionId);
      await harness.request("session/close", { sessionId: stableId });
      const before = harness.conversationFrames(stableId).length;
      await harness.subscribe(stableId);
      const cold = await harness.waitUntil(() =>
        harness
          .conversationFrames(stableId)
          .slice(before)
          .find((frame) => frame.payload.kind === "snapshot"),
      );
      assert.equal(cold.payload.kind, "snapshot");
      if (cold.payload.kind !== "snapshot") throw new Error("missing cold snapshot");
      assert.equal(cold.payload.snapshot.queue.items.length, 0);
      assert.equal(
        cold.payload.snapshot.rows.window.filter(
          (row) => row.kind === "userInput" && row.text.endsWith("hello"),
        ).length,
        2,
      );
      assert.equal(calls.length, 3, "冷恢复不能重放已删除或已消费输入");
    } finally {
      initial.resolve();
      interjection.resolve();
      await harness.close();
    }
  },
);
