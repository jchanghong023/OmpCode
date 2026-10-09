/* eslint-disable max-lines -- Coding Plan 用量视图集中维护来源选择、额度投影和重置入口；本阶段只迁移 Account Access，不拆分既有 UI 结构。 */
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export interface CodingPlanUsageRemainingEntitlement {
  sourceId?: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string;
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface CodingPlanUsageAvailableProvider {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label: string;
}

export interface CodingPlanUsageRemainingState {
  activeProviderId?: SidebarUsageCodingPlanSourceId;
  displayedEntitlement: CodingPlanUsageRemainingEntitlement | null;
  displayedProviderId?: SidebarUsageCodingPlanSourceId;
  hasAnyActiveCodingPlan: boolean;
  loading: boolean;
  providerEntitlements: CodingPlanUsageRemainingEntitlement[];
  tabProviders: CodingPlanUsageRemainingTabProvider[];
  visibleSnapshot: UsageEntitlementSnapshot | null;
}

interface CodingPlanUsageRemainingTabProvider {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
}

function formatCodingPlanProviderTabAriaLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    ? "Z.ai Coding Plan"
    : "BigModel Coding Plan";
}

function getEntitlementSourceId(
  entitlement: Pick<CodingPlanUsageRemainingEntitlement, "providerId" | "sourceId">,
): SidebarUsageCodingPlanSourceId {
  return entitlement.sourceId ?? entitlement.providerId;
}

function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    Boolean(snapshot.subscription?.details.length)
  );
}

export function resolveCodingPlanUsageRemainingState(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}): CodingPlanUsageRemainingState | null {
  const providerEntitlements = params.entitlements.filter(
    (entitlement) =>
      getEntitlementSourceId(entitlement).startsWith("team:") ||
      params.availableProviders.some((provider) => provider.providerId === entitlement.providerId),
  );
  const selectedEntitlement = providerEntitlements.find(
    (entitlement) => getEntitlementSourceId(entitlement) === params.selectedProviderId,
  );
  const activeEntitlement =
    (selectedEntitlement &&
    hasActiveCodingPlanSnapshot(selectedEntitlement.snapshot, selectedEntitlement.providerId)
      ? selectedEntitlement
      : undefined) ??
    providerEntitlements.find((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    );
  const displayedEntitlement =
    activeEntitlement ?? selectedEntitlement ?? providerEntitlements[0] ?? null;
  const activeProviderId = activeEntitlement
    ? getEntitlementSourceId(activeEntitlement)
    : undefined;
  const displayedProviderId = activeProviderId ?? params.selectedProviderId;
  const loading =
    params.modelProvidersLoading || providerEntitlements.some((entitlement) => entitlement.loading);
  const visibleSnapshot =
    displayedEntitlement &&
    hasActiveCodingPlanSnapshot(displayedEntitlement.snapshot, displayedEntitlement.providerId)
      ? displayedEntitlement.snapshot
      : null;
  const activeCodingPlanProviderIds = providerEntitlements
    .filter((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    )
    .map((entitlement) => getEntitlementSourceId(entitlement));
  const hasAnyActiveCodingPlan = Boolean(activeEntitlement);
  const tabProviders = providerEntitlements
    .filter((entitlement) =>
      activeCodingPlanProviderIds.includes(getEntitlementSourceId(entitlement)),
    )
    .map((entitlement): CodingPlanUsageRemainingTabProvider => {
      const provider = params.availableProviders.find(
        (item) => item.providerId === entitlement.providerId,
      );
      return {
        id: getEntitlementSourceId(entitlement),
        providerId: entitlement.providerId,
        label:
          entitlement.label ??
          provider?.label ??
          formatCodingPlanProviderTabAriaLabel(entitlement.providerId),
      };
    });

  if (
    (!params.modelProvidersLoading && providerEntitlements.length === 0) ||
    (!loading && !hasAnyActiveCodingPlan)
  ) {
    return null;
  }

  return {
    activeProviderId,
    displayedEntitlement,
    displayedProviderId,
    hasAnyActiveCodingPlan,
    loading,
    providerEntitlements,
    tabProviders,
    visibleSnapshot,
  };
}
