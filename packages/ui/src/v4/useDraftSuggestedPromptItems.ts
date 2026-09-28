import { useMemo } from "react";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";
import { getRecommendedPromptPool } from "@/v4/featureSuggestedPrompts.js";

export function useDraftSuggestedPromptItems(): DraftSuggestedPromptItem[] {
  const isOfficeMode = useIsOfficeMode();
  return useMemo(() => getRecommendedPromptPool(isOfficeMode), [isOfficeMode]);
}
