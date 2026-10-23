import type { ModelSelection, OmpProfileState, OmpTeamRequest, OmpTeamRun } from "@zcode/shared";
import type {
  OmpModelRef,
  OmpTeamConfigureRequest,
  ZCodeSessionConfigureParams,
  ZCodeSessionConfigureResult,
} from "@zcode/shared";

/** Identity/cwd are routing only; profile is determined by the trusted server. */
export interface OmpConfigurationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}
/** Global Team configuration needs an execution target, never a chat attachment. */
export type OmpConfigurationPanelTarget = Omit<OmpConfigurationTarget, "sessionId"> & {
  sessionId?: string;
};
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
  configureOmpTeam(
    params: Omit<OmpConfigurationTarget, "sessionId"> & { request: OmpTeamConfigureRequest },
  ): Promise<ZCodeSessionConfigureResult>;
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
export type OmpConfigurationPanelProps = {
  service: OmpConfigurationPanelService;
} & (
  | (OmpConfigurationEntryProps & { mode?: "all"; onClose: () => void })
  /** 内嵌角色页仍绑定真实会话；仅 Team 专页允许没有会话，不能合并两者的 props 分支。 */
  | (OmpConfigurationEntryProps & { mode: "roles-only"; onClose?: () => void })
  | (OmpConfigurationPanelTarget &
      Omit<OmpConfigurationEntryProps, "sessionId"> & {
        mode: "team-only";
        /** Inline cancellation resets the existing controller rather than closing the page. */
        onClose?: () => void;
      })
);

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
