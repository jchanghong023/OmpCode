import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  ConversationTurnRenderCache,
} from "../src/v4/conversationTurnRenderBuilder.js";

function userRow(turn: number, text: string): ConversationRow {
  return {
    kind: "userInput",
    rowId: turn,
    turnId: `turn-${turn}`,
    productTurnId: `turn-${turn}`,
    entityId: `input-${turn}`,
    createdAtSeq: turn,
    origin: "realUser",
    text,
  } as ConversationRow;
}

test("计时与单轮变化只重算受影响的轮，结果与纯构建一致", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = Array.from({ length: 80 }, (_, index) => userRow(index + 1, `message-${index}`));
  const initial = buildConversationTurnRenderUnits(
    rows,
    { nowMs: 0, sessionPhase: "running" },
    cache,
  );
  const clock = buildConversationTurnRenderUnits(
    rows,
    { nowMs: 1000, sessionPhase: "running" },
    cache,
  );
  assert.deepEqual(
    clock,
    buildConversationTurnRenderUnits(rows, { nowMs: 1000, sessionPhase: "running" }),
  );
  for (let index = 0; index < rows.length; index += 1) assert.equal(clock[index], initial[index]);

  const updated = [...rows];
  updated[79] = userRow(80, "new text");
  const next = buildConversationTurnRenderUnits(
    updated,
    { nowMs: 2000, sessionPhase: "running" },
    cache,
  );
  assert.deepEqual(
    next,
    buildConversationTurnRenderUnits(updated, { nowMs: 2000, sessionPhase: "running" }),
  );
  assert.equal(next[0], clock[0]);
  assert.notEqual(next[79], clock[79]);
});
