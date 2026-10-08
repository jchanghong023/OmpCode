/** 草稿内容与配置共用一次写入；调度器只持有脏标记，不复制草稿事实。 */
export function createComposerDraftPersistence(options: {
  write: () => boolean;
  delayMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const delayMs = options.delayMs ?? 350;
  const maxWaitMs = options.maxWaitMs ?? 2000;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let dirtySince: number | null = null;

  const flush = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (dirtySince === null) return true;
    const written = options.write();
    // 配额失败保留脏标记，边界 flush 可立即重试；下一次普通编辑重新合批，
    // 否则过期 maxWait 会令每个按键都以 0ms 反复访问失败的 Storage。
    dirtySince = written ? null : now();
    return written;
  };
  const schedule = () => {
    dirtySince ??= now();
    if (timer !== undefined) clearTimer(timer);
    // 单纯防抖会让持续输入永远不保存；最大等待与首个 dirty 时间绑定。
    timer = setTimer(flush, Math.max(0, Math.min(delayMs, maxWaitMs - (now() - dirtySince))));
  };
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    dirtySince = null;
  };
  return { schedule, flush, cancel };
}
