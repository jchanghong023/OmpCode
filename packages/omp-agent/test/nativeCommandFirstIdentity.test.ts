import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  v4ConversationRowsRangeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createOmpStore } from "../src/adapters/ompStore.js";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

const workspaceId = "real-e2e-workspace";
const normalText = "NATIVE_FIRST_NORMAL_INPUT";
const modelText = "NATIVE_FIRST_MODEL_HISTORY";
const continuedText = "NATIVE_FIRST_COLD_CONTINUATION";
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

function envelope(sessionId: string | null, commandId: string, type: string, payload: unknown) {
  return {
    sessionId,
    commandId,
    clientId: "native-first-identity",
    issuedAt: Date.now(),
    type,
    payload,
  };
}

async function snapshot(
  harness: RealOmpHarness,
  sessionId: string,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const result = v4ConversationSubscribeResultSchema.parse(
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: `identity-${clientMode}-${sessionId}`,
      clientMode,
    }),
  );
  return harness.waitUntil(() => {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    for (const frame of harness.frames) {
      if (frame.method !== "v4/conversation/frame") continue;
      const parsed = conversationTopicWireFrameSchema.safeParse(frame.params);
      if (!parsed.success || parsed.data.subscriptionId !== result.ack.subscriptionId) continue;
      assert.equal(parsed.data.topic, `conversation/${sessionId}`);
      for (const event of assembler.accept(parsed.data)) {
        if (event.kind === "fault") assert.fail(JSON.stringify(event.fault));
        if (event.frame.payload.kind === "snapshot") {
          assert.equal(event.frame.payload.snapshot.sessionId, sessionId);
          return event.frame.payload.snapshot;
        }
      }
    }
    return undefined;
  });
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
  assert.equal(row.state, "completedSuccess", JSON.stringify(row));
}

function assertHistory(rows: ConversationRow[], nativeText: string) {
  const texts = rows.filter((row) => row.kind === "assistantText").map((row) => row.text);
  assert.equal(
    texts.filter((text) => text === nativeText).length,
    1,
    "native output survives once",
  );
  assert.equal(texts.filter((text) => text === modelText).length, 1, "model history survives once");
  assert.equal(rows.filter((row) => row.kind === "userInput" && row.text === normalText).length, 1);
}

