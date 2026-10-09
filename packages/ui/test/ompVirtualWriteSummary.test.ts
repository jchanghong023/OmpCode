import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFallbackRawToolCallFileSummary } from "../src/ToolCallBlocks/fileSummaryHeuristics.js";

test("通信和作业控制不会被 write renderer 冒充文件；真实文件保持变更提示", () => {
  for (const path of ["agent://all", "agent://Main", "proc://worker/kill"])
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
