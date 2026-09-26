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

test("dispatch 在飞期间重复 commandId 共享同一 promise，不重复执行", async () => {
  let stopCalls = 0;
  let release: (() => void) | undefined;
  const engine = {
    projection: { revision: 1 },
    stop: () =>
      new Promise<void>((resolve) => {
        stopCalls += 1;
        release = resolve;
      }),
  };
  const context = {
    workspaceId: "workspace",
    workspacePath: ".",
    attachments: {},
    registry: { getEngine: () => engine, requireEngine: () => engine },
  } as unknown as V4CommandContext;
  const commands = new V4CommandService(context);
  const envelope = {
    commandId: "dup-stop",
    clientId: "client",
    sessionId: "session",
    type: "stop",
    payload: {},
    issuedAt: Date.now(),
  };
  const first = commands.handle({ ...envelope });
  const second = commands.handle({ ...envelope });
  // 第二次投递只复用在飞 promise，dispatch 不重入。
  assert.equal(stopCalls, 1);
  release?.();
  const [firstAck, secondAck] = await Promise.all([first, second]);
  assert.equal(firstAck.status, "accepted");
  assert.equal(secondAck, firstAck);
});

test("dispatch 失败会清理在飞表且错误原样抛出，后续投递可重试", async () => {
  let attempts = 0;
  const engine = {
    projection: { revision: 1 },
    stop: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("omp gone")) : Promise.resolve();
    },
  };
  const context = {
    workspaceId: "workspace",
    workspacePath: ".",
    attachments: {},
    registry: { getEngine: () => engine, requireEngine: () => engine },
  } as unknown as V4CommandContext;
  const commands = new V4CommandService(context);
  const envelope = {
    commandId: "retry-stop",
    clientId: "client",
    sessionId: "session",
    type: "stop",
    payload: {},
    issuedAt: Date.now(),
  };
  await assert.rejects(commands.handle({ ...envelope }), /omp gone/);
  // 在飞项已被清理：重试真正重新 dispatch 而不是拿到同一 rejection。
  const ack = await commands.handle({ ...envelope });
  assert.equal(ack.status, "accepted");
  assert.equal(attempts, 2);
});
