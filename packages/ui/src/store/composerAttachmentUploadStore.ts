import { create } from "zustand";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";

type ComposerAttachmentUploadStatus =
  | "waitingSession"
  | "queued"
  | "uploading"
  | "committing"
  | "ready"
  | "failed";

export interface ComposerAttachmentUploadItem extends ChatComposerAttachment {
  /**
   * composer-owned 仍处于上传/暂存生命周期；session-owned 是从权威 queue 撤回的既有 ref。
   * 后者已经由 session 接管，runtime restart、cleanup 和 resend 都不能再次处理引用所有权。
   */
  referenceOwnership: "composer" | "session";
  uploadStatus: ComposerAttachmentUploadStatus;
  uploadProgress: number;
  uploadError?: string;
  uploadErrorKind?: "transient" | "permanent" | "runtimeRestarted";
  attachmentRef?: AttachmentRef;
  operationId: string;
  autoRetryCount: number;
  /**
   * 因 runtime 换代触发的重传次数，与上传失败重试分开计。
   * 换代不是「上传失败」，共用计数器会让一次换代就烧掉用户可见的重试配额。
   */
  runtimeRebuildRetryCount: number;
  staged: boolean;
  adopted: boolean;
  showComplete: boolean;
  localZeroCopy: boolean;
}

interface ComposerAttachmentUploadStoreState {
  scopes: Record<string, ComposerAttachmentUploadItem[]>;
  /** scope 的派生 operation 索引；只定位仍在 owner 中的附件，不保存任务 alias。 */
  operationScopes: ReadonlyMap<string, string>;
}

/**
 * renderer 内存态：File/object URL 不落盘，但 task/composer 切换或局部卸载不会丢失。
 * 上传控制器仍由发起该 operation 的 hook 闭包持有，relay/main 不保存业务状态。
 */
export const useComposerAttachmentUploadStore = create<ComposerAttachmentUploadStoreState>()(
  () => ({ scopes: {}, operationScopes: new Map() }),
);

