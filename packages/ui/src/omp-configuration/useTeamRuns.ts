import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OmpTeamRun } from "@zcode/shared";
import type { OmpTeamService } from "./contract.js";

/** Native manager owns execution. This hook holds only a replaceable read projection. */
export function useTeamRuns(
  service: OmpTeamService,
  target: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  },
) {
  const scope = useMemo(
    () => ({ service, ...target }),
    [service, target.workspacePath, target.workspaceIdentity, target.sessionId],
  );
  const [observedScope, setObservedScope] = useState(scope);
  const [runs, setRuns] = useState<OmpTeamRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!target.sessionId) return;
    const generation = epoch.current;
    const sequence = ++readSequence.current;
    try {
      const result = await service.observeOmpTeam({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.sessionId,
        action: "list",
      });
      if (generation !== epoch.current || sequence !== readSequence.current) return;
      setRuns(result.runs ?? []);
      setConnected(true);
      setError(null);
    } catch (reason) {
      if (generation !== epoch.current || sequence !== readSequence.current) return;
      setConnected(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [service, target.workspacePath, target.workspaceIdentity, target.sessionId]);
  useEffect(() => {
    epoch.current++;
    setObservedScope(scope);
    setRuns([]);
    setConnected(false);
    setError(null);
    setBusy(false);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!disposed && target.sessionId)
        timer = setTimeout(() => {
          void poll();
        }, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      epoch.current++;
      clearTimeout(timer);
    };
  }, [refresh, scope, target.sessionId]);
  const stop = useCallback(
    async (jobId: string) => {
      if (!target.sessionId) return;
      const generation = epoch.current;
      setBusy(true);
      try {
        const result = await service.observeOmpTeam({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: target.sessionId,
          action: "stop",
          jobId,
        });
        if (generation !== epoch.current) return;
        if (!result.accepted)
          throw new Error("Team cancellation was not accepted; historical runs cannot be stopped");
        await refresh();
      } catch (reason) {
        if (generation === epoch.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (generation === epoch.current) setBusy(false);
      }
    },
    [service, target.workspacePath, target.workspaceIdentity, target.sessionId, refresh],
  );
  // 切换目标后的首帧 effect 尚未清空旧观测；必须按 owner scope 隔离，避免历史卡串会话。
  const current = observedScope === scope;
  return {
    runs: current ? runs : [],
    error: current ? error : null,
    connected: current && connected,
    busy: current && busy,
    refresh,
    stop,
  };
}
