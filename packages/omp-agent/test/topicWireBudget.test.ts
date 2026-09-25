import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { TopicWireFrameAssembler } from "../../shared/src/zcode-protocol-v4/wire-assembler.js";
import { measureTopicNotificationEnvelopeBytes } from "../../shared/src/zcode-protocol-v4/wire-codec.js";
import { ConversationTopicPublisher } from "../src/app/topicPublisher.js";
import type { ConversationProjection } from "../src/domain/conversationProjection.js";
import type { HostGateway } from "../src/app/ports.js";
import type { TopicWireFrameCandidate } from "../../shared/src/zcode-protocol-v4/wire.js";

test("large topic frame uses the receiver's physical budget and reassembles", () => {
  const wires: TopicWireFrameCandidate[] = [];
  const snapshot = { seq: 1, text: "x".repeat(800_000) };
  const projection = {
    seq: 1,
    logEpoch: "epoch",
    drainPendingDeltas: () => {},
    buildSnapshot: () => snapshot,
  } as unknown as ConversationProjection;
  const gateway = {
    emitFrame: (wire: TopicWireFrameCandidate) => {
      wires.push(wire);
    },
  } as HostGateway;
  const publisher = new ConversationTopicPublisher("session", projection, gateway);
  const { subscriptionId } = publisher.subscribe({
    connectionId: "connection",
    clientMode: "desktop-continuous",
  });
  assert.ok(wires.length > 1);
  assert.ok(
    wires.every((wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes <= 1024 * 1024),
  );
  const assembler = new TopicWireFrameAssembler(
    z.object({
      topic: z.string(),
      subscriptionId: z.string(),
      fromSeq: z.number(),
      toSeq: z.number(),
      sentAt: z.number(),
      payload: z.object({
        kind: z.literal("snapshot"),
        snapshot: z.object({ seq: z.number(), text: z.string() }),
      }),
    }),
  );
  const events = wires.flatMap((wire) => assembler.accept(wire));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "complete",
    frame: {
      topic: "conversation/session",
      subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: (events[0] as { frame: { sentAt: number } }).frame.sentAt,
      payload: { kind: "snapshot", snapshot },
    },
    deliveryKind: "initial",
  });
});
