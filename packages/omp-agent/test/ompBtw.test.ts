import assert from "node:assert/strict";
import { test } from "node:test";
import { ServerApp } from "../src/app/serverApp.js";
import type { OmpCommandFrame, OmpStateData } from "../src/domain/ompFrames.js";
import type { OmpBtwRecord } from "../src/domain/OmpBtwFrames.js";
import type { OmpProcessFactory, OmpSessionProcess } from "../src/app/ports.js";
import { commandAckSchema, conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { createDirectoryStub } from "./fixtures/directoryStub.js";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

function identity(ack: CommandAck) {
  assert.ok(ack.result && "sessionId" in ack.result, "missing accepted session identity");
  return ack.result;
}

function fixture(unsupported = false, terminalBeforeResponse = false) {
  const frames: unknown[] = [];
  const disk = new Map<string, OmpBtwRecord[]>();
  const processes: Array<{
    process: OmpSessionProcess;
    emit: NonNullable<Parameters<OmpProcessFactory["create"]>[0]["onBtwFrame"]>;
    sent: OmpCommandFrame[];
  }> = [];
  const factory: OmpProcessFactory = {
    create(options) {
      const uuid = `${String(processes.length + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
      const path = options.resumeSessionPath ?? `/workspace/2026-10-08T00-00-00-000Z_${uuid}.jsonl`;
      if (!disk.has(path)) disk.set(path, []);
      const records = disk.get(path)!;
      const sent: OmpCommandFrame[] = [];
      const emit = options.onBtwFrame!;
      const state: OmpStateData = {
        sessionFile: path,
        model: { provider: "parent", id: "model" },
        thinkingLevel: "off",
        isStreaming: false,
      };
      const process: OmpSessionProcess = {
        ompSessionFile: path,
        async start() {},
        async refreshState() {
          return state;
        },
        async readContextReport() {
          return null;
        },
        respondUi() {},
        async dispose() {},
        async send(command) {
          sent.push(command);
          if (unsupported && command.type === "get_btw_history")
            return { success: false, error: "Unknown command: get_btw_history" };
          if (command.type === "get_subagents") return { success: true, data: { subagents: [] } };
          if (command.type === "get_btw_history")
            return { success: true, data: { records: structuredClone(records) } };
          if (command.type === "btw") {
            if (records.some((record) => (record.followUps?.at(-1) ?? record).status === "running"))
              return { success: false, error: "A /btw question is still running; cancel it first" };
            const turn = {
              question: command.question,
              answer: "",
              status: "running" as const,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            let record = command.recordId
              ? records.find((item) => item.id === command.recordId)
              : undefined;
            if (command.recordId && !record) return { success: false, error: "Unknown /btw topic" };
            if (record) record.followUps = [...(record.followUps ?? []), turn];
            else {
              record = { ...turn, id: `topic-${records.length + 1}`, leafId: null };
              records.unshift(record);
            }
            emit({ type: "btw_record", record: structuredClone(record) });
            const admission = structuredClone(record);
            if (terminalBeforeResponse) {
              const latest = record.followUps?.at(-1) ?? record;
              latest.answer = "same stdout chunk";
              latest.status = "complete";
              emit({ type: "btw_delta", recordId: record.id, delta: latest.answer });
              emit({ type: "btw_record", record: structuredClone(record) });
            }
            return { success: true, data: { record: admission } };
          }
          if (command.type === "btw_cancel") {
            const record = records.find((item) => item.id === command.recordId);
            const latest = record && (record.followUps?.at(-1) ?? record);
            if (!latest || latest.status !== "running")
              return { success: true, data: { cancelled: false } };
            latest.status = "cancelled";
            emit({ type: "btw_record", record: structuredClone(record!) });
            return { success: true, data: { cancelled: true } };
          }
          return { success: true, data: {} };
        },
      };
      processes.push({ process, emit, sent });
      return process;
    },
  };
  const app = new ServerApp({
    ompFactory: factory,
    gateway: {
      emitFrame: (frame) => frames.push(frame),
      async requestUserInput() {
        return { action: "cancel" };
      },
    },
    store: {
      async listSessions() {
        return [...disk.keys()].map((path) => ({
          sessionId: path.match(/([\da-f-]{36})\.jsonl$/)![1]!,
          sessionPath: path,
          title: null,
          firstUserText: null,
          createdAt: 1,
          updatedAt: 1,
        }));
      },
      async readSessionEntries() {
        return [];
      },
      async readSubagentEntries() {
        return [];
      },
      async deleteSession() {
        return true;
      },
    },
    workspaceKey: "workspace",
    workspacePath: "/workspace",
    directory: createDirectoryStub(),
    async loadWorkspaceConfig() {
      return { configOptions: [], slashCommands: [] };
    },
    async loadWorkspaceSkillCommands() {
      return [];
    },
  });
  let ordinal = 0;
  const command = async (
    type: string,
    sessionId: string | null,
    payload: unknown = {},
    commandId = `cmd-${++ordinal}`,
  ) =>
    commandAckSchema.parse(
      await app.handleRequest("v4/command", {
        type,
        sessionId,
        payload,
        commandId,
        clientId: "client",
        issuedAt: Date.now(),
        baseRevision: 0,
        baseLogEpoch: "test",
      }),
    );
  const snapshot = async (
    id: string,
    mode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
  ) => {
    await app.handleRequest("v4/conversation/subscribe", {
      topic: `conversation/${id}`,
      connectionId: `conn-${++ordinal}`,
      clientMode: mode,
    });
    const frame = frames.at(-1) as { frame: { payload: { snapshot: unknown } } };
    return conversationSnapshotSchema.parse(frame.frame.payload.snapshot);
  };
  const createParent = async () => {
    const ack = await command("createSession", null, { workspaceId: "workspace" });
    assert.equal(ack.result?.type, "createSession");
    return identity(ack).sessionId;
  };
  const finish = (index: number, answer: string, status: "complete" | "error" = "complete") => {
    const entry = processes[index]!;
    const record = disk
      .get(entry.process.ompSessionFile!)!
      .find((item) => (item.followUps?.at(-1) ?? item).status === "running")!;
    const latest = record.followUps?.at(-1) ?? record;
    entry.emit({ type: "btw_delta", recordId: record.id, delta: answer });
    latest.answer = answer;
    latest.status = status;
    if (status === "error") latest.error = "provider failed";
    entry.emit({ type: "btw_record", record: structuredClone(record) });
  };
  return { app, processes, command, snapshot, createParent, finish };
}

test("public v4 empty → native BTW stream → same-topic followup → side-only stop → cold history", async () => {
  const f = fixture();
  try {
    const parent = await f.createParent();
    const empty = await f.command("createSelectionSideSession", parent);
    assert.equal(empty.status, "accepted");
    const draft = identity(empty).sessionId;
    assert.equal(f.processes[0]!.sent.filter((frame) => frame.type === "btw").length, 0);
    assert.equal((await f.snapshot(draft)).rows.window.length, 0);
    const primary = f.app.registry.requireEngine(parent);
    primary.projector.handleEvent({ type: "agent_start" });
    assert.equal(primary.projector.isStreaming, true);
    const parentRows = structuredClone((await f.snapshot(parent)).rows.window);
    const first = await f.command("sendText", draft, { text: "first question" }, "question-1");
    const id = identity(first).sessionId;
    assert.equal(first.status, "accepted");
    assert.equal((await f.snapshot(id)).control.phase, "running");
    f.finish(0, "streamed answer");
    assert.equal((await f.snapshot(id)).control.phase, "completedSuccess");
    assert.equal(
      (await f.snapshot(id)).rows.window.find((row) => row.kind === "assistantText")?.text,
      "streamed answer",
    );
    const duplicate = await f.command("sendText", draft, { text: "first question" }, "question-1");
    assert.deepEqual(duplicate, first);
    assert.equal(f.processes[0]!.sent.filter((frame) => frame.type === "btw").length, 1);
    const followup = await f.command("sendText", id, { text: "follow up" });
    assert.equal(identity(followup).sessionId, id);
    const followupFrame = f.processes[0]!.sent.filter((frame) => frame.type === "btw").at(-1)!;
    assert.equal(followupFrame.type === "btw" && followupFrame.recordId, "topic-1");
    assert.equal((await f.command("stop", id)).status, "accepted");
    assert.equal(
      f.processes[0]!.sent.some((frame) => frame.type === "abort"),
      false,
    );
    assert.equal(primary.projector.isStreaming, true, "side cancel changed primary run");
    const cancelled = await f.snapshot(id, "web-remote-replayable");
    assert.equal(cancelled.control.phase, "completedInterrupted");
    assert.equal(cancelled.rows.window.filter((row) => row.kind === "userInput").length, 2);
    assert.deepEqual((await f.snapshot(parent)).rows.window, parentRows);
    await f.app.registry.closeSession(parent);
    const stableParent = identity(first).parentSessionId;
    assert.ok(stableParent);
    const discovery = await f.command("createSelectionSideSession", stableParent, {
      restoreSaved: true,
    });
    assert.deepEqual(identity(discovery).sideSessionIds, [id]);
    assert.equal(
      (await f.snapshot(id)).rows.window.filter((row) => row.kind === "userInput").length,
      2,
    );
  } finally {
    await f.app.dispose();
  }
});

test("parent/tab isolation, independent model rejection, real errors and old-core capability errors", async () => {
  const f = fixture();
  try {
    const parentA = await f.createParent();
    const parentB = await f.createParent();
    const a = await f.command("createSelectionSideSession", parentA, { firstInput: { text: "a" } });
    const b = await f.command("createSelectionSideSession", parentB, { firstInput: { text: "b" } });
    const idA = identity(a).sessionId;
    const idB = identity(b).sessionId;
    assert.notEqual(idA, idB);
    assert.equal((await f.command("stop", idA)).status, "accepted");
    assert.equal((await f.snapshot(idB)).control.phase, "running");
    f.finish(1, "partial", "error");
    assert.equal((await f.snapshot(idB)).control.lastError?.message, "provider failed");
    const rejected = await f.command("sendText", idB, {
      text: "invalid model",
      modelSelection: { providerId: "other", modelId: "model" },
    });
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.message!, /parent model/);
    assert.equal(f.processes[1]!.sent.filter((frame) => frame.type === "btw").length, 1);
    assert.equal((await f.command("compact", idB, {}, "compact-side")).status, "rejected");
  } finally {
    await f.app.dispose();
  }
  const old = fixture(true);
  try {
    const parent = await old.createParent();
    const ack = await old.command("createSelectionSideSession", parent);
    assert.equal(ack.status, "rejected");
    assert.equal(ack.reasonCode, "fault.command.sideSessionCapabilityMissing");
  } finally {
    await old.app.dispose();
  }
});

test("native terminal before admission continuation never regresses to running", async () => {
  const f = fixture(false, true);
  try {
    const parent = await f.createParent();
    const ack = await f.command("createSelectionSideSession", parent, {
      firstInput: { text: "race" },
    });
    assert.equal(ack.status, "accepted");
    const projection = await f.snapshot(identity(ack).sessionId);
    assert.equal(projection.control.phase, "completedSuccess");
    assert.equal(projection.control.canStop, false);
    assert.ok(
      projection.rows.window.some(
        (row) => row.kind === "assistantText" && row.text === "same stdout chunk",
      ),
    );
  } finally {
    await f.app.dispose();
  }
});
