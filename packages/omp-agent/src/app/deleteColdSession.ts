import type { OmpStorePort } from "./ports.js";

/** 冷会话文件的删除由存储适配器完成；索引变更由 Registry 回调提交。 */
export async function deleteColdSession(input: {
  store: OmpStorePort;
  workspace: { id: string; path: string } | null;
  sessionId: string;
  onDeleted: (workspaceId: string, sessionId: string) => void;
}): Promise<boolean> {
  if (!input.workspace) return false;
  const cold = (await input.store.listSessions(input.workspace.path)).find(
    (session) => session.sessionId === input.sessionId,
  );
  if (!cold) return false;
  await input.store.deleteSession(cold.sessionPath);
  input.onDeleted(input.workspace.id, input.sessionId);
  return true;
}
