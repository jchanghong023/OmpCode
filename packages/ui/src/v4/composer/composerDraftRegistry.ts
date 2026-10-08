import {
  hasV4ComposerDraftContent,
  migrateV4ComposerDraft,
  readV4ComposerDraft,
} from "./composerDraftStore.js";
import { createComposerDraftOwner, type ComposerDraftOwner } from "./composerDraftOwner.js";

const owners = new Map<string, ComposerDraftOwner>();
const aliases = new Map<string, string>();
function key(workspaceKey: string, scopeId: string) {
  return JSON.stringify([workspaceKey, scopeId]);
}
function resolveScope(workspaceKey: string, scopeId: string) {
  const seen = new Set<string>();
  while (!seen.has(scopeId)) {
    seen.add(scopeId);
    const next = aliases.get(key(workspaceKey, scopeId));
    if (!next) break;
    scopeId = next;
  }
  return scopeId;
}

/** 只在同一 renderer 共用 owner；身份隔离不依赖当前显示的物理路径。 */
export function getSharedComposerDraftOwner(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
}) {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  const scopeId = resolveScope(workspaceKey, params.scopeId);
  const storageKey = key(workspaceKey, scopeId);
  let owner = owners.get(storageKey);
  if (!owner) {
    owner = createComposerDraftOwner({
      ...params,
      scopeId,
      draft: readV4ComposerDraft(params.workspacePath, params.workspaceIdentity, scopeId) ?? {
        text: "",
        updatedAt: 0,
      },
    });
    owners.set(storageKey, owner);
    owner.onIdle = () =>
      queueMicrotask(() => {
        const current = owner!.canonical();
        // 保存失败或未完成命令的值仍必须留在唯一 owner 中，不能靠重新读 Storage 丢掉。
        if (current.leaseCount || current.pendingCount || !current.flush()) return;
        for (const [entryKey, entryOwner] of owners) {
          if (entryOwner.canonical() === current) owners.delete(entryKey);
        }
      });
  }
  return owner;
}

/** 只接收已验证的 Host 关系。未挂载来源也从同一个草稿文件原子迁移。 */
export function migrateSharedComposerDraft(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  fromTaskId: string;
  toTaskId: string;
  redirectSourceLookup?: boolean;
}) {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  if (params.fromTaskId === params.toTaskId) return true;
  const fromScope = resolveScope(workspaceKey, params.fromTaskId);
  const toScope = resolveScope(workspaceKey, params.toTaskId);
  if (fromScope === toScope) return true;
  const source = owners.get(key(workspaceKey, fromScope));
  const target = owners.get(key(workspaceKey, toScope));
  const targetDraft = target?.materialize();
  const storedTarget =
    targetDraft ?? readV4ComposerDraft(params.workspacePath, params.workspaceIdentity, toScope);
  const hasExplicitConfigIntent =
    targetDraft?.ompModelEdited === true ||
    targetDraft?.ompThoughtEdited === true ||
    storedTarget?.ompModelEdited === true ||
    storedTarget?.ompThoughtEdited === true;
  const targetHasContentOrPending = Boolean(
    target?.hasUserEdits ||
    target?.pendingCount ||
    (storedTarget && hasV4ComposerDraftContent(storedTarget)),
  );
  // 正文/富内容或 pending 属于目标完整草稿冲突；只有配置意图时与来源内容合并。
  const preferTarget = targetHasContentOrPending;
  const targetConfigDraft = targetDraft ?? storedTarget;
  const sourceDraft = source?.migrationDraft(preferTarget);
  let migrationSourceDraft = sourceDraft;
  if (!preferTarget && hasExplicitConfigIntent && targetConfigDraft) {
    const sourceToMerge =
      sourceDraft ?? readV4ComposerDraft(params.workspacePath, params.workspaceIdentity, fromScope);
    if (sourceToMerge) {
      migrationSourceDraft = {
        ...sourceToMerge,
        modelSelection: targetConfigDraft.modelSelection ?? sourceToMerge.modelSelection,
        ompModelBaseline: targetConfigDraft.ompModelBaseline ?? sourceToMerge.ompModelBaseline,
        ompModelEdited: targetConfigDraft.ompModelEdited,
        ompThoughtEdited: targetConfigDraft.ompThoughtEdited,
      };
    }
  }
  const result = migrateV4ComposerDraft({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    fromScopeId: fromScope,
    toScopeId: toScope,
    ...(migrationSourceDraft ? { sourceDraft: migrationSourceDraft } : {}),
    ...(targetDraft ? { targetDraft } : {}),
    preferTarget,
    retainConflictingSource: true,
  });
  if (!result.written) return false;
  if (params.redirectSourceLookup !== false) {
    aliases.set(key(workspaceKey, params.fromTaskId), toScope);
    aliases.set(key(workspaceKey, fromScope), toScope);
  }
  if (!result.moved) return true;
  if (result.usedTarget && source) source.preserveMigrationBackup();
  const winner = result.usedTarget ? target : (source ?? target);
  const loser = result.usedTarget ? source : target;
  if (winner && result.draft) {
    winner.retarget(toScope, result.draft);
    if (loser && loser.canonical() !== winner.canonical()) loser.redirectTo(winner);
    owners.delete(key(workspaceKey, fromScope));
    owners.set(key(workspaceKey, toScope), winner);
  } else if (source && result.draft) {
    // 目标只有持久草稿而尚未挂载：同一 source owner 接管已确认的目标值。
    source.retarget(toScope, result.draft, true);
    owners.delete(key(workspaceKey, fromScope));
    owners.set(key(workspaceKey, toScope), source);
  }
  return true;
}
