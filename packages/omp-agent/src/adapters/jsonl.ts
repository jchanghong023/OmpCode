// 单行 JSON 解析（NDJSON 帧）：空行与非法 JSON 静默为 null，由调用方决定丢弃策略。

export function parseJson(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
