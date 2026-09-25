import { highestOmpThoughtLevel, type OmpModelCatalog } from "@/v4/composer/ompModelCatalog.js";
import { readComposerRecent } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，缺省来自 omp 目录 preferred。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  catalog: OmpModelCatalog,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  const selected = recent?.modelSelection ?? catalog.preferredSelection ?? undefined;
  const entry = selected && catalog.entries.find(
    (candidate) => candidate.providerId === selected.providerId && candidate.modelId === selected.modelId,
  );
  const highestThoughtLevel = highestOmpThoughtLevel(entry);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    // Recent 只恢复模型身份；新任务的思考档按该模型当前目录取最高值。
    modelSelection: selected && highestThoughtLevel
      ? { ...selected, options: { ...selected.options, reasoningLevel: highestThoughtLevel } }
      : selected,
  };
}

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