declare global {
  interface Window {
    __zcodeComposerAttachmentUploadStoreE2E?: typeof useComposerAttachmentUploadStore;
    __zcodeCurrentComposerAttachmentScopeKeyE2E?: string;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 只暴露当前唯一附件 owner，供 scope 切换用例准备状态；不再把附件塞回旧 Session Store。
  window.__zcodeComposerAttachmentUploadStoreE2E = useComposerAttachmentUploadStore;
}

export function exposeComposerAttachmentScopeKeyForE2E(scopeKey: string): void {
  if (window.__zcodeComposerAttachmentUploadStoreE2E) {
    window.__zcodeCurrentComposerAttachmentScopeKeyE2E = scopeKey;
  }
}

export function readComposerAttachmentScope(scopeKey: string): ComposerAttachmentUploadItem[] {
  return useComposerAttachmentUploadStore.getState().scopes[scopeKey] ?? [];
}
function operationKey(scopeKey: string, operationId: string): string {
  return `${scopeKey.slice(0, scopeKey.lastIndexOf("\u0000") + 1)}${operationId}`;
}

/** 旧闭包只追随同一个 operation；不能把复用的旧 scope 作为整桶 alias。 */
export function resolveComposerAttachmentOperationScope(
  scopeKey: string,
  operationId: string,
): string {
  const state = useComposerAttachmentUploadStore.getState();
  const ownerScope = state.operationScopes.get(operationKey(scopeKey, operationId));
  return ownerScope && state.scopes[ownerScope]?.some((item) => item.operationId === operationId)
    ? ownerScope
    : scopeKey;
}

function indexScope(
  index: Map<string, string>,
  scopeKey: string,
  previous: readonly ComposerAttachmentUploadItem[],
  next: readonly ComposerAttachmentUploadItem[],
) {
  for (const item of previous) {
    const key = operationKey(scopeKey, item.operationId);
    if (index.get(key) === scopeKey) index.delete(key);
  }
  for (const item of next) index.set(operationKey(scopeKey, item.operationId), scopeKey);
}

export function updateComposerAttachmentScope(
  scopeKey: string,
  update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
): void {
  useComposerAttachmentUploadStore.setState((state) => {
    const previous = state.scopes[scopeKey] ?? [];
    const next = update(previous);
    if (previous === next) return state;
    let operationScopes = state.operationScopes;
    if (
      previous.length !== next.length ||
      previous.some((item, index) => item.operationId !== next[index]?.operationId)
    ) {
      const nextIndex = new Map(operationScopes);
      indexScope(nextIndex, scopeKey, previous, next);
      operationScopes = nextIndex;
    }
    if (next.length === 0) {
      const { [scopeKey]: _removed, ...remainingScopes } = state.scopes;
      return { scopes: remainingScopes, operationScopes };
    }
    return {
      operationScopes,
      scopes: {
        ...state.scopes,
        [scopeKey]: next,
      },
    };
  });
}

/**
 * 原生工具 accepted 只提升会话，不消费编辑器 Submission。附件必须在同一 owner 内移动，
 * 不能复制 File/引用或提前 adopt；否则 promotion 后 chips 消失、旧上传又会回写草稿桶。
 * 目标已有同一附件时以目标为准，其余附件合并，重复调用因来源已空而自然幂等。
 */
export function promoteComposerAttachmentScope(
  sourceScopeKey: string,
  targetScopeKey: string,
): {
  moved: ComposerAttachmentUploadItem[];
  displaced: ComposerAttachmentUploadItem[];
} {
  const result = {
    moved: [] as ComposerAttachmentUploadItem[],
    displaced: [] as ComposerAttachmentUploadItem[],
  };
  const separator = sourceScopeKey.lastIndexOf("\u0000");
  if (
    separator < 0 ||
    sourceScopeKey.slice(separator + 1) !== "__draft__" ||
    !targetScopeKey.startsWith(sourceScopeKey.slice(0, separator + 1)) ||
    targetScopeKey.length <= separator + 1 ||
    targetScopeKey === sourceScopeKey
  ) {
    return result;
  }
  useComposerAttachmentUploadStore.setState((state) => {
    const source = state.scopes[sourceScopeKey] ?? [];
    if (source.length === 0) return state;
    const target = state.scopes[targetScopeKey] ?? [];
    const ids = new Set(target.map((item) => item.id));
    const operations = new Set(target.map((item) => item.operationId));
    for (const item of source) {
      if (ids.has(item.id) || operations.has(item.operationId)) result.displaced.push(item);
      else {
        result.moved.push(item);
        ids.add(item.id);
        operations.add(item.operationId);
      }
    }
    const { [sourceScopeKey]: _removed, ...scopes } = state.scopes;
    const next = [...target, ...result.moved];
    const operationScopes = new Map(state.operationScopes);
    indexScope(operationScopes, sourceScopeKey, source, []);
    indexScope(operationScopes, targetScopeKey, target, next);
    return { scopes: { ...scopes, [targetScopeKey]: next }, operationScopes };
  });
  return result;
}

/**
 * 已接纳的 Host taskIdMigration 专用入口；与 draft-only promotion 分离。
 * session-owned/adopted 内容保持来源；冲突项移交既有附件释放路径，不能留下不可达备份。
 */
export function migrateComposerAttachmentTaskScope(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  fromTaskId: string;
  toTaskId: string;
}): {
  displaced: ComposerAttachmentUploadItem[];
  retained: ComposerAttachmentUploadItem[];
} {
  const result = {
    displaced: [] as ComposerAttachmentUploadItem[],
    retained: [] as ComposerAttachmentUploadItem[],
  };
  const { fromTaskId, toTaskId } = params;
  if (
    !fromTaskId ||
    !toTaskId ||
    fromTaskId === "__draft__" ||
    toTaskId === "__draft__" ||
    fromTaskId === toTaskId ||
    fromTaskId.includes("\u0000") ||
    toTaskId.includes("\u0000")
  )
    return result;
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  const sourceScopeKey = `${workspaceKey}\u0000${fromTaskId}`;
  const targetScopeKey = `${workspaceKey}\u0000${toTaskId}`;
  useComposerAttachmentUploadStore.setState((state) => {
    const source = state.scopes[sourceScopeKey] ?? [];
    const target = state.scopes[targetScopeKey] ?? [];
    const ids = new Set(target.map((item) => item.id));
    const operations = new Set(target.map((item) => item.operationId));
    const moved: ComposerAttachmentUploadItem[] = [];
    const retained: ComposerAttachmentUploadItem[] = [];
    for (const item of source) {
      if (item.referenceOwnership !== "composer" || item.adopted) {
        retained.push(item);
      } else if (ids.has(item.id) || operations.has(item.operationId)) {
        result.displaced.push(item);
      } else {
        moved.push(item);
        ids.add(item.id);
        operations.add(item.operationId);
      }
    }
    if (!moved.length && !result.displaced.length) return state;
    const next = [...target, ...moved];
    result.retained = [...next, ...retained];
    const { [sourceScopeKey]: _removed, ...scopes } = state.scopes;
    if (retained.length) scopes[sourceScopeKey] = retained;
    const operationScopes = new Map(state.operationScopes);
    indexScope(operationScopes, sourceScopeKey, source, retained);
    indexScope(operationScopes, targetScopeKey, target, next);
    return { scopes: { ...scopes, [targetScopeKey]: next }, operationScopes };
  });
  return result;
}
