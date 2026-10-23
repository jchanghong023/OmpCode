import { useEffect, useState } from "react";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 路径就绪与清空不能改变 hook 序列；无目标仍返回原有全局 context，而非猜测工作区。
  const globalServices = useServices();
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return (workspacePath ? workspaceServices : globalServices).zcodeAgentService;
}

/** Only native launch facts select persistence; pending UI preferences never select a key. */
export function useOmpStorageScope(
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string | null,
): string | null {
  const service = useZCodeAgentService(workspacePath, remoteSessionId, workspaceIdentity);
  const targetKey = resolveWorkspaceKey({ workspacePath, workspaceIdentity });
  const routeKey = JSON.stringify([targetKey, remoteSessionId ?? null]);
  const [fact, setFact] = useState<{
    key: string;
    service: IZCodeAgentService;
    scope: string | null;
  } | null>(null);
  useEffect(() => {
    // Root 初始化时 workspace 尚未解析会传空串；它不是 cwd，不能为 scope 观察启动默认进程。
    if (!workspacePath.trim()) {
      setFact(null);
      return;
    }
    let disposed = false;
    let generation = 0;
    const refresh = () => {
      const epoch = ++generation;
      setFact(null);
      void service
        .getOmpProfiles({ workspacePath, workspaceIdentity })
        .then((state) => {
          if (!disposed && epoch === generation)
            setFact({ key: routeKey, service, scope: state.storageScope ?? null });
        })
        .catch(() => {
          // 无可信启动事实时不落入共享默认域；下次 lifecycle available 再读。
        });
    };
    refresh();
    const restarted = service.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey === targetKey) refresh();
    });
    const lifecycle = service.onAgentRuntimeLifecycle?.((event) => {
      if (event.workspaceKey !== targetKey) return;
      if (event.state === "available") refresh();
      else {
        generation++;
        setFact(null);
      }
    });
    return () => {
      disposed = true;
      generation++;
      restarted.dispose();
      lifecycle?.dispose();
    };
  }, [service, workspacePath, workspaceIdentity, targetKey, routeKey]);
  return fact?.key === routeKey && fact.service === service ? fact.scope : null;
}