for (const draftFirst of [false, true]) {
  test(
    `real native-first identity: ${draftFirst ? "draft first send" : "create firstInput"} survives same-root restart`,
    { skip: realOmpSkip },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "omp-native-first-identity-"));
      let harness: RealOmpHarness | undefined;
      try {
        harness = await startRealOmpHarness({ root, responses: [{ content: [modelText] }] });
        await harness.request("v4/conversation/subscribe", {
          topic: `sessions-index/${workspaceId}`,
          connectionId: "native-first-index",
          clientMode: "desktop-continuous",
        });
        const createRequest = envelope(null, "create-first-input", "createSession", {
          workspaceId,
          ...(draftFirst ? {} : { firstInput: { text: "/goal show" } }),
        });
        const createAck = commandAckSchema.parse(
          await harness.request("v4/command", createRequest),
        );
        assert.equal(createAck.status, "accepted");
        assert.equal(createAck.result?.type, "createSession");
        const firstId = z
          .object({ sessionId: z.string().min(1) })
          .parse(createAck.result).sessionId;
        let nativeCommandId = "create-first-input";
        if (draftFirst) {
          const draft = await snapshot(harness, firstId, "desktop-continuous");
          assert.equal(draft.control.phase, "draft");
          const listed = z
            .object({ sessions: z.array(z.unknown()) })
            .parse(await harness.request("session/list", {}));
          assert.equal(listed.sessions.length, 0, "prewarmed draft is not a persisted task");
          nativeCommandId = "native-after-prewarm";
          const ack = commandAckSchema.parse(
            await harness.request(
              "v4/command",
              envelope(firstId, nativeCommandId, "sendText", { text: "/goal show" }),
            ),
          );
          assert.equal(ack.status, "accepted");
        }
        await harness.subscribe(firstId);
        await terminal(harness, firstId, nativeCommandId);
        const nativeRows = [...harness.rows(firstId).values()];
        const nativeTexts = nativeRows.filter((row) => row.kind === "assistantText");
        assert.equal(nativeTexts.length, 1, "the native command has one visible output");
        const nativeText = String(nativeTexts[0]!.text ?? "");
        assert.ok(nativeText.trim(), "the real native command must produce visible output");
        assert.equal(harness.mock.calls.length, 0, "native first input does not invoke a model");
        assert.deepEqual(await harness.request("v4/command", createRequest), createAck);

        // prompt_result/terminal is not the asynchronous session_info identity barrier.
        // Observe the public index's canonical UUID before comparing legacy consumers.
        const active = harness;
        const stableId = await active.waitUntil(() => {
          const ids = indexSessionIds(active);
          return ids.length === 1 && uuidPattern.test(ids[0]!) ? ids[0] : undefined;
        });
        const listed = z
          .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
          .parse(await harness.request("session/list", {}));
        assert.equal(listed.sessions.length, 1, "native completion has one visible identity");
        assert.equal(listed.sessions[0]!.sessionId, stableId);
        if (!draftFirst) assert.equal(firstId, stableId, "firstInput ACK names the settled UUID");

        const sent = commandAckSchema.parse(
          await harness.request(
            "v4/command",
            envelope(firstId, "ordinary-after-native", "sendText", { text: normalText }),
          ),
        );
        assert.equal(
          sent.status,
          "accepted",
          "ordinary input accepts the original creation identity",
        );
        await terminal(harness, firstId, "ordinary-after-native");
        for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
          const live = await snapshot(harness, stableId, mode);
          assertHistory(live.rows.window, nativeText);
        }
        const page = v4ConversationRowsRangeResultSchema.parse(
          await harness.request("v4/conversation/rowsRange", { sessionId: firstId, limit: 100 }),
        );
        assertHistory(page.rows, nativeText);
        assert.equal(harness.mock.calls.length, 1);
        const workspace = harness.workspace;
        await harness.close();
        harness = undefined;

        // Inspect records written by the real core, never manufacture a session ID or journal.
        const stored = await createOmpStore({ OMP_CONFIG_ROOT: join(root, "omp") }).listSessions(
          workspace,
        );
        assert.deepEqual(
          stored.map((session) => session.sessionId),
          [stableId],
        );
        const journal = (await readFile(stored[0]!.sessionPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) =>
            z.looseObject({ type: z.string(), id: z.string().optional() }).parse(JSON.parse(line)),
          );
        assert.ok(journal.some((entry) => entry.type === "session" && entry.id === stableId));

        harness = await startRealOmpHarness({ root, responses: [{ content: [continuedText] }] });
        const recovered = await Promise.all([
          snapshot(harness, stableId, "desktop-continuous"),
          snapshot(harness, stableId, "web-remote-replayable"),
        ]);
        for (const restored of recovered) assertHistory(restored.rows.window, nativeText);
        const coldList = z
          .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
          .parse(await harness.request("session/list", {}));
        assert.deepEqual(
          coldList.sessions.map((session) => session.sessionId),
          [stableId],
        );
        assert.equal(harness.mock.calls.length, 0, "cold recovery never replays the first inputs");
        const resumed = commandAckSchema.parse(
          await harness.request(
            "v4/command",
            envelope(stableId, "cold-continue", "sendText", {
              text: "Continue the saved conversation.",
            }),
          ),
        );
        assert.equal(resumed.status, "accepted");
        await terminal(harness, stableId, "cold-continue");
        assert.ok(
          [...harness.rows(stableId).values()].some(
            (row) => row.kind === "assistantText" && row.text === continuedText,
          ),
        );
        assert.equal(harness.mock.calls.length, 1);
        const context = JSON.stringify(harness.mock.calls[0].context.messages);
        assert.ok(context.includes(normalText), "resumed core receives the persisted user history");
        assert.ok(
          context.includes(modelText),
          "resumed core receives its persisted assistant history",
        );
        const finalList = z
          .object({ sessions: z.array(z.object({ sessionId: z.string() })) })
          .parse(await harness.request("session/list", {}));
        assert.deepEqual(
          finalList.sessions.map((session) => session.sessionId),
          [stableId],
        );
      } finally {
        try {
          await harness?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  );
}
