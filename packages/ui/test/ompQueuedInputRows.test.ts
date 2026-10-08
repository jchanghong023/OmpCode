import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, QueueState } from "@zcode/shared/zcode-protocol-v4";
import { rowsWithoutQueuedInputs } from "../src/v4/OmpQueuedInputRows.js";

test("排队输入只显示在队列面板，已消费的相同文本仍显示在时间线", () => {
  const rows = [
    { kind: "userInput", turnId: "active", sourceCommandId: "a", text: "hello" },
    { kind: "turnHeader", turnId: "waiting", sourceCommandId: "b", state: "running" },
    { kind: "userInput", turnId: "waiting", sourceCommandId: "b", text: "hello" },
  ] as ConversationRow[];
  const queue = { autoDrain: true, items: [{ sourceCommandId: "b" }] } as QueueState;
  assert.deepEqual(rowsWithoutQueuedInputs(rows, queue), [rows[0]]);
  assert.equal(rowsWithoutQueuedInputs(rows, { autoDrain: true, items: [] }), rows);
});
