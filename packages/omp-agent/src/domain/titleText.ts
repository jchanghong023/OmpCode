// 会话标题与 prompt 收口语义的纯文本辅助（engine 与 registry 共用）。

/** 首条用户消息 → 会话标题（压缩空白，60 字截断；UTF-16 代理对边界回退一位避免拆散 emoji）。 */
export function deriveTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 60) {
    return normalized;
  }
  // 修复（S3-5）：slice(0, 60) 可能正好落在代理对中间（高位码元收尾），
  // 尾部会渲染成孤立代理乱码；边界落在高位代理时回退一位保持码点完整。
  let cut = 60;
  const code = normalized.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return `${normalized.slice(0, cut)}…`;
}

/** prompt 响应 data.agentInvoked：false=本地命令完成；true/缺省=依赖会话事件收口。 */
export function agentInvokedOf(data: unknown): boolean | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const value = (data as { agentInvoked?: unknown }).agentInvoked;
  return typeof value === "boolean" ? value : null;
}
