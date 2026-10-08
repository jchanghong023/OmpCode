import { memo, useEffect } from "react";
import { OmpAgentInteractionsView } from "@/app-shell/OmpAgentInteractionsView.js";
import { useOmpAgentInteractions } from "@/hooks/useOmpAgentInteractions.js";
import type {
  OmpAgentInteractionsSidePaneTab,
  OmpAgentInteractionsRootBinding,
} from "@/lib/workspaceSidePane.js";

/** 仅由当前可见 tab 挂载；卸载释放查询调度与全部图形资源。 */
export const OmpAgentInteractionsSidePane = memo(function OmpAgentInteractionsSidePane({
  tab,
  onRootResolved,
}: {
  tab: OmpAgentInteractionsSidePaneTab;
  onRootResolved: (binding: OmpAgentInteractionsRootBinding) => void;
}) {
  const state = useOmpAgentInteractions({ ...tab, enabled: true });
  const canonicalRootSessionId = state.result?.rootSessionId;
  useEffect(() => {
    if (!canonicalRootSessionId || canonicalRootSessionId === tab.rootSessionId) return;
    onRootResolved({
      tabId: tab.id,
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      remoteSessionId: tab.remoteSessionId,
      rootSessionId: tab.rootSessionId,
      canonicalRootSessionId,
    });
  }, [
    canonicalRootSessionId,
    onRootResolved,
    tab.id,
    tab.remoteSessionId,
    tab.rootSessionId,
    tab.workspaceIdentity,
    tab.workspacePath,
  ]);
  return (
    <div
      className="size-full min-h-0"
      data-testid="omp-agent-interactions"
      data-root-session-id={tab.rootSessionId}
      data-node-count={state.result?.agents.length ?? 0}
      data-message-count={state.result?.events.length ?? 0}
    >
      <OmpAgentInteractionsView
        result={state.result}
        loading={state.loading}
        loadingMore={state.loadingMore}
        error={state.error}
        active
        onRefresh={state.refresh}
        onLoadMore={state.loadMore}
      />
    </div>
  );
});
