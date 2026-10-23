export interface ExternalAgentWiring {
  ZCODE_AGENT_SERVER_COMMAND: string;
  ZCODE_AGENT_SERVER_ARGS_JSON: string;
}

/** Select this execution endpoint's command; spawning resolves inherited PATH. */
export function resolveExternalAgentWiring(
  env: Record<string, string | undefined>,
): ExternalAgentWiring {
  const explicitCommand = env.ZCODE_AGENT_SERVER_COMMAND;
  if (explicitCommand !== undefined && !explicitCommand.trim()) {
    throw new Error("ZCODE_AGENT_SERVER_COMMAND must not be empty");
  }
  // 修复依据：用户显式配置优先，否则让实际 spawn 使用当前执行端继承的 PATH，
  // 不探测安装目录，也不在显式命令失效时改用其他 OMP。
  return {
    ZCODE_AGENT_SERVER_COMMAND: explicitCommand?.trim() ?? "omp",
    ZCODE_AGENT_SERVER_ARGS_JSON:
      env.ZCODE_AGENT_SERVER_ARGS_JSON ?? JSON.stringify(["app-server", "--stdio"]),
  };
}
