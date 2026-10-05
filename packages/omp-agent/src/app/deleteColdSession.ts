import { ProtocolError } from "./errors.js";
import type { OmpStorePort } from "./ports.js";

/** 冷会话文件的删除由存储适配器完成；索引变更由 Registry 回调提交。 */
export async function deleteColdSession(input: {
  store: OmpStorePort;
  workspace: { id: string; path: string } | null;
  sessionId: string;
  onDeleted: (workspaceId: string, sessionId: string) => void;
}): Promise<boolean> {
  if (!input.workspace) return false;
  const cold = input.store.findSession
    ? await input.store.findSession(input.workspace.path, input.sessionId)
    : (await input.store.listSessions(input.workspace.path)).find(
        (session) => session.sessionId === input.sessionId,
      );
  if (!cold) return false;
  // Bug 根因：旧实现忽略存储层 false，仍广播删除成功；失败时历史会在重启后复活。
  // 修复（S7-7）：与 deleteLoadedSession 收敛为同一错误面 ProtocolError(-32603)，
  // 不再以裸 Error 退化为无类别的内部错误。
  if (!(await input.store.deleteSession(cold.sessionPath))) {
    throw new ProtocolError(-32603, `cannot delete omp session: ${input.sessionId}`);
  }
  input.onDeleted(input.workspace.id, input.sessionId);
  return true;
}
