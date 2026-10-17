import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  V4_METHODS,
  commandAckSchema,
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  subscribeAckSchema,
  type ConversationRow,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { createOmpStore } from "../src/adapters/ompStore.js";
import { encodeSessionDirName, sessionsRoot } from "../src/adapters/ompSessionPaths.js";
import { ServerApp } from "../src/app/serverApp.js";
import type { OmpProcessFactory } from "../src/app/ports.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

const stableId = "01a0d66e-1891-7035-ab59-f8e5f0a33703";
const nativeText = "No active goal.";
const normalText = "Read the saved objective and answer normally";
const modelText = "The saved objective is available in this session.";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(context: TestContext, allocatedAtStart: boolean) {
  const root = await mkdtemp(join(tmpdir(), "omp-native-first-identity-"));
  const workspacePath = join(root, "workspace");
  const env = { OMP_CONFIG_ROOT: join(root, "omp") };
  await mkdir(workspacePath);
  const journalDirectory = join(sessionsRoot(env), await encodeSessionDirName(workspacePath, env));
  await mkdir(journalDirectory, { recursive: true });
  const journalPath = join(journalDirectory, `2026-10-08T00-00-00-000Z_${stableId}.jsonl`);
  const workspaceKey = `local:${root}`;
  const frames: unknown[] = [];
  const prompts: string[] = [];
  const processes: Array<{ resumed: string | undefined; disposed: boolean }> = [];
  const firstFinished = deferred();
  const releaseFirstAck = deferred();
  const facts = { journalWritten: false };
  const apps: ServerApp[] = [];
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  context.after(async () => {
    releaseFirstAck.resolve();
    await Promise.all(apps.map((app) => app.dispose()));
    await rm(root, { recursive: true, force: true });
  });

  function createApp() {
    const store = createOmpStore(env);
    const ompFactory: OmpProcessFactory = {
      create(options) {
        const process = { resumed: options.resumeSessionPath, disposed: false };
        processes.push(process);
        let sessionFile = options.resumeSessionPath ?? (allocatedAtStart ? journalPath : null);
        return {
          get ompSessionFile() {
            return sessionFile;
          },
          async start() {},
          async refreshState() {
            return null;
          },
          async readContextReport() {
            return null;
          },
          respondUi() {},
          async dispose() {
            process.disposed = true;
          },
          async send(command) {
            if (command.type !== "prompt") return { success: true, data: {} };
            prompts.push(command.message);
            const first = prompts.length === 1;
            const native = command.message === "/goal show";
            if (native) {
              // Native commands emit output without creating a model journal or invoking an agent.
              options.onCommandOutput?.({ text: nativeText });
              options.onPromptResult?.({
                type: "prompt_result",
                agentInvoked: false,
                status: "completed",
              });
            } else {
              sessionFile = journalPath;
              const entries = [
                { type: "session", id: stableId, cwd: workspacePath },
                {
                  type: "message",
                  id: "saved-user",
                  message: { role: "user", content: command.message, timestamp: 1_800_000_000_100 },
                },
                {
                  type: "message",
                  id: "saved-assistant",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: modelText }],
                    timestamp: 1_800_000_000_200,
                  },
                },
              ];
              await writeFile(
                journalPath,
                entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
              );
              facts.journalWritten = true;
              // Mirror the core event sequence, not an echo of the submitted text.
              options.onEvent({ type: "agent_start" });
              options.onEvent({
                type: "message_start",
                message: { role: "assistant", content: [] },
              });
              options.onEvent({
                type: "message_update",
                message: { role: "assistant", content: [] },
                assistantMessageEvent: {
                  type: "text_delta",
                  contentIndex: 0,
                  delta: modelText,
                  partial: { role: "assistant", content: [] },
                },
              });
              options.onEvent({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: modelText }] },
              });
              options.onEvent({ type: "agent_end", messages: [], isTerminal: true });
            }
            if (first) {
              firstFinished.resolve();
              // Hold the command ACK while the completed turn reaches the real index publisher.
              await releaseFirstAck.promise;
            }
            return { success: true, data: { agentInvoked: !native } };
          },
        };
      },
    };
    const app = new ServerApp({
      workspacePath,
      workspaceKey,
      workspaceIdentity: workspaceKey,
      store,
      ompFactory,
      directory: createDirectoryStub(),
      loadWorkspaceConfig: async () => ({ configOptions: [], slashCommands: [] }),
      loadWorkspaceSkillCommands: async () => [],
      gateway: {
        emitFrame: (frame) => frames.push(frame),
        requestUserInput: async () => ({ action: "cancel" }),
      },
    });
    apps.push(app);
    return { app, store };
  }

  return {
    createApp,
    frames,
    processes,
    prompts,
    workspaceKey,
    journalPath,
    firstFinished: firstFinished.promise,
    releaseFirstAck: releaseFirstAck.resolve,
    facts,
    flush: () => {
      // Advance both production batching windows without sleeps or private-state mutation.
      context.mock.timers.tick(30);
      context.mock.timers.tick(500);
    },
  };
}

