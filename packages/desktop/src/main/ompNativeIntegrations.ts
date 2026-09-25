import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OmpNativeIntegrationSnapshot } from "@zcode/shared/omp-integrations";

type Scope = "profile" | "project";
type McpServer = OmpNativeIntegrationSnapshot["mcpServers"][number];
type Extension = OmpNativeIntegrationSnapshot["extensions"][number];

async function readExtensions(directory: string, scope: Scope): Promise<Extension[]> {
  const entries = await readdir(join(directory, "extensions"), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) =>
    entry.isDirectory() || (entry.isFile() && /\.(?:ts|js|mjs|cjs)$/iu.test(entry.name)),
  ).map((entry) => ({ name: entry.name, scope }));
}

function serverTransport(value: Record<string, unknown>): McpServer["transport"] {
  if (value.type === "sse") return "sse";
  if (value.type === "http" || typeof value.url === "string") return "http";
  if (typeof value.command === "string") return "stdio";
  return "unknown";
}

async function readMcp(directory: string, scope: Scope): Promise<{
  servers: McpServer[];
  invalid: boolean;
}> {
  let raw: string;
  try {
    raw = await readFile(join(directory, "mcp.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], invalid: false };
    return { servers: [], invalid: true };
  }
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    const records = config.mcpServers;
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      return { servers: [], invalid: true };
    }
    const disabled = new Set(Array.isArray(config.disabledServers)
      ? config.disabledServers.filter((name): name is string => typeof name === "string") : []);
    const servers = Object.entries(records).flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const server = value as Record<string, unknown>;
      return [{ name, scope, enabled: !disabled.has(name) && server.disabled !== true,
        transport: serverTransport(server) }];
    });
    return { servers, invalid: false };
  } catch {
    return { servers: [], invalid: true };
  }
}

/** 读取当前 profile 和本地项目的显式 omp 配置；不推断运行连接状态。 */
export async function readOmpNativeIntegrations(params: {
  agentDir: string;
  workspacePath?: string;
}): Promise<OmpNativeIntegrationSnapshot> {
  const roots: { directory: string; scope: Scope }[] = [{ directory: params.agentDir, scope: "profile" }];
  if (params.workspacePath) roots.push({ directory: join(params.workspacePath, ".omp"), scope: "project" });
  const entries = await Promise.all(roots.map(async ({ directory, scope }) => ({
    scope,
    extensions: await readExtensions(directory, scope),
    mcp: await readMcp(directory, scope),
  })));
  return {
    profileDir: params.agentDir,
    ...(params.workspacePath ? { projectDir: join(params.workspacePath, ".omp") } : {}),
    extensions: entries.flatMap((entry) => entry.extensions),
    mcpServers: entries.flatMap((entry) => entry.mcp.servers),
    configErrors: entries.filter((entry) => entry.mcp.invalid).map((entry) => entry.scope),
    connectionStatus: "unavailable",
  };
}
