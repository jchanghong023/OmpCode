import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationSnapshotSchema,
  conversationTopicWireFrameSchema,
  type ConversationTopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/app/topicPublisher.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { rowsFromOmpEntries, transcriptFromOmpEntries } from "../src/domain/coldHistory.js";
import { ompSessionEventFrameSchema } from "../src/domain/ompFrames.js";
import { OmpEventProjector } from "../src/domain/ompProjector.js";
import { mergeOmpCommandOutputHistory } from "../src/domain/OmpCommandOutputHistory.js";

// Native #dispatchCustomMessage sends this shape after persisting custom_message;
// these are protocol regressions, not a substitute for the installed-binary GUI smoke.
const nativeMessage = {
  role: "custom",
  customType: "btw-parent-smoke",
  content: "Isolated native command parent ready",
  display: true,
  timestamp: 1_234,
};
function deliver(
  projector: OmpEventProjector,
  type: "message_start" | "message_end",
  message: unknown,
): void {
  projector.handleEvent(ompSessionEventFrameSchema.parse({ type, message }));
}
function textRows(projection: ConversationProjection) {
  return projection.rowsRange(undefined, 100).rows.filter((row) => row.kind === "assistantText");
}

test("native visible custom string parses and appends once without a model turn", () => {
  const projection = new ConversationProjection("extension-local-command");
  const projector = new OmpEventProjector(projection);
  const initialState = projection.stateSnapshot;
  deliver(projector, "message_start", nativeMessage);
  assert.equal(projection.seq, 0);
  deliver(projector, "message_end", nativeMessage);
  assert.equal(projection.seq, 1);
  assert.equal(projector.isStreaming, false);
  assert.deepEqual(projection.stateSnapshot, initialState);
  assert.equal(projection.activeTurnSourceCommandId(), null);
  assert.deepEqual(
    textRows(projection).map((row) => ({
      text: row.text,
      state: row.state,
      createdAt: row.createdAt,
    })),
    [{ text: nativeMessage.content, state: "complete", createdAt: nativeMessage.timestamp }],
  );
  assert.equal(
    projection.rowsRange(undefined, 100).rows.some((row) => row.kind === "turnHeader"),
    false,
  );
  conversationSnapshotSchema.parse(projection.buildSnapshot());
});

test("hidden custom text and image-only custom content never become UI text", () => {
  const projection = new ConversationProjection("hidden-custom");
  const projector = new OmpEventProjector(projection);
  for (const message of [
    { ...nativeMessage, display: false },
    { ...nativeMessage, display: undefined },
    {
      ...nativeMessage,
      content: [{ type: "image", data: "private-image", mimeType: "image/png" }],
    },
  ]) {
    deliver(projector, "message_start", message);
    deliver(projector, "message_end", message);
  }
  assert.equal(projection.seq, 0);
  assert.deepEqual(textRows(projection), []);
});

test("custom text blocks do not close assistant anchors or alter usage, errors or the running turn", () => {
  const projection = new ConversationProjection("custom-during-stream");
  const projector = new OmpEventProjector(projection);
  projection.beginUserTurn({
    text: "parent",
    inputId: "i",
    sourceCommandId: "c",
    clientId: "client",
  });
  projector.handleEvent({ type: "agent_start" });
  projection.appendAssistantText("before");
  projection.recordTurnError({ code: "parent-error", message: "must remain" });
  const parentState = projection.stateSnapshot;
  const parentError = projection.lastError;
  const assistantRowId = textRows(projection)[0]!.rowId;
  const custom = {
    ...nativeMessage,
    content: [
      { type: "text", text: "plain " },
      { type: "image", data: "must-not-render", mimeType: "image/png" },
      { type: "thinking", thinking: "must-not-leak" },
      { type: "text", text: "extension output" },
    ],
    usage: { input: 9_999, output: 9_999 },
    stopReason: "error",
    errorMessage: "not a model error",
    details: { private: "must-not-leak" },
  };
  deliver(projector, "message_start", custom);
  deliver(projector, "message_end", custom);
  assert.equal(projector.isStreaming, true);
  assert.equal(projection.activeTurnSourceCommandId(), "c");
  assert.deepEqual(projection.stateSnapshot, parentState);
  assert.deepEqual(projection.lastError, parentError);
  projection.appendAssistantText("after");
  const rows = textRows(projection);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => ({ text: row.text, state: row.state })),
    [
      { text: "beforeafter", state: "streaming" },
      { text: "plain extension output", state: "complete" },
    ],
  );
  assert.equal(rows[0]!.rowId, assistantRowId);
  assert.equal(rows[0]!.productTurnId, rows[1]!.productTurnId);
  conversationSnapshotSchema.parse(projection.buildSnapshot());
});

