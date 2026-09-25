/** 只含名称和配置状态；omp 配置中的命令、URL、环境变量不跨 IPC。 */
export interface OmpNativeIntegrationSnapshot {
  profileDir: string;
  projectDir?: string;
  extensions: { name: string; scope: "profile" | "project" }[];
  mcpServers: {
    name: string;
    scope: "profile" | "project";
    enabled: boolean;
    transport: "stdio" | "http" | "sse" | "unknown";
  }[];
  configErrors: ("profile" | "project")[];
  connectionStatus: "unavailable";
}
