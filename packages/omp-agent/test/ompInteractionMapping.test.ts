// 富 ask 映射 UT（载体：extension_ui_request{method:"ask"} → extension_ui_response{answers}）。
// 覆盖：decline/cancel 整体取消；content.answer_N 数组保真与 ", " 连接切分；单题自由文本
// 落 customInput；多题无结构答案按取消收口（不伪造逐题答案）；空提交全不选。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { OmpAskQuestion } from "../src/domain/ompFrames.js";
import type { HostUserInputAnswer } from "../src/app/ports.js";
import { askDeadlineOf, askResponseOf } from "../src/app/ompInteractionMapping.js";

const QUESTIONS: OmpAskQuestion[] = [
  {
    id: "q1",
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "relational" },
      { label: "SQLite", description: "embedded" },
    ],
    multi: true,
  },
  {
    id: "q2",
    question: "Enable cache?",
    options: [{ label: "Yes" }, { label: "No" }],
  },
];

function respondOf(answer: HostUserInputAnswer) {
  return askResponseOf({ id: "ask-1", questions: QUESTIONS }, answer);
}

test("decline/cancel → cancelled 变体（omp 侧按取消收口）", () => {
  assert.deepEqual(respondOf({ action: "decline" }), {
    type: "extension_ui_response",
    id: "ask-1",
    cancelled: true,
  });
  assert.deepEqual(respondOf({ action: "cancel" }), {
    type: "extension_ui_response",
    id: "ask-1",
    cancelled: true,
  });
});

test("content.answer_N 数组保真 → 按题 answers（id 对齐题目 id）", () => {
  const response = respondOf({
    action: "accept",
    content: {
      answer_0: ["Postgres", "SQLite"],
      answer_1: ["Yes"],
    },
  });
  assert.equal(response.type, "extension_ui_response");
  assert.deepEqual(
    response.type === "extension_ui_response" && "answers" in response ? response.answers : null,
    [
      { id: "q1", selectedOptions: ["Postgres", "SQLite"] },
      { id: "q2", selectedOptions: ["Yes"] },
    ],
  );
});

test("answers 文本按已知标签切分；未知值落 customInput", () => {
  const response = respondOf({
    action: "accept",
    content: {
      answers: { "Which database?": "Postgres, SQLite, custom-word" },
      answer_1: ["No"],
    },
  });
  assert.deepEqual(
    response.type === "extension_ui_response" && "answers" in response ? response.answers : null,
    [
      { id: "q1", selectedOptions: ["Postgres", "SQLite"], customInput: "custom-word" },
      { id: "q2", selectedOptions: ["No"] },
    ],
  );
});

test("optionId 命中目录内选项 → 命中题 selectedOptions，其余空选", () => {
  const response = respondOf({ action: "accept", optionId: "Postgres" });
  assert.deepEqual(
    response.type === "extension_ui_response" && "answers" in response ? response.answers : null,
    [
      { id: "q1", selectedOptions: ["Postgres"] },
      { id: "q2", selectedOptions: [] },
    ],
  );
});

test("单题自由文本 → customInput；多题无结构答案按取消收口", () => {
  const single = askResponseOf(
    { id: "ask-2", questions: [QUESTIONS[1]!] },
    { action: "accept", freeText: "custom answer" },
  );
  assert.deepEqual(
    single.type === "extension_ui_response" && "answers" in single ? single.answers : null,
    [{ id: "q2", selectedOptions: [], customInput: "custom answer" }],
  );
  const multi = respondOf({ action: "accept", freeText: "custom answer" });
  assert.deepEqual(multi, { type: "extension_ui_response", id: "ask-1", cancelled: true });
});

test("空提交 → 每题 selectedOptions:[]（多选「全不选」语义）", () => {
  const response = respondOf({ action: "accept" });
  assert.deepEqual(
    response.type === "extension_ui_response" && "answers" in response ? response.answers : null,
    [
      { id: "q1", selectedOptions: [] },
      { id: "q2", selectedOptions: [] },
    ],
  );
});

test("askDeadlineOf：timeoutMs 换算 epoch，非法/缺失返回 undefined", () => {
  const before = Date.now();
  const deadline = askDeadlineOf({ timeoutMs: 60_000 });
  assert.ok(typeof deadline === "number" && deadline >= before + 60_000);
  assert.equal(askDeadlineOf({}), undefined);
  assert.equal(askDeadlineOf({ timeoutMs: 0 }), undefined);
  assert.equal(askDeadlineOf({ timeoutMs: -5 }), undefined);
});