function indexState(frames: unknown[], topic: string) {
  const sessions = new Map<string, SessionSummary>();
  for (const raw of frames) {
    const parsed = sessionsIndexTopicWireFrameSchema.safeParse(raw);
    if (!parsed.success || parsed.data.topic !== topic) continue;
    const wire = parsed.data;
    assert.equal(wire.kind, "complete", "small fixture index frames must be complete");
    if (wire.kind !== "complete") throw new Error("expected complete index frame");
    const payload = wire.frame.payload;
    if (payload.kind === "snapshot") {
      sessions.clear();
      for (const session of payload.snapshot.sessions) sessions.set(session.sessionId, session);
    } else {
      for (const delta of payload.deltas) {
        if (delta.op === "session.upserted") sessions.set(delta.session.sessionId, delta.session);
        if (delta.op === "session.removed") sessions.delete(delta.sessionId);
      }
    }
  }
  return sessions;
}

async function subscribe(
  app: ServerApp,
  frames: unknown[],
  sessionId: string,
  mode: "desktop-continuous" | "web-remote-replayable",
) {
  const start = frames.length;
  const result = (await app.handleRequest(V4_METHODS.conversationSubscribe, {
    topic: `conversation/${sessionId}`,
    connectionId: `${mode}:${sessionId}`,
    clientMode: mode,
  })) as { ack: unknown };
  const ack = subscribeAckSchema.parse(result.ack);
  const wire = frames
    .slice(start)
    .map((frame) => conversationTopicWireFrameSchema.safeParse(frame))
    .find((parsed) => parsed.success && parsed.data.subscriptionId === ack.subscriptionId);
  assert.ok(wire?.success, "ACK subscription must actually deliver a conversation frame");
  if (!wire?.success || wire.data.kind !== "complete")
    throw new Error("expected complete conversation snapshot");
  assert.equal(wire.data.topic, `conversation/${sessionId}`);
  assert.equal(wire.data.frame.payload.kind, "snapshot");
  if (wire.data.frame.payload.kind !== "snapshot") throw new Error("expected snapshot payload");
  const snapshot = conversationSnapshotSchema.parse(wire.data.frame.payload.snapshot);
  assert.equal(snapshot.sessionId, sessionId);
  return { ack, snapshot };
}

function assertHistory(rows: ConversationRow[], nativeFirst: boolean) {
  const texts = rows.filter((row) => row.kind === "assistantText").map((row) => row.text);
  assert.equal(
    texts.filter((text) => text === modelText).length,
    1,
    "model history survives exactly once",
  );
  assert.equal(texts.filter((text) => text === nativeText).length, nativeFirst ? 1 : 0);
}

