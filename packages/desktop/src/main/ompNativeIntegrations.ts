import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OmpNativeIntegrationSnapshot } from "@zcode/shared/omp-integrations";

type Scope = "profile" | "project";
type McpServer = OmpNativeIntegrationSnapshot["mcpServers"][number];
type Extension = OmpNativeIntegrationSnapshot["extensions"][number];
type Hook = OmpNativeIntegrationSnapshot["hooks"][number];

async function readHooks(
  directory: string,
  scope: Scope,
): Promise<{ hooks: Hook[]; invalid: boolean }> {
  const phases = await Promise.all(
    (["pre", "post"] as const).map(async (phase) => {
      try {
        const entries = await readdir(join(directory, "hooks", phase), { withFileTypes: true });
        return {
          hooks: entries
            .filter((entry) => entry.isFile() && /\.(?:ts|js)$/iu.test(entry.name))
            .map((entry) => ({ name: entry.name, scope, phase })),
          invalid: false,
        };
      } catch (error) {
        // 目录未创建是空配置；权限或 IO 失败不能伪装成没有钩子。
        return { hooks: [], invalid: (error as NodeJS.ErrnoException).code !== "ENOENT" };
      }
    }),
  );
  return {
    hooks: phases.flatMap((entry) => entry.hooks),
    invalid: phases.some((entry) => entry.invalid),
  };
}

async function readExtensions(directory: string, scope: Scope): Promise<Extension[]> {
  const entries = await readdir(join(directory, "extensions"), { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() || (entry.isFile() && /\.(?:ts|js|mjs|cjs)$/iu.test(entry.name)),
    )
    .map((entry) => ({ name: entry.name, scope }));
}

function serverTransport(value: Record<string, unknown>): McpServer["transport"] {
  if (value.type === "sse") return "sse";
  if (value.type === "http" || typeof value.url === "string") return "http";
  if (typeof value.command === "string") return "stdio";
  return "unknown";
}

async function readMcp(
  directory: string,
  scope: Scope,
): Promise<{
  servers: McpServer[];
  invalid: boolean;
  disabledServers: string[];
  enabledServers: string[];
}> {
  let raw: string;
  try {
    raw = await readFile(join(directory, "mcp.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { servers: [], invalid: false, disabledServers: [], enabledServers: [] };
    return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
  }
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    const records = config.mcpServers;
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
    }
    const disabledServers = Array.isArray(config.disabledServers)
      ? config.disabledServers.filter((name): name is string => typeof name === "string")
      : [];
    const enabledServers = Array.isArray(config.enabledServers)
      ? config.enabledServers.filter((name): name is string => typeof name === "string")
      : [];
    const servers = Object.entries(records).flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const server = value as Record<string, unknown>;
      return [
        { name, scope, enabled: server.enabled !== false, transport: serverTransport(server) },
      ];
    });
    return { servers, invalid: false, disabledServers, enabledServers };
  } catch {
    return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
  }
}

/** 读取当前 profile 和本地项目的显式 omp 配置；不推断运行连接状态。 */
export async function readOmpNativeIntegrations(params: {
  agentDir: string;
  workspacePath?: string;
}): Promise<OmpNativeIntegrationSnapshot> {
  const roots: { directory: string; scope: Scope }[] = [
    { directory: params.agentDir, scope: "profile" },
  ];
  if (params.workspacePath)
    roots.push({ directory: join(params.workspacePath, ".omp"), scope: "project" });
  const entries = await Promise.all(
    roots.map(async ({ directory, scope }) => ({
      scope,
      extensions: await readExtensions(directory, scope),
      hooks: await readHooks(directory, scope),
      mcp: await readMcp(directory, scope),
    })),
  );
  // omp 的用户名单跨 profile/project 来源生效；disabled 优先于强制 enabled。
  const disabled = new Set(entries[0]?.mcp.disabledServers ?? []);
  const forcedEnabled = new Set(entries[0]?.mcp.enabledServers ?? []);
  return {
    profileDir: params.agentDir,
    ...(params.workspacePath ? { projectDir: join(params.workspacePath, ".omp") } : {}),
    extensions: entries.flatMap((entry) => entry.extensions),
    hooks: entries.flatMap((entry) => entry.hooks.hooks),
    hookErrors: entries.filter((entry) => entry.hooks.invalid).map((entry) => entry.scope),
    mcpServers: entries
      .flatMap((entry) => entry.mcp.servers)
      .map((server) => ({
        ...server,
        enabled: !disabled.has(server.name) && (server.enabled || forcedEnabled.has(server.name)),
      })),
    configErrors: entries.filter((entry) => entry.mcp.invalid).map((entry) => entry.scope),
    connectionStatus: "unavailable",
  };
}
