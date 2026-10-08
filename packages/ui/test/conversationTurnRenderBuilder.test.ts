import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { BuildConversationTurnRenderUnitsOptions } from "../src/v4/conversationTurnRenderUnits.js";
import { buildConversationFindIndex } from "../src/v4/conversationFindIndex.js";
import { buildConversationTurnNavigatorItems } from "../src/v4/conversationTurnNavigatorHelpers.js";
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

function turnRows(turn: number, running = false): ConversationRow[] {
  const turnId = `turn-${turn}`;
  return [
    {
      kind: "turnHeader",
      rowId: turn * 10,
      turnId,
      executionKind: "agent",
      state: running ? "running" : "completedSuccess",
      startedAt: 0,
      ...(running ? {} : { endedAt: 1000 }),
    },
    { ...userRow(turn, `question-${turn}`), rowId: turn * 10 + 1, createdAt: 0 },
    {
      kind: "assistantText",
      rowId: turn * 10 + 2,
      turnId,
      text: `answer-${turn}`,
      state: running ? "streaming" : "complete",
    },
  ] as ConversationRow[];
}

function assertEquivalent(
  cache: ConversationTurnRenderCache,
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
) {
  const actual = buildConversationTurnRenderUnits(rows, options, cache);
  const expected = buildConversationTurnRenderUnits(rows, options);
  assert.deepEqual(actual, expected);
  assert.equal(
    cache.hasRunningUnit,
    expected.some((unit) => unit.isRunning),
  );
  assert.deepEqual(
    cache.queryRowIds,
    new Set(
      expected.flatMap((unit) =>
        unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
      ),
    ),
  );
  return actual;
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

test("运行计时不访问输入历史行，正文与 guide 工作分段保持引用", () => {
  const cache = new ConversationTurnRenderCache();
  let rowReads = 0;
  const rows = new Proxy(
    [
      ...turnRows(1),
      ...turnRows(2, true),
      { ...userRow(2, "guide"), rowId: 23, entityId: "guide", guided: true, createdAt: 2000 },
      {
        kind: "assistantText",
        rowId: 24,
        turnId: "turn-2",
        text: "guided answer",
        state: "streaming",
      },
    ] as ConversationRow[],
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const initial = assertEquivalent(cache, rows, { nowMs: 3000, sessionPhase: "running" });
  const initialCopy = JSON.stringify(initial);
  const queryRowIds = cache.queryRowIds;
  rowReads = 0;
  const clock = buildConversationTurnRenderUnits(
    rows,
    { nowMs: 5000, sessionPhase: "running" },
    cache,
  );
  assert.equal(rowReads, 0);
  assert.equal(clock[0], initial[0]);
  assert.equal(clock[1]?.workStatus?.durationMs, 5000);
  assert.equal(clock[1]?.workSegments?.at(-1)?.workStatus?.durationMs, 3000);
  assert.equal(clock[1]?.renderRows, initial[1]?.renderRows);
  assert.equal(clock[1]?.flowItems, initial[1]?.flowItems);
  assert.equal(clock[1]?.workSegments?.[0], initial[1]?.workSegments?.[0]);
  assert.equal(
    clock[1]?.workSegments?.at(-1)?.flowItems,
    initial[1]?.workSegments?.at(-1)?.flowItems,
  );
  assert.equal(cache.queryRowIds, queryRowIds);
  assert.equal(JSON.stringify(initial), initialCopy);
  assertEquivalent(cache, rows, { nowMs: 5000, sessionPhase: "running" });
  // 撤去 UI 时钟时不能把旧 durationMs 留在派生结果里。
  assertEquivalent(cache, rows, { sessionPhase: "running" });
});

test("单轮流式变化不重分组历史，旧视图不可变，完成时全文一致", () => {
  const cache = new ConversationTurnRenderCache();
  let turnReads = 0;
  let counting = false;
  const rows = Array.from({ length: 100 }, (_, index) => turnRows(index + 1, index === 99))
    .flat()
    .map(
      (row) =>
        new Proxy(row, {
          get(target, property, receiver) {
            if (counting && property === "turnId") turnReads += 1;
            return Reflect.get(target, property, receiver);
          },
        }),
    );
  const initial = assertEquivalent(cache, rows, { nowMs: 1000, sessionPhase: "running" });
  const initialCopy = JSON.stringify(initial);
  const queryRowIds = cache.queryRowIds;
  const updated = [...rows];
  updated[updated.length - 1] = {
    ...updated.at(-1)!,
    text: "complete incremental text",
  } as ConversationRow;
  counting = true;
  const next = buildConversationTurnRenderUnits(
    updated,
    { nowMs: 2000, sessionPhase: "running" },
    cache,
  );
  counting = false;
  assert.ok(turnReads < 10, `稳定结构不应读取全部历史的 turnId：${turnReads}`);
  for (let index = 0; index < initial.length - 1; index += 1)
    assert.equal(next[index], initial[index]);
  assert.equal(cache.queryRowIds, queryRowIds);
  assert.equal(JSON.stringify(initial), initialCopy);
  assertEquivalent(cache, updated, { nowMs: 2000, sessionPhase: "running" });
  const completed = [...updated];
  completed[completed.length - 3] = {
    ...completed.at(-3)!,
    state: "completedSuccess",
    endedAt: 2500,
  } as ConversationRow;
  completed[completed.length - 1] = { ...completed.at(-1)!, state: "complete" } as ConversationRow;
  const result = assertEquivalent(cache, completed, {
    nowMs: 3000,
    sessionPhase: "completedSuccess",
  });
  assert.equal(result.at(-1)?.latestAssistantTextRow?.text, "complete incremental text");
  assert.equal(result.at(-1)?.workStatus?.durationMs, 2500);
  assert.equal(result[0], initial[0]);
});

test("分页前插、追加、移除和同长度行替换保持稳定顺序与末轮位置", () => {
  const cache = new ConversationTurnRenderCache();
  let rows = [...turnRows(2), ...turnRows(3)];
  const initial = assertEquivalent(cache, rows);
  rows = [...turnRows(1), ...rows];
  const prepended = assertEquivalent(cache, rows);
  assert.deepEqual(
    prepended.map((unit) => unit.turnId),
    ["turn-1", "turn-2", "turn-3"],
  );
  assert.equal(prepended[1], initial[0]);
  assert.equal(prepended[2], initial[1]);
  rows = [...rows, ...turnRows(4)];
  const appended = assertEquivalent(cache, rows);
  assert.equal(appended[2]?.isLastTurn, false);
  assert.equal(appended[3]?.isLastTurn, true);
  rows = rows.filter((row) => row.turnId !== "turn-4");
  const removed = assertEquivalent(cache, rows);
  assert.equal(removed.at(-1)?.isLastTurn, true);
  // rowId/turnId 改变且长度不变时，不能误用此前的分组位置。
  rows = rows.map((row) =>
    row.turnId === "turn-2"
      ? ({ ...row, rowId: row.rowId + 1000, turnId: "replacement" } as ConversationRow)
      : row,
  );
  assert.deepEqual(
    assertEquivalent(cache, rows).map((unit) => unit.turnId),
    ["turn-1", "replacement", "turn-3"],
  );
  assertEquivalent(cache, []);
  assertEquivalent(cache, turnRows(8, true), { nowMs: 9000, sessionPhase: "running" });
});

test("不可见轮次出现及消失时重新归一化可见末轮，不丢分组", () => {
  const cache = new ConversationTurnRenderCache();
  const hidden: ConversationRow = {
    kind: "reasoning",
    rowId: 20,
    turnId: "hidden",
    text: "",
    state: "complete",
  } as ConversationRow;
  const rows = [...turnRows(1), hidden];
  const initial = assertEquivalent(cache, rows);
  assert.equal(initial.length, 1);
  const revealed = [
    ...rows.slice(0, -1),
    { ...hidden, text: "visible reasoning" } as ConversationRow,
  ];
  const next = assertEquivalent(cache, revealed);
  assert.equal(next.length, 2);
  assert.equal(next[0]?.isLastTurn, false);
  assert.equal(next[1]?.isLastTurn, true);
  const hiddenAgain = assertEquivalent(cache, rows);
  assert.equal(hiddenAgain.length, 1);
  assert.equal(hiddenAgain[0]?.isLastTurn, true);
});

test("无 header 的旧快照随 session phase 变化，权威 header 终态不被全局阶段覆盖", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = [...turnRows(1), ...turnRows(2, true).slice(1)];
  const running = assertEquivalent(cache, rows, { nowMs: 1000, sessionPhase: "running" });
  const interrupted = assertEquivalent(cache, rows, {
    nowMs: 2000,
    sessionPhase: "completedInterrupted",
  });
  assert.equal(interrupted[0], running[0]);
  assert.equal(interrupted[1]?.isRunning, false);
  assert.equal(interrupted[1]?.assistantHistoryDefaultOpen, true);
  assertEquivalent(cache, rows, { nowMs: 3000, sessionPhase: "error" });
  assertEquivalent(cache, rows, { nowMs: 4000, sessionPhase: "completedSuccess" });
  assertEquivalent(cache, rows, { nowMs: 5000, sessionPhase: "running" });
});

test("交错轮次的同 rowId 内容或 kind 替换仍按各轮原始全序构建", () => {
  const cache = new ConversationTurnRenderCache();
  const first = turnRows(1);
  const second = turnRows(2);
  const rows = [first[0]!, second[0]!, first[1]!, second[1]!, first[2]!, second[2]!];
  assertEquivalent(cache, rows);
  const replacement = [...rows];
  replacement[4] = {
    kind: "reasoning",
    rowId: 12,
    turnId: "turn-1",
    text: "replacement reasoning",
    state: "complete",
  } as ConversationRow;
  const result = assertEquivalent(cache, replacement);
  assert.deepEqual(
    result[0]?.renderRows.map((row) => row.rowId),
    [11, 12],
  );
  assertEquivalent(cache, [...replacement.slice(0, 4), replacement[5]!, replacement[4]!]);
});

test("导航查询成员只因可见 realUser 成员变化而更新", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = turnRows(1, true);
  assertEquivalent(cache, rows, { nowMs: 0 });
  const initialIds = cache.queryRowIds;
  const updated = [...rows];
  updated[1] = { ...updated[1]!, text: "edited question" } as ConversationRow;
  assertEquivalent(cache, updated, { nowMs: 1000 });
  assert.equal(cache.queryRowIds, initialIds);
  const next = [...updated];
  next[1] = { ...next[1]!, origin: "workflowLaunch" } as ConversationRow;
  assertEquivalent(cache, next, { nowMs: 2000 });
  assert.equal(cache.queryRowIds.size, 0);
  assert.deepEqual(initialIds, new Set([11]));
});

