/** 参数有意义时才占用展示区域；不能用 truthiness 丢掉 0/false。 */
export function hasToolInput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** 文本只在确为 JSON 对象/数组时使用 JSON 代码展示，日志不猜测为 JSON。 */
export function isJsonToolText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
