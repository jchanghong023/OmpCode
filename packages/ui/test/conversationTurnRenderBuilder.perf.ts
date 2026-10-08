import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  ConversationTurnRenderCache,
} from "../src/v4/conversationTurnRenderBuilder.js";

const turnCount = 5000;
const iterations = 30;
function fixture(): ConversationRow[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const turnId = `turn-${index}`;
    const running = index === turnCount - 1;
    return [
      {
        kind: "turnHeader",
        rowId: index * 3 + 1,
        turnId,
        executionKind: "agent",
        state: running ? "running" : "completedSuccess",
        startedAt: 0,
        ...(running ? {} : { endedAt: 1000 }),
      },
      {
        kind: "userInput",
        rowId: index * 3 + 2,
        turnId,
        entityId: `input-${index}`,
        origin: "realUser",
        text: `question-${index}`,
      },
      {
        kind: "assistantText",
        rowId: index * 3 + 3,
        turnId,
        state: running ? "streaming" : "complete",
        text: `answer-${index}`,
      },
    ] as ConversationRow[];
  }).flat();
}

function measure(mode: "clock" | "stream", instrument: boolean) {
  let visits = 0;
  let turnIdReads = 0;
  let collecting = false;
  const wrap = (input: ConversationRow[]) =>
    instrument
      ? new Proxy(input, {
          get(target, property, receiver) {
            if (collecting && typeof property === "string" && /^\d+$/.test(property)) visits += 1;
            return Reflect.get(target, property, receiver);
          },
        })
      : input;
  const cache = new ConversationTurnRenderCache();
  const wrapRow = (row: ConversationRow) =>
    instrument
      ? new Proxy(row, {
          get(target, property, receiver) {
            if (collecting && property === "turnId") turnIdReads += 1;
            return Reflect.get(target, property, receiver);
          },
        })
      : row;
  let rows = wrap(fixture().map(wrapRow));
  let units = buildConversationTurnRenderUnits(rows, { nowMs: 0, sessionPhase: "running" }, cache);
  const stableHistory = units.slice(0, -1);
  visits = 0;
  let elapsedMs = 0;
  let reusedHistoryUnits = 0;
  for (let index = 1; index <= iterations; index += 1) {
    if (mode === "stream") {
      // 浅拷贝在被测 builder 之外完成，计数只覆盖 builder 对输入行的访问。
      const next = Array.from(rows);
      next[next.length - 1] = wrapRow({
        ...next.at(-1)!,
        text: `answer-${turnCount - 1}:${index}`,
      } as ConversationRow);
      rows = wrap(next);
    }
    collecting = true;
    const started = performance.now();
    units = buildConversationTurnRenderUnits(
      rows,
      { nowMs: index * 1000, sessionPhase: "running" },
      cache,
    );
    elapsedMs += performance.now() - started;
    collecting = false;
    for (let historyIndex = 0; historyIndex < stableHistory.length; historyIndex += 1) {
      assert.equal(units[historyIndex], stableHistory[historyIndex]);
      reusedHistoryUnits += 1;
    }
  }
  assert.equal(units.length, turnCount);
  assert.deepEqual(
    units,
    buildConversationTurnRenderUnits(rows, { nowMs: iterations * 1000, sessionPhase: "running" }),
  );
  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    ...(instrument ? { rowVisits: visits, turnIdReads } : {}),
    reusedHistoryUnits,
  };
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      turnCount,
      rowCount: turnCount * 3,
      iterations,
      clock: { timing: measure("clock", false), counted: measure("clock", true) },
      stream: { timing: measure("stream", false), counted: measure("stream", true) },
    },
    null,
    2,
  ),
);
