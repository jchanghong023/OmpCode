/** 协议错误（host 侧以 JSON-RPC error code 语义处理）。 */
export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
