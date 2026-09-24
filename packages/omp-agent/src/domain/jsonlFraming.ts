// NDJSON 编解码：两侧协议（ZCode Protocol 与 omp RPC）都以「一行一个 JSON 对象」传输。
// 只提供纯函数；流的读取与写入在 adapters 层。

export function encodeJsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** 解析一行；返回 null 表示空行（跳过），抛错表示非法 JSON（由调用方决定丢弃或终止）。 */
export function decodeJsonlLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return JSON.parse(trimmed);
}
