import { resolveOmpBinary, type OmpAgentServerOptions } from "./contract.js";
import { zcodeSessionAgentInteractionsParamsSchema } from "@zcode/shared";

/** Host 只通过公开启动契约获得内嵌二进制路径；会话状态留在适配器内。 */
export function bundledAgentOptions(env: NodeJS.ProcessEnv): OmpAgentServerOptions | null {
  const ompBinaryPath = resolveOmpBinary(env);
  return ompBinaryPath ? { ompBinaryPath, stdio: true } : null;
}

/** Host 只读查询复用工作区路由，不能把文件路径或子代理控制参数混入请求。 */
export function agentInteractionQuery(workspacePath: string, sessionId: string) {
  return zcodeSessionAgentInteractionsParamsSchema.parse({
    workspace: { workspacePath, workspaceKey: workspacePath },
    sessionId,
    limit: 200,
  });
}
