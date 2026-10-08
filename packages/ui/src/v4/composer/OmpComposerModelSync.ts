import type { ModelSelection } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

function sameModelSelection(left: ModelSelection | undefined, right: ModelSelection): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/** OMP 模型事实变化只同步未编辑的草稿字段；重复快照不重新消费。 */
export function applyOmpComposerModelSync(
  draft: V4ComposerDraft,
  config: Partial<SessionConfigState>,
): V4ComposerDraft {
  // modelSelection 是旧提交意图；/plan 的实际切换来自 effective provider/model/thought。
  const providerId = config.provider?.trim();
  const modelId = config.model?.trim();
  if (!providerId || !modelId) return draft;
  const reasoningLevel = config.thought?.trim();
  const selection: ModelSelection = {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
  const baseline = draft.ompModelBaseline;
  if (sameModelSelection(baseline, selection)) return draft;
  // 第一次仅记游标：新任务最高档可能不同于 OMP 初始档，旧草稿也可能有手动选择。
  if (!baseline) return { ...draft, ompModelBaseline: selection };
  // 根因：草稿曾只初始化一次，OMP /plan 切换或恢复模型后，下一次发送会写回旧模型。
  // 显式改选归草稿 owner；其余字段随同一 OMP 快照更新，不创建第二条模型写路径。
  const current = draft.modelSelection;
  const nextModel = draft.ompModelEdited ? current : selection;
  if (!nextModel) return { ...draft, ompModelBaseline: selection };
  const nextThought = draft.ompThoughtEdited
    ? current?.options?.reasoningLevel
    : draft.ompModelEdited
      ? current?.options?.reasoningLevel
      : selection.options?.reasoningLevel;
  const nextSelection: ModelSelection = {
    providerId: nextModel.providerId,
    modelId: nextModel.modelId,
    ...(nextThought ? { options: { reasoningLevel: nextThought } } : {}),
  };
  return {
    ...draft,
    ompModelBaseline: selection,
    // 保持未改写意图的引用，命令 ACK 的原意图守卫才能区分运行时回投和用户另选。
    modelSelection: sameModelSelection(current, nextSelection) ? current : nextSelection,
  };
}
