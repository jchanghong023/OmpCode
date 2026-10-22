import { useCallback, useEffect, useRef, useState } from "react";
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
      const result = await service.observeOmpTeam({ ...target, action: "list" });
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
  }, [refresh, target.sessionId]);
  const stop = async (jobId: string) => {
    const generation = epoch.current;
    setBusy(true);
    try {
      const result = await service.observeOmpTeam({ ...target, action: "stop", jobId });
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
  };
  return { runs, error, connected, busy, refresh, stop };
}
