/**
 * omp-configuration 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const ompConfigurationModule = {
  id: "omp-configuration",
  requires: ["shared", "ui", "services", "omp-index-protocol"],
  provides: ["omp-configuration"],
  publicEntrypoints: ["contract.ts", "module.ts"],
} as const;

/** Runtime composition lives here; contract.ts contains only types and ports. */
export { OmpConfigurationController } from "./controller.js";
export { OmpConfigurationPanel } from "./OmpConfigurationPanel.js";
export { OmpConfigurationEntry } from "./OmpConfigurationEntry.js";
export { TeamPage, OmpWorkspaceProfiles, type TeamPageProps } from "./TeamPage.js";
export { WikiPage } from "./WikiPage.js";
export { RepoPage } from "./RepoPage.js";
export { useTeamRuns } from "./useTeamRuns.js";
export { TeamChatCard, TeamRunView } from "./TeamRunView.js";
export { OmpTeamRunSidePane } from "./OmpTeamRunSidePane.js";