test("cold flat native custom entries and wrapped messages share visibility and text extraction", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "parent", timestamp: 1_000 } },
    {
      ...nativeMessage,
      role: undefined,
      type: "custom_message",
      timestamp: new Date(1_234).toISOString(),
    },
    {
      ...nativeMessage,
      role: undefined,
      type: "custom_message",
      content: "hidden-flat",
      display: false,
    },
    { type: "message", message: { ...nativeMessage, content: "hidden-wrapped", display: false } },
    {
      type: "message",
      message: {
        ...nativeMessage,
        content: [{ type: "text", text: "wrapped text" }],
        timestamp: 2_345,
      },
    },
    {
      ...nativeMessage,
      role: undefined,
      type: "custom_message",
      content: "missing-display",
      display: undefined,
    },
    { type: "custom", customType: "state-only", data: { text: "not display output" } },
  ];
  const rows = rowsFromOmpEntries(entries);
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => ({ text: row.text, createdAt: row.createdAt, state: row.state })),
    [
      { text: nativeMessage.content, createdAt: 1_234, state: "complete" },
      { text: "wrapped text", createdAt: 2_345, state: "complete" },
    ],
  );
  const transcript = transcriptFromOmpEntries(entries);
  assert.match(transcript, /custom: Isolated native command parent ready/);
  assert.match(transcript, /custom: wrapped text/);
  assert.doesNotMatch(transcript, /hidden|missing-display|state-only|not display output/);
  const projection = new ConversationProjection("cold-custom");
  projection.hydrateRows(rows);
  conversationSnapshotSchema.parse(projection.buildSnapshot());
});

test("visible custom output uses the existing desktop and web topic publisher with the same watermark", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const projection = new ConversationProjection("custom-delivery");
  const projector = new OmpEventProjector(projection);
  const frames: ConversationTopicWireFrame[] = [];
  const publisher = new ConversationTopicPublisher("custom-delivery", projection, {
    emitFrame: (frame) => frames.push(conversationTopicWireFrameSchema.parse(frame)),
    async requestUserInput() {
      return { action: "cancel" };
    },
  });
  try {
    const desktop = publisher.subscribe({
      connectionId: "desktop",
      clientMode: "desktop-continuous",
    });
    const web = publisher.subscribe({ connectionId: "web", clientMode: "web-remote-replayable" });
    frames.length = 0;
    deliver(projector, "message_start", nativeMessage);
    deliver(projector, "message_end", nativeMessage);
    publisher.scheduleFlush(() => {});
    context.mock.timers.runAll();
    assert.equal(frames.length, 2);
    for (const subscriptionId of [desktop.subscriptionId, web.subscriptionId]) {
      const wire = frames.find((frame) => frame.subscriptionId === subscriptionId);
      assert.ok(wire && wire.kind === "complete");
      assert.equal(wire.deliveryKind, "online");
      assert.equal(wire.frame.fromSeq, 0);
      assert.equal(wire.frame.toSeq, projection.seq);
      assert.equal(wire.frame.payload.kind, "deltas");
      assert.match(JSON.stringify(wire.frame.payload), /Isolated native command parent ready/);
    }
  } finally {
    publisher.dispose();
  }
});

