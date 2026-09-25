// 会话/帧标识生成。uuid v4 即可满足协议对 id 的唯一性要求；这里不做 v7 时间排序，
// 因为 sessions 列表排序以 lastActivityAt 为准，不依赖 id 词序。

let counter = 0;

function randomHex(length: number): string {
  let output = "";
  while (output.length < length) {
    output += Math.floor(Math.random() * 16).toString(16);
  }
  return output;
}

export function createId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${randomHex(6)}`;
}

/** logEpoch：投影代际标识。每个会话引擎在创建时铸造一次，重建投影时换新。 */
export function createLogEpoch(): string {
  return `omp-${Date.now().toString(36)}-${randomHex(10)}`;
}

export function createSubscriptionId(): string {
  return createId("sub");
}

export function createInteractionId(): string {
  return createId("omp-ui");
}

/**
 * omp 会话文件名 → omp 会话 uuid。文件名形如
 * `2026-09-24T13-33-28-741Z_<uuid>.jsonl`（UTC 时间戳带 Z 后缀，字符类必须含 Z）。
 * uuid 是 omp 会话跨应用重启的稳定身份：sessions-index 摘要、sqlite 种子行与
 * resume 都以它为准；适配器期临时 id（omp-session-*）不参与跨重启身份。
 */
export function ompSessionIdOfFilePath(sessionPath: string | null | undefined): string | null {
  if (!sessionPath) {
    return null;
  }
  // 直接锚定路径末尾的 <uuid>.jsonl，不引入 node:path（domain 层禁 IO 依赖）。
  const match = /([0-9a-fA-F-]{36})\.jsonl$/.exec(sessionPath);
  return match?.[1] ?? null;
}
