export interface DraftSuggestedPromptLocalizedText {
  cn?: string;
  en?: string;
}

export const DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS = "NAVIGATE:AUTOMATIONS" as const;
export const DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK =
  "NAVIGATE:AUTOMATIONS:OFFPEAK" as const;

type DraftSuggestedPromptAction =
  | typeof DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS
  | typeof DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK;

export interface DraftSuggestedPromptItem {
  id: string;
  /** Lucide canonical 名称，只来自 ClientSceneItem.img；不使用 imgs。 */
  iconName?: string;
  /** 官方推荐项的市场图标。 */
  iconUrl?: string;
  /** 复用插件市场图标的展示样式，不代表绑定插件。 */
  iconStyle?: "plugin";
  label: DraftSuggestedPromptLocalizedText;
  prompt: DraftSuggestedPromptLocalizedText;
  actions?: DraftSuggestedPromptAction[];
  plugin?: {
    stableId: string;
    label: DraftSuggestedPromptLocalizedText;
  };
}

export function resolveDraftSuggestedPromptText(
  text: DraftSuggestedPromptLocalizedText,
  locale: string,
): string {
  const primary = locale.startsWith("zh") ? text.cn : text.en;
  const fallback = locale.startsWith("zh") ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}
