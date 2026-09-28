import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createMainLogWriter } from "../src/main/mainLogWriter.js";

test("200 条日志合为一次磁盘写入，原始顺序和正文不变", async () => {
  const writes: Array<[string, string]> = [];
  let directories = 0;
  const writer = createMainLogWriter({
    ensureDirectory: async () => {
      directories++;
    },
    append: async (path, text) => {
      writes.push([path, text]);
    },
  });
  const lines = Array.from({ length: 200 }, (_, i) => `${i}: 日志\n`);
  for (const line of lines) writer.enqueue("/logs/day-a.log", line);
  assert.equal(writes.length, 0);
  await writer.flush();
  assert.deepEqual(writes, [["/logs/day-a.log", lines.join("")]]);
  assert.equal(directories, 1);
});

test("磁盘挂起时事件循环可继续工作，后续批次不越过前一批", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const writer = createMainLogWriter({
    ensureDirectory: async () => {},
    append: async (_path, text) => {
      writes.push(text);
      if (text === "first") await blocked;
    },
  });
  writer.enqueue("/logs/a", "first");
  const draining = writer.flush();
  await yieldToEventLoop();
  writer.enqueue("/logs/a", "second");
  await yieldToEventLoop();
  assert.deepEqual(writes, ["first"]);
  release();
  await draining;
  assert.deepEqual(writes, ["first", "second"]);
});

test("跨日/目录保持顺序，某次磁盘失败后后续文件仍写入", async () => {
  const paths: string[] = [];
  const writer = createMainLogWriter({
    ensureDirectory: async () => {},
    append: async (path) => {
      paths.push(path);
      if (paths.length === 1) throw new Error("disk");
    },
  });
  writer.enqueue("/old/day-a", "1");
  writer.enqueue("/old/day-b", "2");
  writer.enqueue("/new/day-b", "3");
  await writer.flush();
  assert.deepEqual(paths, ["/old/day-a", "/old/day-b", "/new/day-b"]);
});

test("队列按 UTF-8 字节限制并报告丢弃数量，退出等待有界", async () => {
  const writes: string[] = [];
  const writer = createMainLogWriter({
    maxBytes: 6,
    ensureDirectory: async () => {},
    append: async (_path, text) => {
      writes.push(text);
    },
  });
  writer.enqueue("/logs/a", "中文");
  writer.enqueue("/logs/a", "extra");
  await writer.flushBeforeExit();
  assert.match(writes[0]!, /^中文\[warn\].*1 file log records/u);
  const stalled = createMainLogWriter({
    ensureDirectory: async () => {},
    append: () => new Promise(() => {}),
  });
  stalled.enqueue("/logs/a", "stalled");
  await stalled.flushBeforeExit(10);
});

test("flush 的微任务窗口入队不会留下未调度的记录", async () => {
  const writes: string[] = [];
  const writer = createMainLogWriter({
    ensureDirectory: async () => {},
    append: async (_path, text) => {
      writes.push(text);
    },
  });
  const emptyFlush = writer.flush();
  writer.enqueue("/logs/a", "late");
  await emptyFlush;
  await writer.flush();
  assert.deepEqual(writes, ["late"]);
});
