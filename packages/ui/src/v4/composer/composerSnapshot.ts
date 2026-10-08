import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

/** Composer 展示只消费这些字段，提交事实另从 pane 的最新快照读取。 */
export interface ComposerSnapshot {
  inputRouting: Pick<ConversationSnapshot["inputRouting"], "mode">;
  control: Pick<ConversationSnapshot["control"], "canStop" | "phase">;
  config: Pick<ConversationSnapshot["config"], "provider" | "model" | "followupMode">;
  usage: ConversationSnapshot["usage"];
  backgroundWorks: ConversationSnapshot["backgroundWorks"];
  hasHistoryMessages: boolean;
}

export function projectComposerSnapshot(
  snapshot: ConversationSnapshot | null,
  previous: ComposerSnapshot | null,
): ComposerSnapshot | null {
  if (!snapshot) return null;
  const hasHistoryMessages = snapshot.rows.totalCount > 0;
  if (
    previous &&
    previous.inputRouting.mode === snapshot.inputRouting.mode &&
    previous.control.canStop === snapshot.control.canStop &&
    previous.control.phase === snapshot.control.phase &&
    previous.config.provider === snapshot.config.provider &&
    previous.config.model === snapshot.config.model &&
    previous.config.followupMode === snapshot.config.followupMode &&
    previous.usage === snapshot.usage &&
    previous.backgroundWorks === snapshot.backgroundWorks &&
    previous.hasHistoryMessages === hasHistoryMessages
  )
    return previous;
  return {
    inputRouting: { mode: snapshot.inputRouting.mode },
    control: { canStop: snapshot.control.canStop, phase: snapshot.control.phase },
    config: {
      provider: snapshot.config.provider,
      model: snapshot.config.model,
      followupMode: snapshot.config.followupMode,
    },
    usage: snapshot.usage,
    backgroundWorks: snapshot.backgroundWorks,
    hasHistoryMessages,
  };
}
