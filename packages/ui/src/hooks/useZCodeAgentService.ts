import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const contextServices = useServices();
  // path 在引导/工作区切换时可变，条件调用 Hook 会改变顺序；缺省目标仍取当前上下文。
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeAgentService;
}
