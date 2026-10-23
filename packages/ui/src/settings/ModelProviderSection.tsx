import { OmpModelManagementPage } from "@/omp-configuration/module.js";

/** Model credentials belong exclusively to the native OMP profile, never the GUI Host. */
export function ModelProviderSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  return (
    <OmpModelManagementPage
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
    />
  );
}
