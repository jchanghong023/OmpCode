import { useCallback } from "react";
import type { RefObject } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { isOmpCapabilityMissingError } from "@/v4/composer/ompModelRolesFallback.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { findOmpCatalogEntry, type OmpModelCatalog } from "@/v4/composer/ompModelCatalog.js";
import { ompRoleValueToSelection } from "@/v4/composer/ompModelRoleValue.js";

interface OmpPlanModelToggleParams {
  workspacePath: string;
  workspaceIdentity?: string;
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
    agentService: Pick<IZCodeAgentService, "getOmpModelRoles">;
    rpcReady: boolean;
    isRemoteTarget: boolean;
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
  if (!catalog) return { success: false, error: "model_catalog_unavailable" };
  if (!params.rpcReady) return { success: false, error: "project_unavailable" };
  const before = draftConfigRef.current.modelSelection;
  let planValue: string | undefined;
  try {
    // 计划模型来自目标项目的有效 role，不能把本机 profile 的角色应用到远端会话。
    const result = await params.agentService.getOmpModelRoles({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const model = result.roles.find((role) => role.roleId === "plan")?.effectiveModel;
    if (model?.provider && model.modelId) {
      planValue = `${model.provider}/${model.modelId}${model.thinkingLevel ? `:${model.thinkingLevel}` : ""}`;
    }
  } catch (error) {
    if (params.isRemoteTarget || !isOmpCapabilityMissingError(error) || !platform?.readOmpModelRoles) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    // 只有本地旧核永久缺能力可读本机配置；暂时不可用不能越过项目角色事实。
    const result = await platform.readOmpModelRoles().catch((readError: unknown) => ({
      success: false as const,
      error: readError instanceof Error ? readError.message : String(readError),
    }));
    if (!result.success) return { success: false, error: result.error };
    planValue = result.roles.find((role) => role.role === "plan")?.value;
  }
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
  const {
    scopeKey,
    stateRef,
    draftConfigRef,
    catalog,
    updateComposerDraft,
    workspacePath,
    workspaceIdentity,
  } = params;
  const platform = useOptionalPlatform();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const toggle = useCallback(
    () =>
      toggleOmpPlanModel({
        scopeKey,
        stateRef,
        draftConfigRef,
        catalog,
        updateComposerDraft,
        platform,
        workspacePath,
        workspaceIdentity,
        agentService: resolution.services.zcodeAgentService,
        rpcReady: resolution.rpcReady,
        isRemoteTarget: resolution.isRemoteTarget,
      }),
    [
      catalog,
      platform,
      scopeKey,
      stateRef,
      draftConfigRef,
      updateComposerDraft,
      workspacePath,
      workspaceIdentity,
      resolution,
    ],
  );

  return { available: Boolean(resolution.rpcReady && catalog), toggle };
}
