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
};
const customMessageSchema = z.union([
  z.object({ role: z.literal("custom"), ...customFields }),
  z.object({ type: z.literal("custom_message"), ...customFields }),
]);

/** 同时消费 live AgentMessage 和持久化 custom_message entry；隐藏/非文本消息不泄露到 UI。 */
export function visibleOmpCustomMessage(
  value: unknown,
): { text: string; timestamp?: number } | null {
  const parsed = customMessageSchema.safeParse(value);
  if (!parsed.success || !parsed.data.display) return null;
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