test("技能上下文不进入桌面/Web 实时正文，用户输入与模型回复仍通过同一投影交付", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const projection = new ConversationProjection("skill-display");
  const projector = new OmpEventProjector(projection);
  const frames: ConversationTopicWireFrame[] = [];
  const publisher = new ConversationTopicPublisher("skill-display", projection, {
    emitFrame: (frame) => frames.push(conversationTopicWireFrameSchema.parse(frame)),
    async requestUserInput() {
      return { action: "cancel" };
    },
  });
  try {
    const subscriptions = [
      publisher.subscribe({ connectionId: "desktop", clientMode: "desktop-continuous" }),
      publisher.subscribe({ connectionId: "web", clientMode: "web-remote-replayable" }),
    ];
    frames.length = 0;
    projection.beginUserTurn({
      text: "/skill:reviewer  参数",
      inputId: "skill-input",
      sourceCommandId: "skill-command",
      clientId: "client",
    });
    for (const attribution of ["user", "agent", undefined]) {
      const skill = {
        ...nativeMessage,
        customType: "skill-prompt",
        attribution,
        content: "PRIVATE_SKILL_BODY",
        details: { name: "reviewer", prompt: "/skill:reviewer  参数" },
      };
      deliver(projector, "message_start", skill);
      deliver(projector, "message_end", skill);
    }
    projection.appendAssistantText("VISIBLE_MODEL_REPLY");
    publisher.scheduleFlush(() => {});
    context.mock.timers.runAll();
    const snapshot = projection.buildSnapshot();
    conversationSnapshotSchema.parse(snapshot);
    assert.deepEqual(
      snapshot.rows.window.filter((row) => row.kind === "userInput").map((row) => row.text),
      ["/skill:reviewer  参数"],
    );
    for (const { subscriptionId } of subscriptions) {
      const wire = frames.find((frame) => frame.subscriptionId === subscriptionId);
      assert.ok(wire, "两种链路都必须收到用户调用和模型回复");
      assert.match(JSON.stringify(wire), /VISIBLE_MODEL_REPLY/);
      assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_SKILL_BODY/);
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_SKILL_BODY/);
  } finally {
    publisher.dispose();
  }
});

test("技能冷历史仅恢复调用元数据，旧派生全文、自动注入与缺失元数据均不泄露正文", () => {
  const entry = (attribution: string | undefined, details?: unknown) => ({
    type: "custom_message",
    customType: "skill-prompt",
    content: "PRIVATE_SKILL_BODY",
    display: true,
    attribution,
    details,
    timestamp: 2,
  });
  const entries = [
    entry("user", { name: "reviewer", args: "  legacy 参数" }),
    { type: "message", message: { role: "assistant", content: "FIRST_REPLY", timestamp: 3 } },
    { type: "message", message: { ...entry("user"), role: "custom", timestamp: 4 } },
    { type: "message", message: { role: "assistant", content: "SECOND_REPLY", timestamp: 5 } },
    entry("agent", { name: "autoload" }),
    entry(undefined, { name: "autoload" }),
    {
      type: "message",
      message: {
        ...entry("user", {
          prompt: "请用 /skill:reviewer  检查代码",
          args: "not the submitted prompt",
        }),
        role: "custom",
        timestamp: 6,
      },
    },
    { type: "message", message: { role: "assistant", content: "THIRD_REPLY", timestamp: 7 } },
  ];
  const outputs = [
    { id: "old-skill", customType: "skill-prompt", text: "PRIVATE_SKILL_BODY", createdAt: 2 },
    { id: "ordinary", text: "VISIBLE_COMMAND_OUTPUT", createdAt: 8 },
  ];
  const rows = mergeOmpCommandOutputHistory(rowsFromOmpEntries(entries), outputs, entries);
  assert.deepEqual(
    rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    ["/skill:reviewer   legacy 参数", "请用 /skill:reviewer  检查代码"],
  );
  const replies = rows.filter((row) => row.kind === "assistantText");
  assert.deepEqual(
    replies.map((row) => row.text),
    ["FIRST_REPLY", "SECOND_REPLY", "THIRD_REPLY", "VISIBLE_COMMAND_OUTPUT"],
  );
  assert.notEqual(replies[0]!.turnId, replies[1]!.turnId, "元数据缺失仍保留轮边界");
  assert.notEqual(replies[1]!.turnId, replies[2]!.turnId);
  assert.doesNotMatch(transcriptFromOmpEntries(entries), /PRIVATE_SKILL_BODY/);
  assert.match(transcriptFromOmpEntries(entries), /user: 请用 \/skill:reviewer  检查代码/);
});
