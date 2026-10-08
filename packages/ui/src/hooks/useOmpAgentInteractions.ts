import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import {
  createOmpAgentInteractionsReader,
  EMPTY_OMP_AGENT_INTERACTIONS_STATE,
  type OmpAgentInteractionsReadState,
} from "@/lib/OmpAgentInteractionsReader.js";
import type { OpenOmpAgentInteractionsSideTabRequest } from "@/lib/workspaceSidePane.js";

const REFRESH_INTERVAL_MS = 2_000;

export function useOmpAgentInteractions(
  options: OpenOmpAgentInteractionsSideTabRequest & { enabled: boolean },
) {
  const { zcodeAgentService } = useServices();
  const { workspacePath, workspaceIdentity, remoteSessionId, rootSessionId, enabled } = options;
  const scopeKey = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    remoteSessionId ?? null,
    rootSessionId,
  ]);
  const [state, setState] = useState<OmpAgentInteractionsReadState & { scopeKey: string }>(() => ({
    ...EMPTY_OMP_AGENT_INTERACTIONS_STATE,
    scopeKey,
  }));
  const readerRef = useRef<ReturnType<typeof createOmpAgentInteractionsReader> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setState({ ...EMPTY_OMP_AGENT_INTERACTIONS_STATE, scopeKey });
    const reader = createOmpAgentInteractionsReader({
      canRead: () => !document.hidden,
      query: (cursor) =>
        zcodeAgentService.listSessionAgentInteractions({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId: rootSessionId,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        }),
      publish: (next) => setState({ ...next, scopeKey }),
    });
    readerRef.current = reader;
    const refreshVisible = () => {
      if (!document.hidden) void reader.refresh();
    };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [
    enabled,
    remoteSessionId,
    rootSessionId,
    scopeKey,
    workspaceIdentity,
    workspacePath,
    zcodeAgentService,
  ]);

  const refresh = useCallback(() => {
    void readerRef.current?.refresh();
  }, []);
  const loadMore = useCallback(() => {
    void readerRef.current?.loadMore();
  }, []);
  const current = state.scopeKey === scopeKey ? state : EMPTY_OMP_AGENT_INTERACTIONS_STATE;
  return { ...current, refresh, loadMore };
}
