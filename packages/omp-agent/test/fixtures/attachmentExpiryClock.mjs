import assert from "node:assert/strict";
import { mock } from "node:test";

// 仅控制真实适配器宿主的时间；不替换 AttachmentStore、协议处理器或 OMP。
// 只推进 Date；真实定时器、跨进程/HTTP IO 均保持运行，不触发协议超时。
// 是否允许消费已过期 ref 必须由真实附件 owner 在读取时决定。
assert.equal(
  typeof process.send,
  "function",
  "The adapter clock fixture requires its owned IPC channel",
);
assert.ok(process.channel, "A missing clock control channel must fail before adapter startup");
mock.timers.enable({ apis: ["Date"], now: Date.now() });
process.send({ type: "test:attachment-clock-ready", now: Date.now() });
process.once("exit", () => mock.timers.reset());
process.on("message", (message) => {
  assert.ok(message && typeof message === "object");
  assert.equal(message.type, "test:advance-attachment-clock");
  assert.ok(Number.isSafeInteger(message.milliseconds) && message.milliseconds > 0);
  const before = Date.now();
  mock.timers.setTime(before + message.milliseconds);
  process.send({
    type: "test:attachment-clock-advanced",
    before,
    now: Date.now(),
  });
});
// IPC 只用来控制测试时钟，不阻止真实 app-server 在 stdin EOF 后正常退出。
process.channel.unref();
