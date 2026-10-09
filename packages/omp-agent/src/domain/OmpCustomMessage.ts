// 原生 custom 消息的普通文本兼容；不执行 extension/TUI renderer，也不改变模型轮次。
import { z } from "zod";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ProjectionStreamHost } from "./projectionStreamText.js";
import { rowBaseFields } from "./projectionTypes.js";

export const ompContentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    name: z.string().optional(),
    id: z.string().optional(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

// AgentMessage 也允许 user/custom 的字符串内容；助手增量仍由 message_update 处理。
export const ompMessageContentSchema = z.union([z.string(), z.array(ompContentBlockSchema)]);
const customFields = {
  customType: z.string(),
  content: ompMessageContentSchema,
  display: z.boolean(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  attribution: z.string().optional(),
  details: z.unknown().optional(),
};
const customMessageSchema = z.union([
  z.object({ role: z.literal("custom"), ...customFields }),
  z.object({ type: z.literal("custom_message"), ...customFields }),
]);

/** 模型侧协调提示由交互观察读面保留原文，不混入主/子执行页的助手正文。 */
export function isOmpCoordinationCustomType(value: unknown): boolean {
  return value === "irc:incoming" || value === "irc:relay" || value === "async-result";
}

/** 仅规范核心标注的 agent steering；用户自己输入的同名包装必须原样保留。 */
export function readableOmpAgentInput(value: unknown): { text: string; sender?: string } | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { attribution?: unknown; steering?: unknown; content?: unknown };
  if (message.attribution !== "agent" || typeof message.content !== "string") return null;
  if (message.steering === true) {
    const match =
      /^(?:\[Wait interrupted by message\]\s*)?<irc from="[^"]+" agent="([^"]+)">\r?\n([\s\S]*)\r?\n<\/irc>$/u.exec(
        message.content,
      );
    if (match) return { text: match[2]!, sender: match[1]! };
  }
  return null;
}

/** 技能正文是模型上下文；冷历史只从核心的显示元数据还原用户调用。 */
export function readableOmpSkillInput(value: unknown): { text: string; timestamp?: number } | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("customType" in value) ||
    value.customType !== "skill-prompt"
  )
    return null;
  const parsed = customMessageSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.customType !== "skill-prompt" ||
    parsed.data.attribution !== "user"
  )
    return null;
  const { details, timestamp } = parsed.data;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const prompt = "prompt" in details ? details.prompt : undefined;
  const name = "name" in details ? details.name : undefined;
  const args = "args" in details ? details.args : undefined;
  const text =
    typeof prompt === "string" && prompt.trim()
      ? prompt
      : typeof name === "string" && /^[a-zA-Z0-9._-]+$/u.test(name)
        ? `/skill:${name}${typeof args === "string" && args ? ` ${args}` : ""}`
        : null;
  if (text === null) return null;
  const createdAt = typeof timestamp === "number" ? timestamp : Date.parse(timestamp ?? "");
  return {
    text,
    ...(Number.isFinite(createdAt) ? { timestamp: createdAt } : {}),
  };
}

/** 同时消费 live AgentMessage 和持久化 custom_message entry；隐藏/非文本消息不泄露到 UI。 */
export function visibleOmpCustomMessage(
  value: unknown,
  includeCoordination = false,
): { text: string; timestamp?: number } | null {
  const parsed = customMessageSchema.safeParse(value);
  // 修复：这些是给模型的通信/后台结果提示包；直接当回复显示会把尾部指导铺满执行页。
  if (
    !parsed.success ||
    !parsed.data.display ||
    // 修复：display=true 是 omp TUI 的技能组件入口，不代表可把注入正文当助手回复。
    parsed.data.customType === "skill-prompt" ||
    (!includeCoordination && isOmpCoordinationCustomType(parsed.data.customType))
  )
    return null;
  const { content, timestamp } = parsed.data;
  let text: string;
  if (typeof content === "string") text = content;
  else {
    const parts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) parts.push(part.text);
    }
    text = parts.join("");
  }
  if (!text) return null;
  const createdAt =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string"
        ? Date.parse(timestamp)
        : undefined;
  return {
    text,
    ...(createdAt !== undefined && Number.isFinite(createdAt) ? { timestamp: createdAt } : {}),
  };
}

/** 保留可见 custom 的原生类型，用于缺失 journal 时的派生显示去重。 */
export function visibleOmpCustomDisplay(value: unknown): {
  customType: string;
  text: string;
  timestamp?: number;
} | null {
  const visible = visibleOmpCustomMessage(value);
  if (!visible) return null;
  return { ...visible, customType: (value as { customType: string }).customType };
}

export function ompCustomDisplayKey(customType: string, text: string): string {
  return JSON.stringify([customType, text]);
}

/** 原生 history 包装与直接 custom entry 共用同一可见性判断。 */
export function nativeOmpCustomDisplayCounts(entries: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const visible of nativeOmpCustomDisplays(entries)) {
    const key = ompCustomDisplayKey(visible.customType, visible.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function nativeOmpCustomDisplays(
  entries: readonly unknown[],
): NonNullable<ReturnType<typeof visibleOmpCustomDisplay>>[] {
  const displays: NonNullable<ReturnType<typeof visibleOmpCustomDisplay>>[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { type?: string; message?: unknown };
    const visible = visibleOmpCustomDisplay(
      record.type === "custom_message" ? record : record.message,
    );
    if (!visible) continue;
    displays.push(visible);
  }
  return displays;
}

/** message_end 才落一条完整行；共享 projection row/seq owner，不触碰流式锚点。 */
export function appendOmpCustomMessage(host: ProjectionStreamHost, message: unknown): void {
  const custom = visibleOmpCustomMessage(message);
  if (!custom) return;
  const rowId = host.nextRowId();
  const turn = host.turn();
  const turnId = turn?.turnId ?? `custom-${rowId}`;
  const row: AssistantTextRow = {
    ...rowBaseFields({
      rowId,
      turnId,
      productTurnId: turn?.productTurnId ?? turnId,
      entityId: `custom-${rowId}`,
      createdAtSeq: host.sequence() + 1,
    }),
    ...(custom.timestamp !== undefined ? { createdAt: custom.timestamp } : {}),
    kind: "assistantText",
    text: custom.text,
    state: "complete",
  };
  host.appendRow(row);
}
