import assert from "node:assert/strict";
import { test } from "node:test";
import { createLatestTextBuffer } from "../src/hooks/useBufferedStreamingText.js";

test("持续 200 次增量合并为 10 次发布，最终全文完整且不会无限 debounce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const published: string[] = [];
  const buffer = createLatestTextBuffer((text) => published.push(text), 100);
  for (let index = 1; index <= 200; index++) {
    buffer.push("字".repeat(index));
    t.mock.timers.tick(5);
  }
  assert.equal(published.length, 10);
  assert.equal(published[0], "字".repeat(20));
  assert.equal(published.at(-1), "字".repeat(200));
});

test("切换/完成取消后，旧窗口不能发布陈旧文本；重新启动仍可发布", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const published: string[] = [];
  const buffer = createLatestTextBuffer((text) => published.push(text), 100);
  buffer.push("旧会话");
  buffer.cancel();
  t.mock.timers.tick(100);
  assert.deepEqual(published, []);
  buffer.push("新会话");
  t.mock.timers.tick(100);
  assert.deepEqual(published, ["新会话"]);
});
