// omp 富 ask（extension_ui_request method:"ask"）的纯映射：omp 问题集 ↔ ZCode 富问答应答。
// 无状态、无 IO；时序与汇合逻辑在 OmpInteractionProxy，帧契约在 domain/ompFrames。

import type { OmpAskAnswerFrame, OmpAskQuestion } from "../domain/ompFrames.js";
import type { OmpBypassFrame } from "../domain/ompForkFrames.js";
import type { HostUserInputAnswer } from "./ports.js";

// ── ask 映射（载体：extension_ui_request{method:"ask"} → extension_ui_response{answers}）──

export function askDeadlineOf(frame: { timeoutMs?: number }): number | undefined {
  return typeof frame.timeoutMs === "number" && frame.timeoutMs > 0
    ? Date.now() + frame.timeoutMs
    : undefined;
}

/**
 * 宿主应答 → extension_ui_response。answers 变体按题回传
 * （{id, selectedOptions, customInput}，id 必须等于题目 id——oh-my-pi parseAskDialogResponse
 * 按 id 顺序强校验）；decline/cancel = 整个 ask 取消（omp 侧按 cancelled 收口）。
 */
export function askResponseOf(
  frame: { id: string; questions: OmpAskQuestion[] },
  answer: HostUserInputAnswer,
): OmpBypassFrame {
  if (answer.action !== "accept") {
    return { type: "extension_ui_response", id: frame.id, cancelled: true };
  }
  const answers = askAnswersOf(frame, answer);
  if (answers) {
    return { type: "extension_ui_response", id: frame.id, answers };
  }
  const text = answer.freeText?.trim();
  if (text) {
    // 单题自由文本落 customInput；多题无结构答案按取消收口（不伪造逐题答案）。
    return frame.questions.length === 1
      ? {
          type: "extension_ui_response",
          id: frame.id,
          answers: [{ id: frame.questions[0]!.id, selectedOptions: [], customInput: text }],
        }
      : { type: "extension_ui_response", id: frame.id, cancelled: true };
  }
  // 空提交：多选「全不选」与单题显式跳过都以 selectedOptions: [] 表达。
  return {
    type: "extension_ui_response",
    id: frame.id,
    answers: frame.questions.map((question) => ({ id: question.id, selectedOptions: [] })),
  };
}

function askAnswersOf(
  frame: { questions: OmpAskQuestion[] },
  answer: HostUserInputAnswer,
): OmpAskAnswerFrame[] | null {
  if (answer.action !== "accept") {
    return null;
  }
  const content = answer.content;
  if (content && typeof content === "object") {
    const rawAnswers =
      typeof content.answers === "object" &&
      content.answers !== null &&
      !Array.isArray(content.answers)
        ? (content.answers as Record<string, unknown>)
        : {};
    // UI 同时提交 answers（按题文本连接）与 answer_N（数组保真）；优先 answer_N。
    return frame.questions.map((question, index) => {
      const labels = question.options.map((option) => option.label);
      const parsed = parseAskAnswerValue(
        content[`answer_${index}`] ?? rawAnswers[question.question],
        labels,
      );
      return {
        id: question.id,
        selectedOptions: parsed.selected,
        ...(parsed.other ? { customInput: parsed.other } : {}),
      };
    });
  }
  if (answer.optionId) {
    const optionId = answer.optionId;
    const match = frame.questions.find((question) =>
      question.options.some((option) => option.label === optionId),
    );
    if (match) {
      return frame.questions.map((question) =>
        question === match
          ? { id: question.id, selectedOptions: [optionId] }
          : { id: question.id, selectedOptions: [] },
      );
    }
  }
  return null;
}

function parseAskAnswerValue(
  raw: unknown,
  labels: string[],
): { selected: string[]; other?: string } {
  const values = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : typeof raw === "string"
      ? splitJoinedLabels(raw, labels)
      : [];
  const selected: string[] = [];
  const other: string[] = [];
  for (const value of values) {
    if (labels.includes(value)) {
      if (!selected.includes(value)) selected.push(value);
    } else {
      other.push(value);
    }
  }
  return { selected, ...(other.length > 0 ? { other: other.join(", ") } : {}) };
}

/** UI 把多选答案用 ", " 连接；按已知标签切分，无标签命中时整串视为自定义回答。 */
function splitJoinedLabels(joined: string, labels: string[]): string[] {
  if (labels.includes(joined)) return [joined];
  const parts = joined.split(", ");
  return parts.some((part) => labels.includes(part)) ? parts : [joined];
}
