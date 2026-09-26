import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coldSubagentIds,
  rowsFromOmpEntries,
  transcriptFromOmpEntries,
} from "../src/domain/coldHistory.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";

test("冷恢复从 omp task/wait 条目重建子代理状态与记录", () => {
  const entries = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "让子代理计算" }], timestamp: 1000 },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "task-call", name: "task", arguments: {} }],
        timestamp: 1001,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "task-call",
        toolName: "task",
        content: [],
        details: {
          progress: [{ id: "sonic", agent: "task", status: "pending", assignment: "计算 8×9" }],
        },
        timestamp: 1002,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "wait-call",
        toolName: "wait",
        content: [],
        details: { jobs: [{ id: "sonic", status: "completed", resultText: "72" }] },
        timestamp: 1003,
      },
    },
  ];
  assert.deepEqual(coldSubagentIds(entries), ["sonic"]);
  const transcript = transcriptFromOmpEntries([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "计算 8×9" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "72" }] } },
  ]);
  const rows = rowsFromOmpEntries(entries, new Map([["sonic", transcript]]));
  const row = rows.find((candidate) => candidate.kind === "subagent");
  assert.equal(row?.kind, "subagent");
  if (row?.kind !== "subagent") return;
  assert.equal(row.status, "success");
  assert.equal(row.parentToolCallId, "task-call");
  assert.match(row.transcriptText ?? "", /assistant: 72/u);
  const projection = new ConversationProjection("cold-test");
  projection.hydrateRows(rows);
  assert.equal(projection.buildSnapshot().subagents.endedTotal, 1);
  assert.equal(projection.subagentDirectory().ended.total, 1);
});
