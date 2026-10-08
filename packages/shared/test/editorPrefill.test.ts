import assert from "node:assert/strict";
import { test } from "node:test";
import { userInputRequestPayloadSchema } from "../src/zcode-protocol-v4/snapshot.js";
import { conversationTopicFrameSchema } from "../src/zcode-protocol-v4/transport.js";

function frameWithPayload(payload: unknown) {
  return {
    topic: "conversation/editor-session",
    subscriptionId: "editor-subscription",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "deltas",
      deltas: [
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "editor-request",
                kind: "userInput",
                anchorRowId: null,
                createdAt: 1,
                payload,
              },
            ],
          },
        },
      ],
    },
  };
}

test("editor prefill survives conversation topic runtime validation without trimming", () => {
  for (const prefill of ["", "  draft\n第二行  "]) {
    const payload = { kind: "userInput", prompt: "Edit", freeText: true, prefill };
    const frame = conversationTopicFrameSchema.parse(
      JSON.parse(JSON.stringify(frameWithPayload(payload))),
    );
    assert.equal(frame.payload.kind, "deltas");
    if (frame.payload.kind !== "deltas") throw new Error("expected deltas");
    const delta = frame.payload.deltas[0];
    assert.equal(delta?.op, "state.updated");
    if (delta?.op !== "state.updated") throw new Error("expected state updated");
    const projected = delta.patch.pendingInteractions?.[0]?.payload;
    assert.equal(projected?.kind, "userInput");
    if (projected?.kind !== "userInput") throw new Error("expected user input");
    assert.equal(projected.prefill, prefill);
  }
});

test("legacy input without prefill stays valid and malformed prefill is rejected", () => {
  const payload = { kind: "userInput", prompt: "Input", freeText: true };
  assert.deepEqual(userInputRequestPayloadSchema.parse(payload), payload);
  assert.equal(conversationTopicFrameSchema.safeParse(frameWithPayload(payload)).success, true);
  for (const prefill of [null, 42, {}, ["draft"]]) {
    assert.equal(
      conversationTopicFrameSchema.safeParse(frameWithPayload({ ...payload, prefill })).success,
      false,
    );
  }
});
