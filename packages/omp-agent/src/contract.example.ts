import { resolveOmpBinary, type OmpAgentServerOptions } from "./contract.js";

/** Host 只通过公开启动契约获得内嵌二进制路径；会话状态留在适配器内。 */
export function bundledAgentOptions(env: NodeJS.ProcessEnv): OmpAgentServerOptions | null {
  const ompBinaryPath = resolveOmpBinary(env);
  return ompBinaryPath ? { ompBinaryPath, stdio: true } : null;
}
