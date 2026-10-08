import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOmpCommandCompletion } from "../src/hooks/useOmpCommandCompletion.js";

// 根因：UI 曾自行猜“最后一个词”并 trim 候选，丢弃 omp 返回的 UTF-16 替换区间。
test("词中补全保留区间外文本，跨空格区间与候选空白严格遵从 omp", () => {
  assert.deepEqual(
    applyOmpCommandCompletion("/security verse next", {
      kind: "argument",
      label: "Verbose",
      insertText: "--verbose ",
      replaceStart: 10,
      replaceEnd: 15,
    }),
    { text: "/security --verbose  next", cursor: 20 },
  );
  assert.deepEqual(
    applyOmpCommandCompletion("/command one two tail", {
      kind: "argument",
      label: "Both",
      insertText: "replacement",
      replaceStart: 9,
      replaceEnd: 16,
    }),
    { text: "/command replacement tail", cursor: 20 },
  );
});

test("UTF-16 偏移保留 Unicode 前缀，越界或逆向区间不可插入", () => {
  const text = "/cmd 😀 ab";
  assert.deepEqual(
    applyOmpCommandCompletion(text, {
      kind: "argument",
      label: "Next",
      insertText: "xy",
      replaceStart: 8,
      replaceEnd: 10,
    }),
    { text: "/cmd 😀 xy", cursor: 10 },
  );
  for (const [replaceStart, replaceEnd] of [
    [-1, 2],
    [2, 1],
    [0, 11],
    [0.5, 2],
  ]) {
    assert.equal(
      applyOmpCommandCompletion(text, {
        kind: "argument",
        label: "Invalid",
        insertText: "x",
        replaceStart,
        replaceEnd,
      }),
      null,
    );
  }
});
