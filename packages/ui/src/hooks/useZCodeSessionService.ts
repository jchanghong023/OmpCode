import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const contextServices = useServices();
  // 引导初始化与工作区切换会改变 path；条件调用 Hook 会破坏同一组件的调用顺序。
  // 缺省目标必须保留当前上下文，不能改用可能指向本机的 workspace baseServices。
  const workspaceServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeSessionService;
}
