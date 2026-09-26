import { ompSessionIdOfFilePath } from "../domain/ids.js";
import type { ConversationEngine } from "./conversationEngine.js";
import { ProtocolError } from "./errors.js";
import type { OmpStorePort } from "./ports.js";

/** 关闭运行中的进程后删持久文件；失败时调用方不得移除历史索引。 */
export async function deleteLoadedSession(
  engine: ConversationEngine,
  store: OmpStorePort,
  requestedId: string,
): Promise<string | null> {
  const persistedPath = await engine.preparePermanentDeletion();
  const stableId = ompSessionIdOfFilePath(persistedPath);
  // Bug 根因：旧删除路径只关闭引擎，历史文件未删，重启后会话复活。
  // Windows 上活跃进程可能持有文件，先释放进程再尝试持久删除。
  if (persistedPath && !(await store.deleteSession(persistedPath))) {
    throw new ProtocolError(-32603, `cannot delete omp session: ${requestedId}`);
  }
  await engine.dispose();
  return stableId;
}
