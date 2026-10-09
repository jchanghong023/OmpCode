// 原生记录用于核对实际任务、工具和终态；不从 UI 文案猜测执行完成。
export const calls = (record) =>
  record.flatMap((entry) =>
    entry.message?.role === "assistant" && Array.isArray(entry.message.content)
      ? entry.message.content.filter((block) => block.type === "toolCall")
      : [],
  );

export const children = (record) => [
  ...new Set(
    record.flatMap((entry) =>
      entry.message?.role === "toolResult" && entry.message.toolName === "task"
        ? (entry.message.details?.progress ?? []).map((child) => child.id)
        : [],
    ),
  ),
];

export function terminal(record) {
  const latest = record.filter((entry) => entry.type === "message").at(-1)?.message;
  return (
    (latest?.role === "assistant" && latest.stopReason === "stop") ||
    (latest?.role === "toolResult" &&
      latest.toolName === "yield" &&
      latest.isError !== true &&
      latest.details?.status === "success" &&
      (!Array.isArray(latest.details.type) || latest.details.complete === true))
  );
}
