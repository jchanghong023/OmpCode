import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IndexProgress,
  WikiRequest,
  WikiResult,
  RepoRequest,
  RepoResult,
} from "@zcode/shared/omp-indexes";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

import type { IndexPageProps } from "./contract.js";
type Request = WikiRequest | RepoRequest;
export function useOmpIndexes(kind: "wiki" | "repo", target: IndexPageProps) {
  type Fields<T> = T extends Request
    ? Omit<T, "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "operationId">
    : never;
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    target.workspaceIdentity,
  );
  const service = resolution.services.zcodeAgentService;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<IndexProgress["progress"] | null>(null);
  const active = useRef<{ id: string; epoch: number } | null>(null);
  const epoch = useRef(0);
  const path = target.workspacePath;
  const identity = target.workspaceIdentity;
  const remoteSessionId = resolution.remoteSessionId ?? target.remoteSessionId;
  const send = useCallback(
    (request: Request): Promise<WikiResult | RepoResult> =>
      kind === "wiki"
        ? service.queryOmpWiki(request as WikiRequest)
        : service.queryOmpRepo(request as RepoRequest),
    [kind, service],
  );
  useEffect(() => {
    const subscription = service.onOmpIndexProgress((event) => {
      if (
        event.kind === kind &&
        event.workspacePath === path &&
        (event.workspaceIdentity?.trim() || event.workspacePath) === (identity?.trim() || path) &&
        event.operationId === active.current?.id
      )
        setProgress(event.progress);
    });
    return () => subscription.dispose();
  }, [service, kind, path, identity]);
  useEffect(() => {
    epoch.current += 1;
    active.current = null;
    setBusy(false);
    setError(null);
    setProgress(null);
    return () => {
      epoch.current += 1;
      const previous = active.current;
      active.current = null;
      if (previous)
        void send({
          action: "cancel",
          workspacePath: path,
          workspaceIdentity: identity,
          remoteSessionId,
          operationId: previous.id,
        }).catch(() => undefined);
    };
  }, [send, path, identity, remoteSessionId]);
  const run = useCallback(
    async <T extends WikiResult | RepoResult>(fields: Fields<Request>): Promise<T | null> => {
      if (active.current || !path || !resolution.rpcReady) return null;
      const operation = { id: crypto.randomUUID(), epoch: epoch.current };
      active.current = operation;
      setBusy(true);
      setError(null);
      setProgress(null);
      try {
        const result = await send({
          ...fields,
          workspacePath: path,
          workspaceIdentity: identity,
          remoteSessionId,
          operationId: operation.id,
        } as Request);
        return active.current === operation && epoch.current === operation.epoch
          ? (result as T)
          : null;
      } catch (cause) {
        if (active.current === operation && epoch.current === operation.epoch)
          setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        if (active.current === operation) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [send, path, identity, remoteSessionId, resolution.rpcReady],
  );
  const cancel = useCallback(async () => {
    const operation = active.current;
    if (!operation) return;
    try {
      await send({
        action: "cancel",
        workspacePath: path,
        workspaceIdentity: identity,
        remoteSessionId,
        operationId: operation.id,
      });
      // 已取消的结果不能覆盖上一代已发布视图；真正索引状态仍由原生服务持有。
      if (active.current === operation) {
        active.current = null;
        setBusy(false);
        setProgress(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [send, path, identity, remoteSessionId]);
  return {
    run,
    cancel,
    busy,
    error,
    progress,
    ready: resolution.rpcReady && Boolean(path),
    remote: resolution.isRemoteTarget,
  };
}
