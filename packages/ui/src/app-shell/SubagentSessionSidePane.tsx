import { memo, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { OmpSubagentControlBar } from "@/app-shell/OmpSubagentControlBar.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <div className="flex size-full min-h-0 flex-col">
        {/* Fork（omp-project-mode.md）：omp 合成地址的显式控制入口（Z15）；其余保持只读。 */}
        {tab.childSessionId.startsWith("omp-subagent:") ? (
          <OmpSubagentControlBar
            key={JSON.stringify([
              tab.workspaceIdentity?.trim() || tab.workspacePath,
              tab.remoteSessionId,
              tab.childSessionId,
            ])}
            workspacePath={tab.workspacePath}
            workspaceIdentity={tab.workspaceIdentity}
            remoteSessionId={tab.remoteSessionId}
            childSessionId={tab.childSessionId}
          />
        ) : null}
        <SessionPane
          paneId={tab.id}
          sessionId={tab.childSessionId}
          openTrigger="subagent"
          rootSessionId={tab.rootSessionId}
          readOnly
          allowWorkspaceFileRewind
          focused={focused}
          telemetryVisible={focused}
          workspacePath={tab.workspacePath}
          workspaceIdentity={tab.workspaceIdentity}
          remoteSessionId={tab.remoteSessionId}
          onOpenBrowserUrl={onOpenBrowserUrl}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenSubagentSession={onOpenSubagentSession}
          onOpenBackgroundBash={onOpenBackgroundBash}
        />
      </div>
    </V4PaneConversationProvider>
  );
});
