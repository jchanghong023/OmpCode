import type { ModelSelection } from "@zcode/shared";
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
