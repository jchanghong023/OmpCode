import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  getAskUserQuestionAnswerText,
  normalizeAskUserQuestionInput,
  readAskUserQuestionAnswers,
  readAskUserQuestionInput,
} from "../src/lib/askUserQuestion.js";
import { toolCallRowToLegacyNode } from "../src/v4/toolCallRowAdapter.js";

const question = "Choose the next step";
const noAnswerText = "未提供回答";

function askRow(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn-ask",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "ask-1",
    toolName: "ask",
    status: "success",
    inputText: "",
    input: { question, options: ["Mock answer A", "Mock answer B"] },
    ...overrides,
  };
}

function displayedAnswers(row: ToolCallRow): string[] {
  const { toolCall } = toolCallRowToLegacyNode(row);
  const data = normalizeAskUserQuestionInput(readAskUserQuestionInput(toolCall));
  const answers = readAskUserQuestionAnswers(toolCall) ?? data.answers;
  return data.questions.map((item) => getAskUserQuestionAnswerText(item, answers, noAnswerText));
}

test("ask 已提交选项显示实际答案而不是未回答", () => {
  const row = askRow({
    output: {
      text: "Opaque result text, not an answer source",
      answers: { [question]: ["Mock answer A", "Mock answer B"] },
    },
  });
  assert.deepEqual(displayedAnswers(row), ["Mock answer A，Mock answer B"]);
});

test("ask 自定义回答与选择项一起显示", () => {
  const row = askRow({
    output: {
      text: "Submitted",
      answers: { [question]: ["Mock answer A", "My custom answer"] },
    },
  });
  assert.deepEqual(displayedAnswers(row), ["Mock answer A，My custom answer"]);
});

test("ask 无结构化答案时不从自然语言正文伪造回答", () => {
  const row = askRow({ output: { text: "User selected: Mock answer A" } });
  assert.deepEqual(displayedAnswers(row), [noAnswerText]);
});

test("ask 失败或取消不展示残留的已提交答案", () => {
  for (const status of ["error", "cancelled"] as const) {
    const row = askRow({
      status,
      output: { text: "Not submitted", answers: { [question]: ["Mock answer A"] } },
    });
    assert.deepEqual(displayedAnswers(row), [noAnswerText]);
  }
});

test("非 ask 工具结果保留既有文本形态", () => {
  for (const toolName of ["write", "read", "task", "Agent", "Task", "Bash"]) {
    const row = askRow({
      toolName,
      input: {},
      output: { text: "Original tool result", answers: { [question]: ["Mock answer A"] } },
    });
    assert.equal(toolCallRowToLegacyNode(row).toolCall.output, "Original tool result");
  }
});
