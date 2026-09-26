import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationTopicPublisher } from "../src/app/topicPublisher.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";

const waitFlush = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test("手机饱和连接按水位追帧，桌面持续收到在线帧", async () => {
  const frames: { subscriptionId: string; deliveryKind: string }[] = [];
  const projection = new ConversationProjection("session");
  const publisher = new ConversationTopicPublisher("session", projection, {
    emitFrame(frame) {
      frames.push(frame as { subscriptionId: string; deliveryKind: string });
    },
    async requestUserInput() {
      return { action: "cancel" };
    },
  });
  const desktop = publisher.subscribe({
    connectionId: "desktop",
    clientMode: "desktop-continuous",
  });
  const mobile = publisher.subscribe({
    connectionId: "mobile",
    clientMode: "web-remote-replayable",
  });
  frames.length = 0;
  publisher.setConnectionFlowState("mobile", "saturated");
  projection.beginUserTurn({
    text: "hi",
    inputId: "input",
    sourceCommandId: "cmd",
    clientId: "client",
  });
  publisher.scheduleFlush(() => {});
  await waitFlush();
  assert.equal(
    frames.some((frame) => frame.subscriptionId === desktop.subscriptionId),
    true,
  );
  assert.equal(
    frames.some((frame) => frame.subscriptionId === mobile.subscriptionId),
    false,
  );
  publisher.setConnectionFlowState("mobile", "drained");
  assert.equal(
    frames.some(
      (frame) => frame.subscriptionId === mobile.subscriptionId && frame.deliveryKind === "online",
    ),
    true,
  );
  publisher.setConnectionFlowState("mobile", "closed");
  frames.length = 0;
  projection.setTitle("closed", "custom");
  publisher.scheduleFlush(() => {});
  await waitFlush();
  assert.equal(
    frames.some((frame) => frame.subscriptionId === mobile.subscriptionId),
    false,
  );
  publisher.dispose();
});
