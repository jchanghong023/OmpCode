import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { StdioStream } from "../src/remote/backend.js";
import { collectStdout } from "../src/remote/deploy.js";

/**
 * 构造最小 StdioStream 假体：stdout 用真实 Readable——destroy(error) 会向监听者 emit 'error'，
 * 与 Docker/WSL backend 的 child.stdout 行为一致，可暴露“error 无监听逃逸成 uncaughtException”的问题。
 */
function createFakeStdioStream() {
  const stdout = new Readable({ read() {} });
  let closeListener: ((code: number) => void) | null = null;
  const stream = {
    stdin: new EventEmitter(),
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: new EventEmitter(),
    onClose: (listener: (code: number) => void) => {
      closeListener = listener;
      return { dispose: () => undefined };
    },
  } as unknown as StdioStream;
  const emittedErrors: unknown[] = [];
  return {
    stream,
    stdout,
    emittedErrors,
    emitData: (text: string) => stdout.push(Buffer.from(text)),
    emitClose: () => closeListener?.(0),
    /** destroy 的 'error' 与真实 Readable 的 'data' 均异步派发；等两轮宏任务保证派发完毕。 */
    settle: () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))),
  };
}

test("collectStdout resolves buffered stdout when the stream closes", async () => {
  const fake = createFakeStdioStream();
  const pending = collectStdout(fake.stream, 1_000);
  fake.emitData("1.2.3\n");
  await fake.settle();
  fake.emitClose();
  assert.equal(await pending, "1.2.3\n");
  // 正常收尾路径不应销毁流。
  assert.equal(fake.stdout.destroyed, false);
});

test("collectStdout rejects and destroys the stream when the version check times out", async () => {
  const fake = createFakeStdioStream();
  const pending = collectStdout(fake.stream, 20);
  // 旁路 error 监听：证明 destroy 注入的错误确实以 'error' 事件发出。
  fake.stdout.on("error", (error) => fake.emittedErrors.push(error));
  // F20 核心断言 1：超时必须 reject（checkServerDeployDecision 的 catch 会转成 shouldDeploy=true）。
  await assert.rejects(pending, /timed out/u);
  // 超时后必须销毁流，不能留下半开管道。
  assert.ok(fake.stdout.destroyed);
  await fake.settle();
  // F20 返工断言：destroy 注入的错误以 'error' 事件发出且被 collectStdout 自有监听吸收，
  // 不得逃逸为 uncaughtException（node:test 会把 uncaughtException 记为用例失败）。
  assert.equal(fake.emittedErrors.length, 1);
});

test("collectStdout rejects and destroys the stream when stdout exceeds the byte cap", async () => {
  const fake = createFakeStdioStream();
  const pending = collectStdout(fake.stream, 1_000, 8);
  fake.stdout.on("error", (error) => fake.emittedErrors.push(error));
  // 先挂 rejection 断言：真实 Readable 的 'data' 异步派发，超限拒绝可能发生在 settle 期间，
  // 后挂断言会让 rejection 以 unhandledRejection 形式逃逸并污染用例。
  const rejectionAssertion = assert.rejects(pending, /stdout exceeded/u);
  fake.emitData("12345678");
  fake.emitData("9");
  // F20 核心断言 2：stdout 无界缓冲防护——超限销毁流并按失败处理。
  await rejectionAssertion;
  assert.ok(fake.stdout.destroyed);
  await fake.settle();
  // 超限路径同样不得让 destroy 注入的错误逃逸成 uncaughtException。
  assert.equal(fake.emittedErrors.length, 1);
});

test("collectStdout surfaces genuine stdout errors instead of absorbing them", async () => {
  const fake = createFakeStdioStream();
  const pending = collectStdout(fake.stream, 1_000);
  // 未 settle 阶段的真实流错误不得被静默吞掉，应按失败方向 reject（保守应部署）。
  fake.stdout.emit("error", new Error("genuine stream failure"));
  await assert.rejects(pending, /genuine stream failure/u);
  assert.ok(fake.stdout.destroyed);
});
