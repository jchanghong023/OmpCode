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
  filePath: string,
  scope: Scope,
): Promise<{
  servers: McpServer[];
  invalid: boolean;
  disabledServers: string[];
  enabledServers: string[];
}> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { servers: [], invalid: false, disabledServers: [], enabledServers: [] };
    return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
    const config = parsed as Record<string, unknown>;
    // OMP 用户主文件可以只保存跨来源名单；畸形服务器表不能伪装成空配置。
    const records = config.mcpServers === undefined ? {} : config.mcpServers;
    if (!records || typeof records !== "object" || Array.isArray(records))
      return { servers: [], invalid: true, disabledServers: [], enabledServers: [] };
    const disabledServers = Array.isArray(config.disabledServers)
      ? config.disabledServers.filter((name): name is string => typeof name === "string")
      : [];
    const enabledServers = Array.isArray(config.enabledServers)
      ? config.enabledServers.filter((name): name is string => typeof name === "string")
      : [];
    let invalid = false;
    const servers = Object.entries(records).flatMap(([name, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalid = true;
        return [];
      }
      const server = value as Record<string, unknown>;
      // 与 OMP discovery 一致，字符串 false/0 也禁用；其余未知值沿用默认启用。
      const enabled =
        server.enabled !== false &&
        !(typeof server.enabled === "string" && /^(?:false|0)$/iu.test(server.enabled));
      return [{ name, scope, enabled, transport: serverTransport(server) }];
    });
    return { servers, invalid, disabledServers, enabledServers };
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
      mcp: await Promise.all(
        ["mcp.json", ".mcp.json"].map((fileName) => readMcp(join(directory, fileName), scope)),
      ),
    })),
  );
  // OMP discovery 按项目主文件→兼容文件→profile 主文件→兼容文件占名；
  // 禁用项同样占名，不能让较低优先级的同名配置重新启用。
  const servers = new Map<string, McpServer>();
  for (let index = entries.length - 1; index >= 0; index--) {
    for (const config of entries[index]!.mcp) {
      for (const server of config.servers) {
        if (!servers.has(server.name)) servers.set(server.name, server);
      }
    }
  }
  // OMP 只从用户主文件读取跨来源名单；disabled 始终优先于强制 enabled。
  const disabled = new Set(entries[0]?.mcp[0]?.disabledServers ?? []);
  const forcedEnabled = new Set(entries[0]?.mcp[0]?.enabledServers ?? []);
  const mcpServers: McpServer[] = [];
  for (const server of servers.values()) {
    server.enabled =
      !disabled.has(server.name) && (server.enabled || forcedEnabled.has(server.name));
    mcpServers.push(server);
  }
  return {
    profileDir: params.agentDir,
    ...(params.workspacePath ? { projectDir: join(params.workspacePath, ".omp") } : {}),
    extensions: entries.flatMap((entry) => entry.extensions),
    hooks: entries.flatMap((entry) => entry.hooks.hooks),
    hookErrors: entries.filter((entry) => entry.hooks.invalid).map((entry) => entry.scope),
    mcpServers,
    configErrors: entries
      .filter((entry) => entry.mcp.some((config) => config.invalid))
      .map((entry) => entry.scope),
    connectionStatus: "unavailable",
  };
}
