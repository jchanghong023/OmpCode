import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema, type ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";

const QUESTION = "Choose a mock answer";
const INPUT = {
  questions: [
    {
      id: "q1",
      question: QUESTION,
      options: [{ label: "Mock answer A" }, { label: "Mock answer B" }],
    },
  ],
};
const SINGLE = {
  question: QUESTION,
  options: ["Mock answer A", "Mock answer B"],
  multi: false,
  selectedOptions: ["Mock answer A"],
};

function toolOf(projection: ConversationProjection): ToolCallRow {
  // 通过公开快照 schema，确保跨协议传输后 answers 仍在，而非仅存在于内部对象。
  const snapshot = conversationSnapshotSchema.parse(projection.buildSnapshot());
  const row = snapshot.rows.window.find((candidate) => candidate.kind === "toolCall");
  assert.ok(row?.kind === "toolCall");
  return row;
}

function liveResult(
  details: unknown,
  text: string,
  status: ToolCallRow["status"] = "success",
  createOnly = false,
  toolName = "ask",
): ToolCallRow {
  const projection = new ConversationProjection("ask-live");
  projection.beginUserTurn({
    text: "ask",
    inputId: "input-ask",
    sourceCommandId: "command-ask",
    clientId: "test",
  });
  if (!createOnly) {
    projection.upsertToolCall({
      toolCallId: "ask-1",
      toolName,
      status: "running",
      input: INPUT,
    });
    assert.equal(toolOf(projection).output, undefined);
  }
  projection.upsertToolCall({
    toolCallId: "ask-1",
    toolName,
    status,
    input: INPUT,
    outputText: text,
    resultDetails: details,
  });
  return toolOf(projection);
}

function entries(details: unknown, text: string, isError = false, toolName = "ask") {
  return [
    { type: "message", message: { role: "user", content: "ask", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "ask-1", name: toolName, arguments: INPUT }],
        timestamp: 2,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "ask-1",
        toolName,
        content: [{ type: "text", text }],
        details,
        isError,
        timestamp: 3,
      },
    },
  ];
}

function coldResult(details: unknown, text: string, isError = false, toolName = "ask") {
  const projection = new ConversationProjection("ask-cold");
  projection.hydrateRows(rowsFromOmpEntries(entries(details, text, isError, toolName)));
  return toolOf(projection);
}

function assertAgreement(details: unknown, text: string, answers?: Record<string, string[]>) {
  const before = structuredClone(details);
  const cold = coldResult(details, text);
  for (const createOnly of [false, true]) {
    const live = liveResult(details, text, "success", createOnly);
    assert.equal(live.status, "success");
    assert.equal(live.output?.text, text);
    assert.deepEqual(live.output?.answers, answers);
    assert.deepEqual(live.output, cold.output);
  }
  assert.equal(cold.status, "success");
  assert.deepEqual(details, before, "投影不得改写 OMP 原始 details");
}

test("OMP 单题真实选择在 live 创建/更新和冷恢复中保留，正文不改写为 JSON", () => {
  assertAgreement(SINGLE, "User selected: Mock answer A", {
    [QUESTION]: ["Mock answer A"],
  });
});

test("OMP 多题保留多选、自定义文本与超时实际答案，不把未答题或 note 当作答案", () => {
  assertAgreement(
    {
      results: [
        {
          id: "db",
          question: "Which database?",
          options: ["Postgres", "SQLite"],
          multi: true,
          selectedOptions: ["Postgres", "SQLite"],
          customInput: "another, database\nsecond line",
          note: "context only",
        },
        {
          id: "empty",
          question: "Unanswered?",
          options: ["Yes", "No"],
          multi: true,
          selectedOptions: [],
        },
        {
          id: "timeout",
          question: "Enable cache?",
          options: ["Yes", "No"],
          multi: false,
          selectedOptions: ["Yes"],
          timedOut: true,
        },
      ],
    },
    "Answers:\ndb: [Postgres, SQLite] + custom\nempty: []\ntimeout: Yes (auto-selected after timeout)",
    {
      "Which database?": ["Postgres", "SQLite", "another, database\nsecond line"],
      "Enable cache?": ["Yes"],
    },
  );
});

test("OMP 自定义单题答案保留原始文本，不切分逗号、不修剪回答", () => {
  const customInput = "  custom, answer\nwith details  ";
  assertAgreement(
    { ...SINGLE, selectedOptions: [], customInput },
    `User provided custom input:\n${customInput}`,
    { [QUESTION]: [customInput] },
  );
});

test("空答、聊天转向、畸形结构和看似已作答的正文不制造答案", () => {
  const cases: unknown[] = [
    undefined,
    null,
    "User selected: Mock answer A",
    {},
    { question: QUESTION, options: SINGLE.options },
    { ...SINGLE, selectedOptions: [] },
    { ...SINGLE, selectedOptions: [], customInput: "  " },
    { ...SINGLE, question: " " },
    { ...SINGLE, selectedOptions: "Mock answer A" },
    { ...SINGLE, selectedOptions: ["Mock answer A", 1] },
    { ...SINGLE, selectedOptions: [""] },
    { ...SINGLE, customInput: 1 },
    { chatRedirect: true, questions: [QUESTION] },
    { results: [] },
    { results: {} },
    { results: [SINGLE, null] },
    { results: [{ ...SINGLE, selectedOptions: undefined }] },
  ];
  for (const details of cases) assertAgreement(details, "User selected: Mock answer A");
});

test("失败、取消、运行中及缺失已落盘结果不能以 details 冒充成功答案", () => {
  for (const status of ["error", "cancelled", "running"] as const) {
    for (const createOnly of [false, true]) {
      const live = liveResult(SINGLE, "User selected: Mock answer A", status, createOnly);
      assert.equal(live.status, status);
      assert.equal(live.output?.text, "User selected: Mock answer A");
      assert.equal(live.output?.answers, undefined);
    }
  }
  const failed = coldResult(SINGLE, "Ask tool was cancelled by the user", true);
  assert.equal(failed.status, "error");
  assert.equal(failed.output?.text, "Ask tool was cancelled by the user");
  assert.equal(failed.output?.answers, undefined);
  const interrupted = new ConversationProjection("ask-interrupted");
  interrupted.hydrateRows(rowsFromOmpEntries(entries(SINGLE, "unused").slice(0, 2)));
  const row = toolOf(interrupted);
  assert.equal(row.status, "cancelled");
  assert.equal(row.output, undefined);
});

test("其他工具即使返回 ask 形状也不生成 answers，原有正文不变", () => {
  const live = liveResult(SINGLE, "written", "success", false, "write");
  const cold = coldResult(SINGLE, "written", false, "write");
  assert.deepEqual(live.output, { text: "written" });
  assert.deepEqual(cold.output, live.output);
});
