// v3 fork surface 交互帧的纯映射：omp permission/ask 帧 ↔ ZCode 权限卡/富问答应答。
// 无状态、无 IO；时序与汇合逻辑在 OmpInteractionProxy，帧契约在 domain/ompFrames。

import type {
  OmpAskAnswer,
  OmpAskRequestFrame,
  OmpAskResponseFrame,
  OmpPermissionOptionId,
  OmpPermissionRequestFrame,
  OmpPermissionResponseFrame,
} from "../domain/ompForkFrames.js";
import type { HostPermissionAnswer, HostUserInputAnswer } from "./ports.js";

// ── v3 permission 映射 ──

export interface PermissionOptionProjection {
  optionId: string;
  label: string;
  kind: "allowOnce" | "allowAlways" | "deny";
  omp: OmpPermissionOptionId;
}

/** omp 六档审批选项 → ZCode 权限卡选项（optionId 是应答回传键；kind 决定 UI 排序与样式）。 */
export function permissionOptionsOf(
  frame: OmpPermissionRequestFrame,
): PermissionOptionProjection[] {
  return [
    { optionId: "allowOnce", label: "Allow once", kind: "allowOnce", omp: "allow_once" },
    // 「Always allow in this session」命中 UI 全局名称表，按会话免确认渲染。
    {
      optionId: "allowSession",
      label: "Always allow in this session",
      kind: "allowAlways",
      omp: "allow_session",
    },
    { optionId: "allowAlways", label: "Always allow", kind: "allowAlways", omp: "allow_always" },
    // 前缀档仅 bash 且服务端给出 prefixSuggestion 时投放。
    ...(frame.prefixSuggestion
      ? [
          {
            optionId: "allowAlwaysPrefix",
            label: `Always allow "${frame.prefixSuggestion.trim()}" commands`,
            kind: "allowAlways" as const,
            omp: "allow_always_prefix" as const,
          },
        ]
      : []),
    { optionId: "deny", label: "Deny", kind: "deny", omp: "reject_once" },
    { optionId: "denyAlways", label: "Always deny", kind: "deny", omp: "reject_always" },
  ];
}

export function permissionOptionsResponseOf(option: PermissionOptionProjection): {
  decision: "allow" | "deny";
  reason: string;
} {
  return option.omp.startsWith("allow")
    ? { decision: "allow", reason: option.label }
    : { decision: "deny", reason: "Denied by user" };
}

export function permissionRiskLevelOf(
  tier: OmpPermissionRequestFrame["tier"],
): "low" | "medium" | "high" {
  // 修复（A7）：帧 schema 的 tier 已放宽为字符串（omp 演进新增档位不应拒帧）；
  // 未知档位按最高风险呈现（fail-closed：宁可让用户多看一眼，绝不降级为 low）。
  // critical 保留给宿主侧更高危场景。
  if (tier === "read") return "low";
  if (tier === "write") return "medium";
  return "high";
}

export function ompOriginToZcode(
  origin: OmpPermissionRequestFrame["origin"],
  parentSessionId: string,
):
  | {
      kind: "subagent";
      agentId: string;
      agentType: string;
      childSessionId: string;
      parentSessionId: string;
    }
  | undefined {
  if (!origin) return undefined;
  // omp origin 只带 subagentId/agentType；childSessionId 用同一 id 稳定标识子会话。
  return {
    kind: "subagent",
    agentId: origin.subagentId,
    agentType: origin.agentType,
    childSessionId: origin.subagentId,
    parentSessionId,
  };
}

/** 宿主 permission 反向请求应答 → 汇入统一应答通道；deny 理由作为 feedback 回传。 */
export function permissionHostAnswerOf(result: HostPermissionAnswer): HostUserInputAnswer {
  if (result.decision === "allow") {
    return { action: "accept", optionId: "allowOnce" };
  }
  const reason = result.reason?.trim();
  // escalate/modify 无 omp 六档等价物，按拒绝本次收口（fail-closed）。
  return reason ? { action: "accept", optionId: "deny", freeText: reason } : { action: "decline" };
}

export function permissionResponseOf(
  frame: OmpPermissionRequestFrame,
  options: PermissionOptionProjection[],
  answer: HostUserInputAnswer,
): OmpPermissionResponseFrame {
  // fail-closed：取消、超时、未知 optionId 一律拒绝本次调用，不留静默放行路径。
  if (answer.action === "accept") {
    const option = options.find((candidate) => candidate.optionId === answer.optionId);
    if (option) {
      const feedback = answer.freeText?.trim();
      return {
        type: "permission_response",
        id: frame.id,
        option: option.omp,
        ...(feedback ? { feedback } : {}),
      };
    }
    const text = answer.freeText?.trim();
    if (text) {
      return { type: "permission_response", id: frame.id, option: "reject_once", feedback: text };
    }
  }
  return { type: "permission_response", id: frame.id, option: "reject_once" };
}

// ── v3 ask 映射 ──

export function askDeadlineOf(frame: OmpAskRequestFrame): number | undefined {
  if (typeof frame.deadlineAt === "number") return frame.deadlineAt;
  return typeof frame.timeoutMs === "number" && frame.timeoutMs > 0
    ? Date.now() + frame.timeoutMs
    : undefined;
}

export function askResponseOf(
  frame: OmpAskRequestFrame,
  answer: HostUserInputAnswer,
): OmpAskResponseFrame {
  if (answer.action !== "accept") {
    // decline/cancel = 整个 ask 工具 abort（rpc-ui-protocol 4.3）。
    return { type: "ask_response", id: frame.id, cancelled: true };
  }
  const answers = askAnswersOf(frame, answer);
  if (answers) {
    return { type: "ask_response", id: frame.id, answers };
  }
  const text = answer.freeText?.trim();
  if (text) {
    // 单题自由文本落 Other；多题无结构答案按「转为对话」收口（辅助对话语义）。
    return frame.questions.length === 1
      ? {
          type: "ask_response",
          id: frame.id,
          answers: [{ questionId: frame.questions[0]!.id, selected: [], other: text }],
        }
      : { type: "ask_response", id: frame.id, chat: text };
  }
  // 空提交：多选「全不选」与单题显式跳过都以 selected: [] 表达。
  return {
    type: "ask_response",
    id: frame.id,
    answers: frame.questions.map((question) => ({ questionId: question.id, selected: [] })),
  };
}

function askAnswersOf(
  frame: OmpAskRequestFrame,
  answer: HostUserInputAnswer,
): OmpAskAnswer[] | null {
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
        questionId: question.id,
        selected: parsed.selected,
        ...(parsed.other ? { other: parsed.other } : {}),
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
          ? { questionId: question.id, selected: [optionId] }
          : { questionId: question.id, selected: [] },
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
