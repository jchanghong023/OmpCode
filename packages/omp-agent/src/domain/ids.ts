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
