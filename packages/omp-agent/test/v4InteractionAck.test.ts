import assert from "node:assert/strict";
import { test } from "node:test";
import { V4CommandService, type V4CommandContext } from "../src/app/v4Commands.js";

test("late interaction reply is an idempotent noop", async () => {
  const engine = {
    projection: { revision: 1, resolvePendingInteraction() {} },
    settleInteraction: () => false,
  };
  const context = {
    workspaceId: "workspace",
    workspacePath: ".",
    attachments: {},
    registry: { getEngine: () => engine, requireEngine: () => engine },
  } as unknown as V4CommandContext;
  const commands = new V4CommandService(context);
  const ack = await commands.handle({
    commandId: "reply",
    clientId: "client",
    sessionId: "session",
    type: "resolveInteraction",
    payload: { interactionId: "finished", answer: { action: "cancel" } },
    issuedAt: Date.now(),
  });
  assert.equal(ack.status, "noop");
  assert.equal(ack.reasonCode, "proto.alreadyResolved");
});
