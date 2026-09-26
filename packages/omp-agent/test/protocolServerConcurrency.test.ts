import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { test } from "node:test";
import { ProtocolServer } from "../src/adapters/protocolServer.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("请求内定时器触发的帧当轮上线，不落后于事件上下文的后续帧", async () => {
  // 回归缺陷：长请求（如 sendText 等待 omp RPC 往返）期间，请求上下文内注册的
  // flush 定时器（topicPublisher 30ms 窗口）触发的帧曾被扣到请求结束才发出；
  // 期间事件上下文（omp 流式）的更高区间帧直写线上，同一 topic 区间倒挂，
  // 客户端按断档策略丢弃流式帧并触发恢复重订阅。
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) messages.push(JSON.parse(line));
  });
  const waitForFrame = (fromSeq: number, toSeq: number) =>
    new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const check = () => {
        const found = messages.some(
          (message) =>
            message.method === "v4/conversation/frame" &&
            (message.params as { fromSeq?: number; toSeq?: number }).fromSeq === fromSeq &&
            (message.params as { fromSeq?: number; toSeq?: number }).toSeq === toSeq,
        );
        if (found) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`帧 (${fromSeq},${toSeq}] 未在请求结束前上线`));
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });
  let releaseRequest!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let server!: ProtocolServer;
  server = new ProtocolServer({
    input,
    output,
    async handleRequest(method) {
      if (method === "long-op") {
        // 模拟 topicPublisher 的 flush 窗口：定时器在请求 ALS 上下文内注册并触发。
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            server.emitFrame({ topic: "conversation/s", fromSeq: 1, toSeq: 2 });
            resolve();
          }, 10);
        });
        // 模拟 omp RPC 往返耗时（超过 flush 窗口）。
        await released;
      }
      return {};
    },
  });
  server.start();
  input.write(`${JSON.stringify({ id: 1, method: "long-op", params: { sessionId: "s" } })}\n`);
  // 缺陷版会把 (1,2] 扣到请求结束，这里会超时失败。
  await waitForFrame(1, 2);
  // 事件上下文（无请求 store）：omp 流式事件的后续更高区间帧直写线上。
  server.emitFrame({ topic: "conversation/s", fromSeq: 2, toSeq: 3 });
  releaseRequest();
  await nextTurn();
  const order = messages.map((message) =>
    message.method === "v4/conversation/frame"
      ? `frame:${(message.params as { fromSeq: number }).fromSeq}-${(message.params as { toSeq: number }).toSeq}`
      : `res:${message.id}`,
  );
  assert.deepEqual(order, ["frame:1-2", "frame:2-3", "res:1"]);
  input.end();
  server.dispose();
});

test("慢会话只阻塞自己的命令，独立帧不等它的 ACK", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) messages.push(JSON.parse(line));
  });
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const handled: string[] = [];
  let server!: ProtocolServer;
  server = new ProtocolServer({
    input,
    output,
    async handleRequest(method) {
      handled.push(method);
      if (method === "slow-a") await slow;
      if (method === "fast-b") server.emitFrame({ topic: "conversation/b" });
      return {};
    },
  });
  server.start();
  input.write(`${JSON.stringify({ id: 1, method: "slow-a", params: { sessionId: "a" } })}\n`);
  input.write(`${JSON.stringify({ id: 2, method: "second-a", params: { sessionId: "a" } })}\n`);
  input.write(`${JSON.stringify({ id: 3, method: "fast-b", params: { sessionId: "b" } })}\n`);
  await nextTurn();
  assert.deepEqual(handled, ["slow-a", "fast-b"]);
  assert.deepEqual(
    messages.map((message) => message.id ?? message.method),
    [3, "v4/conversation/frame"],
  );
  releaseSlow();
  await nextTurn();
  assert.deepEqual(handled, ["slow-a", "fast-b", "second-a"]);
  assert.deepEqual(
    messages.map((message) => message.id ?? message.method),
    [3, "v4/conversation/frame", 1, 2],
  );
  input.end();
  server.dispose();
});

test("关闭调试日志时通知只编码一次", () => {
  const server = new ProtocolServer({
    input: new PassThrough(),
    output: new PassThrough(),
    async handleRequest() {
      return {};
    },
  });
  let encodes = 0;
  server.notify("fixture", {
    toJSON() {
      encodes += 1;
      return { text: "fixture" };
    },
  });
  assert.equal(encodes, 1);
  server.dispose();
});

test("Host 停止读取时 Agent 缓冲有界并明确关闭", () => {
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      // 模拟 Host 永久不读取；首帧留在 Writable 内，后续由 ProtocolServer 有界缓存。
    },
  });
  let closedError: Error | undefined;
  const server = new ProtocolServer({
    input: new PassThrough(),
    output,
    async handleRequest() {
      return {};
    },
    onClosed(error) {
      closedError = error;
    },
  });
  const payload = "x".repeat(1024 * 1024);
  for (let index = 0; index < 20; index += 1) server.notify("large", { payload });
  assert.match(closedError?.message ?? "", /buffer saturated/);
  server.dispose();
  output.destroy();
});
