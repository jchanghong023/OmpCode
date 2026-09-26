/** 仅将 omp 附件 admission 失败的具体原因上浮，其他命令仍走原错误呈现。 */
export function ompAttachmentRejectionDetail(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; ack?: { reasonCode?: unknown; message?: unknown } };
  if (
    candidate.code === "ZCODE_V4_COMMAND_REJECTED" &&
    candidate.ack?.reasonCode === "fault.command.attachmentUnsupportedByOmpCore"
  ) {
    return typeof candidate.ack.message === "string" && candidate.ack.message.length > 0
      ? candidate.ack.message
      : null;
  }
  // Host 跨进程错误可能只保留 Error.message，按服务层固定格式提取 ACK 说明。
  const message = error instanceof Error ? error.message : null;
  const marker = "(fault.command.attachmentUnsupportedByOmpCore): ";
  const start = message?.indexOf(marker) ?? -1;
  if (start < 0 || !message) return null;
  const remaining = message.slice(start + marker.length);
  const contextSeparator = remaining.lastIndexOf(" — ");
  return (contextSeparator < 0 ? remaining : remaining.slice(0, contextSeparator)).trim() || null;
}

/** v4 ACK 转本地异常时保留附件拒绝的结构化原因，供输入框直接展示。 */
export function sessionSendRejectionError(
  ack: { reasonCode?: string; message?: string },
  fallback: string,
): Error {
  const error = new Error(ack.reasonCode ?? fallback);
  if (ack.reasonCode === "fault.command.attachmentUnsupportedByOmpCore") {
    Object.assign(error, { code: "ZCODE_V4_COMMAND_REJECTED", ack });
  }
  return error;
}
