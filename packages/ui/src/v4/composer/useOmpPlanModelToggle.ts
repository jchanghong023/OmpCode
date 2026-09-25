import { useCallback } from "react";
import type { RefObject } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { findOmpCatalogEntry, type OmpModelCatalog } from "@/v4/composer/ompModelCatalog.js";
import { ompRoleValueToSelection } from "@/v4/composer/ompModelRoleValue.js";

interface OmpPlanModelToggleParams {
  scopeKey: string;
  stateRef: RefObject<{ scopeKey: string; draft: V4ComposerDraft }>;
  draftConfigRef: RefObject<Partial<SessionConfigState>>;
  catalog: OmpModelCatalog | null;
  updateComposerDraft: (update: (current: V4ComposerDraft) => V4ComposerDraft) => void;
}

/** omp 专属的计划角色模型切换；草稿与配置仍由 Composer scope owner 写入。 */
export async function toggleOmpPlanModel(
  params: OmpPlanModelToggleParams & {
    platform: Pick<IPlatformService, "readOmpModelRoles"> | null;
  },
): Promise<{ success: boolean; error?: string }> {
  const { scopeKey, stateRef, draftConfigRef, catalog, updateComposerDraft, platform } = params;
  if (stateRef.current.scopeKey !== scopeKey) return { success: false, error: "session_changed" };
  const previous = stateRef.current.draft.planModelReturnSelection;
  if (previous !== undefined) {
    updateComposerDraft((current) => ({
      ...current,
      modelSelection: previous ?? undefined,
      planModelReturnSelection: undefined,
    }));
    return { success: true };
  }
  if (!platform?.readOmpModelRoles) return { success: false, error: "platform-unsupported" };
  if (!catalog) return { success: false, error: "model_catalog_unavailable" };
  const before = draftConfigRef.current.modelSelection;
  const result = await platform.readOmpModelRoles().catch((error: unknown) => ({
    success: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (!result.success) return { success: false, error: result.error };
  const planValue = result.roles.find((role) => role.role === "plan")?.value;
  if (!planValue) return { success: false, error: "plan_role_missing" };
  const planSelection = ompRoleValueToSelection(planValue, catalog.entries);
  if (
    !planSelection ||
    !findOmpCatalogEntry(catalog, planSelection.providerId, planSelection.modelId)
  ) {
    return { success: false, error: "plan_model_unavailable" };
  }
  const latest = draftConfigRef.current.modelSelection;
  if (
    stateRef.current.scopeKey !== scopeKey ||
    latest?.providerId !== before?.providerId ||
    latest?.modelId !== before?.modelId ||
    latest?.options?.reasoningLevel !== before?.options?.reasoningLevel
  ) {
    return { success: false, error: "selection_changed" };
  }
  updateComposerDraft((current) => ({
    ...current,
    planModelReturnSelection: before ?? null,
    modelSelection: planSelection,
  }));
  return { success: true };
}

export function useOmpPlanModelToggle(params: OmpPlanModelToggleParams): {
  available: boolean;
  toggle: () => Promise<{ success: boolean; error?: string }>;
} {
  const { scopeKey, stateRef, draftConfigRef, catalog, updateComposerDraft } = params;
  const platform = useOptionalPlatform();
  const toggle = useCallback(
    () =>
      toggleOmpPlanModel({
        scopeKey,
        stateRef,
        draftConfigRef,
        catalog,
        updateComposerDraft,
        platform,
      }),
    [catalog, platform, scopeKey, stateRef, draftConfigRef, updateComposerDraft],
  );

  return { available: Boolean(platform?.readOmpModelRoles && catalog), toggle };
}
