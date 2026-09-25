// 会话标题与 prompt 收口语义的纯文本辅助（engine 与 registry 共用）。

/** 首条用户消息 → 会话标题（压缩空白，60 字截断）。 */
export function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
}

/** prompt 响应 data.agentInvoked：false=本地命令完成；true/缺省=依赖会话事件收口。 */
export function agentInvokedOf(data: unknown): boolean | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const value = (data as { agentInvoked?: unknown }).agentInvoked;
  return typeof value === "boolean" ? value : null;
}
