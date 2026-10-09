// NDJSON 编解码：两侧协议（ZCode Protocol 与 omp RPC）都以「一行一个 JSON 对象」传输。
// 只提供纯函数；流的读取与写入在 adapters 层。

export function encodeJsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
