import assert from "node:assert/strict";
import test from "node:test";
import { zcodeSessionStateSnapshotSchema } from "@zcode/shared";
import { ConversationEngine } from "../src/app/conversationEngine.js";
import { buildLegacySnapshot } from "../src/app/legacySnapshot.js";
import type { HostGateway } from "../src/app/ports.js";

function toolSnapshot(status: "error" | "completed", outputText: string) {
  const engine = new ConversationEngine({
    sessionId: "saved-session",
    workspaceId: "workspace",
    workspacePath: "C:/test-workspace",
    gateway: {
      emitFrame() {},
      requestUserInput: async () => ({ action: "cancel" }),
    } as HostGateway,
    onIndexChange() {},
  });
  engine.projection.beginUserTurn({
    text: "read agent results",
    inputId: "input",
    sourceCommandId: "command",
    clientId: "test",
    routing: "startNow",
  });
  engine.projection.upsertToolCall({
    toolCallId: "wait-1",
    toolName: "wait",
    status,
    input: { ids: ["agent-1"] },
    outputText,
  });
  engine.projection.finishTurn("success");
  const snapshot = zcodeSessionStateSnapshotSchema.parse(
    buildLegacySnapshot({
      engine,
      workspaceKey: "workspace",
      workspacePath: engine.workspacePath,
    }),
  );
  const part = snapshot.messages
    .flatMap((message) => message.parts)
    .find((item) => item.type === "tool");
  assert.ok(part && part.type === "tool");
  return { snapshot, state: part.state };
}

test("failed wait tool remains schema-valid in read/resume snapshot and retains its actual failure body", () => {
  const body = "Agent agent-1 failed: tool execution was rejected.";
  const { snapshot, state } = toolSnapshot("error", body);
  assert.equal(snapshot.session.sessionId, "saved-session");
  assert.equal(state.status, "error");
  assert.deepEqual(state.input, { ids: ["agent-1"] });
  assert.ok(state.status === "error");
  assert.equal(state.error, body);
  assert.equal("output" in state, false);
});

test("failed tool without output retains the existing fallback error text", () => {
  const { state } = toolSnapshot("error", "");
  assert.ok(state.status === "error");
  assert.equal(state.error, "tool error");
  assert.equal("output" in state, false);
});

test("successful tool snapshot keeps the completed output contract", () => {
  const { state } = toolSnapshot("completed", "Agent finished successfully.");
  assert.ok(state.status === "completed");
  assert.equal(state.output, "Agent finished successfully.");
  assert.equal(state.title, "");
  assert.deepEqual(state.metadata, {});
  assert.equal("error" in state, false);
});
