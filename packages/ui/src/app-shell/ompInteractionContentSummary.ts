import type { ZCodeAgentInteractionEvent } from "@zcode/shared";

type OmpInteractionSummaryFieldType =
  | "status"
  | "duration"
  | "result"
  | "child_result"
  | "reported_message_count"
  | "structured_count";

interface OmpInteractionSummaryField {
  type: OmpInteractionSummaryFieldType;
  value: string;
  key?: string;
  truncated?: boolean;
}

export interface OmpInteractionContentSummary {
  recognized: boolean;
  structured: boolean;
  summary: string;
  truncated: boolean;
  body: string;
  fields: OmpInteractionSummaryField[];
}

const SUMMARY_LIMIT = 240;
const FIELD_LIMIT = 160;
const MAX_FIELDS = 5;
const RESULT_KEYS = ["summary", "result", "output", "message", "error"] as const;

function clip(text: string, limit: number) {
  const characters = Array.from(text);
  const truncated = characters.length > limit;
  return { value: truncated ? `${characters.slice(0, limit - 1).join("")}…` : text, truncated };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readable(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  if (record(value) && depth < 2) {
    for (const key of [...RESULT_KEYS, "status"]) {
      const text = readable(value[key], depth + 1);
      if (text !== null) return text;
    }
  }
  return null;
}

function parseJson(text: string): { parsed: boolean; value?: unknown } {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(text.trim());
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(candidate) };
  } catch {
    return { parsed: false };
  }
}

/** 只识别完整、平坦的 OMP 包装；不解析 XML 实体，不执行标签或尾部提示。 */
function taskOutput(body: string): { text: string; status?: string; duration?: string } | null {
  const wrapper = /^<task-result\b([^<>]*)>([\s\S]*?)<\/task-result>/u.exec(body.trim());
  if (!wrapper) return null;
  const attributes: Record<string, string> = {};
  let valid = true;
  const remainder = wrapper[1]!.replace(
    /([\w:-]+)\s*=\s*(["'])([^"']*)\2/gu,
    (_, key: string, _quote: string, value: string) => {
      if (Object.hasOwn(attributes, key)) {
        valid = false;
        return "";
      }
      Object.defineProperty(attributes, key, { value, enumerable: true });
      return "";
    },
  );
  const output = /^\s*(?:<meta\b[^<>]*\/?>\s*)?<output\s*>([\s\S]*)<\/output>\s*$/u.exec(
    wrapper[2]!,
  );
  if (!valid || remainder.trim() || !output) return null;
  const duration = attributes.duration;
  return {
    text: output[1]!.trim(),
    ...(attributes.status ? { status: attributes.status } : {}),
    ...(duration && /^\d+(?:\.\d+)?(?:ms|s|m|h)$/u.test(duration) ? { duration } : {}),
  };
}

/** 已知后台交付包装只影响摘要；完整原文仍保留给显式展开。 */
function asyncDeliveryOutput(body: string): { text: string } | null {
  const unwrapped =
    /^<system-notice>\s*([\s\S]*?)\s*<\/system-notice>$/u.exec(body.trim())?.[1] ?? body;
  const match =
    /^Background job ([A-Za-z0-9_.-]+) has completed\. Resume your work using the result below\.\s*([\s\S]*)$/u.exec(
      unwrapped.trim(),
    );
  if (!match) return null;
  const footer = new RegExp(
    `\\n\\n${match[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} is now idle\\b[\\s\\S]*$`,
    "u",
  );
  return { text: match[2]!.replace(footer, "").trim() };
}

export function summarizeOmpInteractionContent(
  event: Pick<ZCodeAgentInteractionEvent, "kind" | "body">,
): OmpInteractionContentSummary {
  const { body } = event;
  const delivery = event.kind === "task_result" ? asyncDeliveryOutput(body) : null;
  const wrapped = event.kind === "task_result" ? taskOutput(delivery?.text ?? body) : null;
  const text = wrapped?.text ?? delivery?.text ?? body;
  const parsed = parseJson(text);
  const fields: OmpInteractionSummaryField[] = [];
  const add = (type: OmpInteractionSummaryFieldType, value: string, key?: string) => {
    if (fields.length < MAX_FIELDS)
      fields.push({ type, ...clip(value, FIELD_LIMIT), ...(key ? { key } : {}) });
  };
  if (wrapped?.status) add("status", wrapped.status);
  if (wrapped?.duration) add("duration", wrapped.duration);
  const metadataFieldCount = fields.length;

  let recognized = Boolean(wrapped || delivery);
  if (record(parsed.value)) {
    const data = parsed.value;
    const status = readable(data.status);
    if (!wrapped?.status && status !== null) {
      add("status", status);
      recognized = true;
    }
    let result: string | null = null;
    const failed = [wrapped?.status, data.status].some(
      (value) =>
        typeof value === "string" && /^(?:error|failed|failure|aborted|cancelled)$/iu.test(value),
    );
    // 失败结果的 error 是原因，不应被通用摘要遮住；普通结果仍优先 summary/result/output。
    for (const key of failed ? ["error", ...RESULT_KEYS] : RESULT_KEYS) {
      result = readable(data[key]);
      if (result !== null) break;
    }
    // task 包装的执行状态与内部结果声明是不同字段，不能把内部 status 覆盖成当前运行状态。
    if (result === null && wrapped?.status) result = status;
    if (result !== null) {
      add("result", result);
      recognized = true;
    }
    const children = Object.entries(data).filter(
      ([key, value]) =>
        key.endsWith("_result") &&
        !/(?:^|_)(?:id|trace|marker)(?:_|$)/u.test(key) &&
        readable(value) !== null,
    );
    if (children[0]) {
      add("child_result", readable(children[0][1])!, children[0][0]);
      recognized = true;
    }
    const sent = data.messages_sent;
    const count = Array.isArray(sent)
      ? sent.length
      : typeof sent === "number" && Number.isSafeInteger(sent) && sent >= 0
        ? sent
        : null;
    if (count !== null) {
      add("reported_message_count", String(count));
      recognized = true;
    }
    for (const [key, value] of children.slice(1)) add("child_result", readable(value)!, key);
  }

  if (parsed.parsed && fields.length === metadataFieldCount) {
    const count = Array.isArray(parsed.value)
      ? parsed.value.length
      : record(parsed.value)
        ? Object.keys(parsed.value).length
        : 0;
    add("structured_count", String(count));
  }
  const summary = parsed.parsed ? { value: "", truncated: false } : clip(text, SUMMARY_LIMIT);
  return {
    recognized,
    structured: Boolean(wrapped) || parsed.parsed,
    summary: summary.value,
    truncated: summary.truncated,
    body,
    fields,
  };
}
