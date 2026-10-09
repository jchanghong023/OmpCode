import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

export type SidebarUsageCodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
export type SidebarUsageCodingPlanSourceId = SidebarUsageCodingPlanProviderId | `team:${string}`;
