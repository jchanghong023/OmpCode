import { highestOmpThoughtLevel, type OmpModelCatalog } from "@/v4/composer/ompModelCatalog.js";
import { readComposerRecent } from "@/lib/composerRecent.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/** 普通新任务草稿初始化；保留 Recent 原意图，缺省来自 omp 目录 preferred。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  catalog: OmpModelCatalog,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  const selected = recent?.modelSelection ?? catalog.preferredSelection ?? undefined;
  const entry =
    selected &&
    catalog.entries.find(
      (candidate) =>
        candidate.providerId === selected.providerId && candidate.modelId === selected.modelId,
    );
  const highestThoughtLevel = highestOmpThoughtLevel(entry);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    // Recent 只恢复模型身份；新任务的思考档按该模型当前目录取最高值。
    modelSelection:
      selected && highestThoughtLevel
        ? { ...selected, options: { ...selected.options, reasoningLevel: highestThoughtLevel } }
        : selected,
  };
}
