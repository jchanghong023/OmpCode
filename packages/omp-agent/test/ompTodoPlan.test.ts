import assert from "node:assert/strict";
import test from "node:test";
import { toolCallRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { ompTodoPlan } from "../src/domain/ompTodoPlan.js";

test("omp todo phases 保留清单状态并满足 v4 输出 schema", () => {
  const plan = ompTodoPlan({
    phases: [
      {
        name: "实现",
        tasks: [
          { content: "修复入口", status: "completed" },
          { content: "验证 GUI", status: "in_progress" },
        ],
      },
    ],
  });
  assert.deepEqual(
    plan?.map((step) => [step.title, step.status]),
    [
      ["修复入口", "completed"],
      ["验证 GUI", "in_progress"],
    ],
  );
  const row = toolCallRowSchema.parse({
    rowId: 1,
    entityId: "tool-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    createdAtSeq: 1,
    kind: "toolCall",
    toolCallId: "1",
    toolName: "todo",
    status: "success",
    inputText: "{}",
    output: { text: "remaining 1", plan },
  });
  assert.deepEqual(row.output?.plan, plan);
});
