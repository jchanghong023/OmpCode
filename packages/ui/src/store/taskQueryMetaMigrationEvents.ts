import type { ZCodeTaskMeta } from "@zcode/shared";

const listeners = new Set<(meta: ZCodeTaskMeta) => void>();

/** 元信息已被现有查询缓存接纳后通知；不保有第二份任务或迁移状态。 */
export function publishTaskQueryMetaMigration(meta: ZCodeTaskMeta): void {
  if (!meta.taskIdMigration) return;
  for (const listener of listeners) listener(meta);
}

export function subscribeTaskQueryMetaMigrations(listener: (meta: ZCodeTaskMeta) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