for (const scenario of [
  "native-allocated-path",
  "native-late-path",
  "draft-native-first",
  "ordinary-first",
] as const) {
  test(`native-first identity: ${scenario} converges ACK, live and cold consumers`, async (context) => {
    const nativeFirst = scenario !== "ordinary-first";
    const draftFirst = scenario === "draft-native-first";
    const f = await fixture(context, scenario !== "native-late-path");
    const { app, store } = f.createApp();
    const indexTopic = `sessions-index/${f.workspaceKey}`;
    await app.handleRequest(V4_METHODS.conversationSubscribe, {
      topic: indexTopic,
      connectionId: "index-before-create",
    });
    const request = {
      type: "createSession",
      sessionId: null,
      commandId: "create-first-input",
      clientId: "identity-client",
      issuedAt: 1,
      payload: {
        workspaceId: f.workspaceKey,
        ...(draftFirst ? {} : { firstInput: { text: nativeFirst ? "/goal show" : normalText } }),
      },
    };
    let draftId: string | undefined;
    let draftAck: unknown;
    const nativeRequest = {
      type: "sendText",
      sessionId: "",
      commandId: "native-after-prewarm",
      clientId: "identity-client",
      issuedAt: 2,
      payload: { text: "/goal show" },
    };
    if (draftFirst) {
      draftAck = await app.handleRequest(V4_METHODS.command, request);
      const created = commandAckSchema.parse(draftAck);
      assert.equal(created.status, "accepted");
      if (created.result?.type !== "createSession") throw new Error("expected draft create result");
      draftId = created.result.sessionId;
      nativeRequest.sessionId = draftId;
      const draft = await subscribe(app, f.frames, draftId, "desktop-continuous");
      assert.equal(draft.snapshot.control.phase, "draft");
      assert.equal(f.processes.length, 0, "prewarm remains lazy");
      assert.equal(indexState(f.frames, indexTopic).size, 0, "draft is not a sidebar item");
    }
    let firstAckReceived = false;
    const pendingFirst = app
      .handleRequest(V4_METHODS.command, draftFirst ? nativeRequest : request)
      .then((ack) => {
        firstAckReceived = true;
        return ack;
      });
    await f.firstFinished;
    f.flush();
    assert.equal(firstAckReceived, false, "terminal index delivery precedes the first input ACK");
    assert.equal(
      f.facts.journalWritten,
      !nativeFirst,
      "native completion must not invent a model journal",
    );
    const beforeAck = indexState(f.frames, indexTopic);
    assert.equal(beforeAck.size, 1, "completed first input is indexed before its command ACK");
    assert.equal([...beforeAck.values()][0]?.phase, "completedSuccess");
    const indexedBeforeAck = [...beforeAck.keys()][0]!;
    if (scenario !== "native-late-path") assert.equal(indexedBeforeAck, stableId);
    else assert.match(indexedBeforeAck, /^omp-session-/);

    f.releaseFirstAck();
    const firstAck = commandAckSchema.parse(await pendingFirst);
    assert.equal(firstAck.status, "accepted");
    let ackId: string;
    if (draftFirst) {
      assert.equal(firstAck.result?.type, "inputAccepted");
      ackId = draftId!;
      assert.deepEqual(await app.handleRequest(V4_METHODS.command, request), draftAck);
      assert.deepEqual(await app.handleRequest(V4_METHODS.command, nativeRequest), firstAck);
    } else {
      if (firstAck.result?.type !== "createSession")
        throw new Error("expected createSession result");
      ackId = firstAck.result.sessionId;
      // A host inserts its newly created task by this ID: returning a removed temporary ID
      // resurrects a duplicate sidebar row even though the index itself has only one row.
      assert.equal(
        ackId,
        indexedBeforeAck,
        "create ACK must name the settled, visible index identity",
      );
      assert.deepEqual(
        await app.handleRequest(V4_METHODS.command, request),
        firstAck,
        "retry reuses the same ACK",
      );
    }
    const owner = app.registry.requireEngine(ackId);
    const initial = await subscribe(app, f.frames, ackId, "desktop-continuous");
    assert.equal(initial.snapshot.control.phase, "completedSuccess");
    if (nativeFirst) {
      assert.ok(
        initial.snapshot.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === nativeText,
        ),
      );
      const sent = commandAckSchema.parse(
        await app.handleRequest(V4_METHODS.command, {
          type: "sendText",
          sessionId: ackId,
          commandId: "ordinary-after-native",
          clientId: "identity-client",
          issuedAt: 2,
          payload: { text: normalText },
        }),
      );
      assert.equal(sent.status, "accepted");
      assert.equal(sent.result?.type, "inputAccepted");
    }
    f.flush();
    await store.flushCommandOutputs!();
    await app.registry.onProjectSessionsChanged();
    f.flush();
    assert.deepEqual([...indexState(f.frames, indexTopic).keys()], [stableId]);
    assert.deepEqual(
      (await store.listSessions(owner.workspacePath)).map((session) => session.sessionId),
      [stableId],
    );
    assert.deepEqual(
      (await app.registry.listLegacySessions(owner.workspacePath, f.workspaceKey)).map(
        (session) => session.sessionId,
      ),
      [stableId],
    );
    assert.equal(app.registry.requireEngine(stableId), owner);
    assert.equal(app.registry.requireEngine(ackId), owner);
    const stable = await subscribe(app, f.frames, stableId, "web-remote-replayable");
    assertHistory(stable.snapshot.rows.window, nativeFirst);
    await app.handleRequest(V4_METHODS.conversationResync, {
      topic: `conversation/${ackId}`,
      subscriptionId: initial.ack.subscriptionId,
      forceSnapshot: true,
    });
    const recovered = conversationTopicWireFrameSchema.parse(f.frames.at(-1));
    assert.equal(
      recovered.topic,
      `conversation/${ackId}`,
      "original Desktop subscription remains usable after migration",
    );
    assert.equal(recovered.deliveryKind, "recovery");
    if (recovered.kind !== "complete" || recovered.frame.payload.kind !== "snapshot")
      throw new Error("expected recovery snapshot");
    assertHistory(recovered.frame.payload.snapshot.rows.window, nativeFirst);
    const page = (await app.handleRequest(V4_METHODS.conversationRowsRange, {
      sessionId: ackId,
      limit: 100,
    })) as { rows: ConversationRow[] };
    assertHistory(page.rows, nativeFirst);
    assert.equal(
      f.processes.length,
      1,
      "ACK, stable ID and both delivery modes share one process owner",
    );
    assert.deepEqual(f.prompts, nativeFirst ? ["/goal show", normalText] : [normalText]);

    await app.dispose();
    assert.equal(f.processes[0]?.disposed, true);
    const cold = f.createApp();
    const restored = await Promise.all([
      subscribe(cold.app, f.frames, ackId, "desktop-continuous"),
      subscribe(cold.app, f.frames, stableId, "web-remote-replayable"),
    ]);
    for (const result of restored) assertHistory(result.snapshot.rows.window, nativeFirst);
    const coldOwner = cold.app.registry.requireEngine(stableId);
    assert.equal(cold.app.registry.requireEngine(ackId), coldOwner);
    await coldOwner.ensureOmpStarted();
    assert.equal(
      f.processes.length,
      2,
      "cold alias and canonical subscriptions create only one new process",
    );
    assert.equal(f.processes[1]?.resumed, f.journalPath);
    assert.equal(f.processes.filter((process) => !process.disposed).length, 1);
    await cold.app.handleRequest(V4_METHODS.conversationSubscribe, {
      topic: indexTopic,
      connectionId: "cold-index",
    });
    await cold.app.registry.onProjectSessionsChanged();
    assert.deepEqual([...indexState(f.frames, indexTopic).keys()], [stableId]);
    assert.deepEqual(
      f.prompts,
      nativeFirst ? ["/goal show", normalText] : [normalText],
      "cold recovery never replays inputs",
    );
  });
}
