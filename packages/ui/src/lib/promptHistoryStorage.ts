import { MAX_PROMPT_HISTORY } from "@/lib/promptHistory.js";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROMPT_HISTORY_STORAGE_KEY_PREFIX = "zcode-chat-prompt-history:";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// 持久化身份键统一口径：workspaceIdentity（trim 后非空）优先，否则回退 workspacePath。
// 与 composerRecent.ts 的 resolveComposerRecentKey 同款（AGENTS.md Workspace Identity 红线：
// 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于持久化）。
// 导出仅为单测覆盖 identity 优先 / 空 identity 回退 path 两个分支。
//
// 兼容性：不做旧 key 迁移。本地 workspace（无 identity）的统一键与旧路径键逐字节相同，
// 历史自然保留；带 identity 的远程 workspace 换新键正是本修复要达成的身份隔离，
// 若把旧的路径键历史搬进 identity 键反而会重新引入跨 identity 串历史，故接受这部分
// 纯本地 UX 数据的一次性丢失。
export function resolvePromptHistoryStorageKey(workspacePath: string, workspaceIdentity?: string) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${workspaceKey}`;
}

function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(
  workspacePath: string,
  workspaceIdentity?: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const rawValue = storage?.getItem(
    resolvePromptHistoryStorageKey(workspacePath, workspaceIdentity),
  );
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizePromptHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspacePath: string,
  entries: readonly string[],
  workspaceIdentity?: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  const normalizedEntries = normalizePromptHistoryEntries(entries);

  // 之前聊天输入历史只挂在 ChatView 内存里，刷新页面或重启窗口后就会整段丢失，
  // 用户按上键也拿不到刚发过的消息。这里改成按 workspace 写入 localStorage，
  // 既保留重开后的历史，又避免不同项目之间把提示词历史串在一起。
  storage?.setItem(
    resolvePromptHistoryStorageKey(workspacePath, workspaceIdentity),
    JSON.stringify(normalizedEntries),
  );
}
