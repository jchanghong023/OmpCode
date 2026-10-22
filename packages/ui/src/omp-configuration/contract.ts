import type { ModelSelection, OmpProfileState, OmpTeamRequest, OmpTeamRun } from "@zcode/shared";
import type {
  OmpModelRef,
  ZCodeSessionConfigureParams,
  ZCodeSessionConfigureResult,
} from "@zcode/shared";

/** Identity/cwd are routing only; profile is determined by the trusted server. */
export interface OmpConfigurationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}
export interface OmpConfigurationEntryProps extends OmpConfigurationTarget {
  /** Updates the existing per-session composer intent only after runtime success. */
  onTemporaryModelSelected?: (model: OmpModelRef) => void;
  temporaryModelDisabled?: boolean;
}
export interface OmpConfigurationDisposable {
  dispose(): void;
}
/** Configuration commands are implemented by the Host's typed public service. */
export interface OmpConfigurationService {
  getOmpProfiles?: OmpProfileService["getOmpProfiles"];
  configureOmpSession(
    params: OmpConfigurationTarget & ZCodeSessionConfigureParams,
  ): Promise<ZCodeSessionConfigureResult>;
  setModel(
    params: OmpConfigurationTarget & {
      model: ModelSelection;
      persistAsWorkspaceLastUsed: false;
    },
  ): Promise<unknown>;
}
/** Passive lifecycle facts invalidate pending callbacks; they never replay writes. */
export interface OmpConfigurationPanelService extends OmpConfigurationService {
  onDynamicWorkspaceConfigFrame(
    target: Omit<OmpConfigurationTarget, "sessionId">,
  ): (listener: () => void) => OmpConfigurationDisposable;
  onAgentRuntimeRestarted(
    listener: (event: { workspaceKey: string }) => void,
  ): OmpConfigurationDisposable;
  onAgentRuntimeLifecycle?(
    listener: (event: { workspaceKey: string; state: "available" | "unavailable" }) => void,
  ): OmpConfigurationDisposable;
}
export interface OmpConfigurationPanelProps extends OmpConfigurationEntryProps {
  service: OmpConfigurationPanelService;
  onClose: () => void;
}

/** Shell supplies the active execution target; the hook resolves its existing Host services. */
export interface IndexPageProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Read/cancel port; execution remains owned by the native Team manager. */
export interface OmpTeamService {
  observeOmpTeam(
    params: Pick<OmpConfigurationTarget, "workspacePath" | "workspaceIdentity"> & OmpTeamRequest,
  ): Promise<{ runs?: OmpTeamRun[]; run?: OmpTeamRun; accepted?: boolean }>;
}

/** Workspace preference lives in Host settings; active profile is a native runtime fact. */
export interface OmpProfileService {
  getOmpProfiles(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<OmpProfileState>;
  selectOmpProfile(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    profile: string | null;
    expectedRuntimeIdentity: string | null;
    apply: "next-start" | "now";
  }): Promise<OmpProfileState>;
  onAgentRuntimeRestarted(
    listener: (event: { workspaceKey: string }) => void,
  ): OmpConfigurationDisposable;
  onAgentRuntimeLifecycle?(
    listener: (event: { workspaceKey: string; state: "available" | "unavailable" }) => void,
  ): OmpConfigurationDisposable;
}