test("有 activeMs 的运行轮时钟不制造新视图", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = turnRows(1, true);
  rows[0] = { ...rows[0]!, activeMs: 600 } as ConversationRow;
  const initial = assertEquivalent(cache, rows, { nowMs: 1000 });
  const next = assertEquivalent(cache, rows, { nowMs: 3000 });
  assert.equal(next, initial);
  assert.equal(next[0]?.workStatus?.durationMs, 600);
});

test("时长展示更新时导航和查找内容相同，新正文仍及时进入两者", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = [...turnRows(1), ...turnRows(2, true)];
  const content = assertEquivalent(cache, rows, { nowMs: 1000, sessionPhase: "running" });
  const navigatorOptions = {
    assistantEmptyPreview: "empty",
    assistantRunningPreview: "running",
    userFallbackPreview: "user",
  };
  const navigation = buildConversationTurnNavigatorItems(content, navigatorOptions);
  const find = buildConversationFindIndex(content, "answer");
  const clock = assertEquivalent(cache, rows, { nowMs: 3000, sessionPhase: "running" });
  assert.equal(clock.at(-1)?.workStatus?.durationMs, 3000);
  assert.equal(content.at(-1)?.workStatus?.durationMs, 1000);
  assert.deepEqual(buildConversationTurnNavigatorItems(clock, navigatorOptions), navigation);
  assert.deepEqual(buildConversationFindIndex(clock, "answer"), find);
  const updated = [...rows];
  updated[updated.length - 1] = { ...updated.at(-1)!, text: "new live result" } as ConversationRow;
  const updatedContent = assertEquivalent(cache, updated, { nowMs: 3000, sessionPhase: "running" });
  // 内容更新已沿用最新时钟，第二层 memo 无需把 duration 还原再重算。
  assert.equal(
    buildConversationTurnRenderUnits(updated, { nowMs: 3000, sessionPhase: "running" }, cache),
    updatedContent,
  );
  assert.equal(
    buildConversationTurnNavigatorItems(updatedContent, navigatorOptions).at(-1)?.assistantPreview,
    "new live result",
  );
  assert.equal(buildConversationFindIndex(updatedContent, "new live result").matchCount, 1);
});

test("guide 的权威工时事实优先于正文时间边界", () => {
  const cache = new ConversationTurnRenderCache();
  const rows = [
    ...turnRows(1, true),
    { ...userRow(1, "guide"), rowId: 13, entityId: "guide", guided: true, createdAt: 2000 },
    {
      kind: "assistantText",
      rowId: 14,
      turnId: "turn-1",
      text: "guided answer",
      state: "streaming",
    },
  ] as ConversationRow[];
  rows[0] = {
    ...rows[0]!,
    workSegments: [
      { segmentId: "initial", startedAt: 0, activeMs: 800 },
      { segmentId: "guide", triggerEntityId: "guide", startedAt: 2500 },
    ],
  } as ConversationRow;
  const initial = assertEquivalent(cache, rows, { nowMs: 3000 });
  const clock = assertEquivalent(cache, rows, { nowMs: 6000 });
  assert.equal(clock[0]?.workSegments?.[0], initial[0]?.workSegments?.[0]);
  assert.equal(clock[0]?.workSegments?.[0]?.workStatus?.durationMs, 800);
  assert.equal(clock[0]?.workSegments?.[1]?.workStatus?.durationMs, 3500);
});
