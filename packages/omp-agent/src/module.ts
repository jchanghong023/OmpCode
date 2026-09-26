/** omp 会话适配器：内部进程和协议状态由本模块唯一管理。 */
export const ompAgentModule = {
  id: "omp-agent",
  requires: ["shared"],
  provides: ["agent-core-adapter"],
  publicEntrypoints: ["contract.ts"],
} as const;
