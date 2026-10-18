import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFallbackRawToolCallFileSummary } from "../src/ToolCallBlocks/fileSummaryHeuristics.js";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";
import type { TaskChatToolCall } from "../src/lib/taskChatMessageTypes.js";

test("通信和作业控制不会被 write renderer 冒充文件；真实文件保持变更提示", () => {
  for (const path of ["xd://repo", "agent://all", "agent://Main", "proc://worker/kill"])
    assert.deepEqual(
      buildFallbackRawToolCallFileSummary({
        toolName: "write",
        kind: "write",
        input: { path, content: "hello" },
      }),
      [],
    );
  const file = buildFallbackRawToolCallFileSummary({
    toolName: "write",
    kind: "write",
    input: { path: "a", content: "a" },
  });
  assert.equal(file.length, 1);
  assert.equal(file[0]?.path, "a");
  assert.equal(file[0]?.changeStat?.added, 1);
});

test("虚拟资源 write 显示真实结果，不用请求内容冒充文件预览", () => {
  const base: TaskChatToolCall = {
    toolId: "device-write",
    toolName: "write",
    kind: "write",
    input: { path: "xd://repo", content: '{"action":"search","query":"nativeTiming731"}' },
    status: "completed",
  };
  for (const output of [
    'Text for "nativeTiming731": 1 hit(s) on this page\n[1] native-code/timing.mjs:1-1 [other] NATIVE_REPO_SENTINEL_731',
    'Text for "nativeTiming731": 0 hit(s) on this page\nNo indexed matches.',
    "No repository index exists. Open /repo to build one; use read/grep for current files meanwhile.",
    0,
    false,
  ]) {
    const model = buildToolDisplayModel({ ...base, output }, "/workspace");
    assert.equal(model.showOutput, true);
    assert.equal(model.showInput, true);
    assert.equal(model.showSummaryFileLink, false);
    assert.equal(model.viewerSource, null);
    assert.deepEqual(model.inlinePreview, { type: "none" });
  }
  assert.equal(buildToolDisplayModel(base, "/workspace").showOutput, false);
  const failed = buildToolDisplayModel(
    { ...base, status: "failed", error: "Device unavailable", output: "partial" },
    "/workspace",
  );
  assert.equal(failed.showOutput, true);
  assert.equal(failed.showInput, false);
  assert.deepEqual(failed.inlinePreview, { type: "none" });
  for (const path of ["native-code/timing.mjs", "file:///workspace/native-code/timing.mjs"]) {
    const file = buildToolDisplayModel(
      { ...base, input: { path, content: "file contents" }, output: "Wrote file" },
      "/workspace",
    );
    assert.equal(file.showOutput, false, "真实文件写入仍只显示内容/变更摘要");
  }
});
