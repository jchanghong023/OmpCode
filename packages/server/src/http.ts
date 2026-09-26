/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, parse, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  botProviders,
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const maxBufferedBytes = 16 * 1024 * 1024;
  const drainedBytes = 1024 * 1024;
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        // Bug 根因：ws.send 在慢客户端上持续排队且没有缓冲上限。
        // 关闭此连接让手机通过原有快照/水位恢复，不能悄悄丢帧。
        if (ws.bufferedAmount + buffer.byteLength > maxBufferedBytes) {
          ws.terminate();
          return;
        }
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (ws.readyState !== ws.OPEN) return reject(new Error("WebSocket closed before drain"));
          if (ws.bufferedAmount <= drainedBytes) return resolve();
          setTimeout(check, 10);
        };
        check();
      });
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  // F31：可选的关闭链追加回调。/ws/remote/:id 用它把已认领 RemoteConnection 的收口
  // 挂进同一条 onClose 链（wrapWebSocket 在 close/error 时都会触发 onClose）。
  onSocketClosed?: () => void,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
    onSocketClosed?.();
  });
}

/**
 * 把认领成功的 RemoteConnection 挂接到认领它的 WS（修复 F31）。
 *
 * 所有权链：RemoteConnectionStore（未认领窗口，claim TTL 兜底 dispose）→ WS（认领后）。
 * 此前 claim 取出后 RemoteConnection（SSH/WSL/Docker 通道 + 远端 server 进程）没有任何
 * dispose 调用点，store 只覆盖未认领窗口，浏览器每次刷新都会泄漏一条远端连接。
 * 收口挂入 wrapWebSocket 的 onClose 链（close/error 都触发），并使用 disposeAndWait
 * 而非 dispose：它保持 connect.ts 的正常关闭顺序——先 stdin EOF 让远端 server 自然退出、
 * 在超时窗口内等待流关闭，超时才由 backend 兜底 kill；同步 dispose 会立即释放 backend，
 * 与该宽限语义相悖。disposeAndWait 自身幂等（disposalStarted / disposeAndWaitInFlight
 * 门禁），与 rawServer/connectionScope 的清理互不依赖，可安全共置一条关闭链。
 */
export function attachClaimedRemoteConnection(ws: WebSocket, connection: RemoteConnection): void {
  // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
  const remoteServices = new ServiceCollection()
    .register(IFileService, connection.services.fileService)
    .register(IGitService, connection.services.gitService)
    .register(ISystemService, connection.services.systemService)
    .register(ITerminalService, connection.services.terminalService);
  setupChannelServer(ws, remoteServices, "web-remote-replayable", () => {
    void connection.disposeAndWait().catch((error: unknown) => {
      // disposeAndWait 正常不 reject；backend 兜底路径失败时至少留日志，
      // 避免 fire-and-forget 的未处理 rejection 吞掉远端进程清理故障。
      log(
        "remote connection dispose failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });
}

/**
 * 未认领远程连接的认领超时：POST /api/connect-remote 成功后客户端应尽快通过
 * /ws/remote/:id 建立 WS；60s 足以覆盖正常页面加载/网络抖动窗口，超时即视为放弃。
 */
const REMOTE_CONNECTION_CLAIM_TIMEOUT_MS = 60_000;
/**
 * 未认领远程连接池上限：每条未认领连接都对应一条真实远端 server 进程与 SSH/WSL/Docker
 * 通道，超时窗口内高频调用 /api/connect-remote 会造成资源堆积，超限直接拒绝。
 * 取值远大于正常单客户端并发需求，只拦截异常堆积。
 */
const REMOTE_CONNECTION_MAX_PENDING = 32;

export interface RemoteConnectionStoreOptions {
  /** 认领超时（毫秒）；超时未认领即 dispose 并移除。测试可注入极短值。 */
  claimTimeoutMs?: number;
  /** 未认领条目上限；超限时 tryStore 返回 false，由调用方 dispose 并拒绝。 */
  maxPending?: number;
}

/**
 * 未认领远程连接注册表（修复 F13 泄漏）。
 *
 * 此前 POST /api/connect-remote 建立的连接存入模块级 Map 后，唯一删除点是
 * /ws/remote/:id 首次认领（取出即删除）；客户端 POST 成功后未建立 WS（刷新、断网、
 * 重试）时，条目连同 backend 连接与远端 server 进程永久泄漏，且 Map 无上限无 TTL。
 * 现在：
 * - 存入时登记认领超时定时器，到期未认领则移除条目并 dispose 连接（RemoteConnection
 *   的同步 dispose 会关闭 RPC client/protocol/stdin 并释放 backend，见 remote/connect.ts）；
 * - 首次认领取出时清除定时器；
 * - 容量上限防止高频创建在超时窗口内绕过清理。
 */
export class RemoteConnectionStore {
  private readonly entries = new Map<
    string,
    { connection: RemoteConnection; claimTimer: ReturnType<typeof setTimeout> }
  >();
  private readonly claimTimeoutMs: number;
  private readonly maxPending: number;

  constructor(options: RemoteConnectionStoreOptions = {}) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? REMOTE_CONNECTION_CLAIM_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? REMOTE_CONNECTION_MAX_PENDING;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 存入新连接并启动认领超时；返回 false 表示已达上限（调用方必须 dispose 该连接）。 */
  tryStore(id: string, connection: RemoteConnection): boolean {
    if (this.entries.size >= this.maxPending) {
      return false;
    }
    // generateId 冲突（极低概率）路径：旧条目尚未被认领时，必须先清其定时器并 dispose
    // 旧连接，再覆盖，防止覆盖路径绕过清理造成泄漏。
    const previous = this.entries.get(id);
    if (previous) {
      clearTimeout(previous.claimTimer);
      previous.connection.dispose();
    }
    const claimTimer = setTimeout(() => {
      const entry = this.entries.get(id);
      // 身份校验：定时器只清理自己登记的那次存入，防止极端时序下误删同 id 的后续条目。
      if (!entry || entry.connection !== connection) {
        return;
      }
      this.entries.delete(id);
      entry.connection.dispose();
    }, this.claimTimeoutMs);
    // 不持有事件循环：server 进程（含测试进程）不应被未认领连接的清理定时器挂住。
    claimTimer.unref();
    this.entries.set(id, { connection, claimTimer });
    return true;
  }

  /** 首次认领：取出并移除条目、清除超时定时器；此后连接由 WS 生命周期负责。 */
  claim(id: string): RemoteConnection | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.claimTimer);
    this.entries.delete(id);
    return entry.connection;
  }
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new RemoteConnectionStore();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  // 安全修复（Windows 跨盘符/跨卷穿越）：relative() 在 candidate 与 root 不同卷时
  // 返回候选路径本身（不以 ".." 开头），旧判定会把盘外路径误判为 inside。覆盖形态：
  // 盘符绝对 "C:\x"、drive-relative "C:x"（isAbsolute 为 false 但 resolve 仍落到 C: 盘）、
  // UNC "\\srv\share\x"、跨盘 drive-relative 落到进程 cwd（如 root 在 C: 时的 "d:pkg"）。
  // 因此先做卷根一致性校验：parse().root 不一致（Windows 大小写不敏感）直接判外。
  // POSIX 上两侧恒为 "/"，行为不变。同盘 drive-relative（如 "d:x"）resolve 以左侧
  // 绝对参数（即 root）为基目录、结果仍在 root 内；根相对 "\x" 落到本盘其他目录，
  // 由下方 relative() 的 ".." 判定拦截。
  if (parse(root).root.toLowerCase() !== parse(candidate).root.toLowerCase()) {
    return false;
  }
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

// 导出供安全回归测试直接验证路径解析语义（无需启动 HTTP 服务）。
export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  // 边界统一由 isInsideDirectory 的"卷根一致性 + relative()"两道检查负责（含
  // 盘符绝对、drive-relative、根相对、UNC 各形态），不再设 isAbsolute 前置门控，
  // 保持单一可审计的边界机制。
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function resolveHttpBindHost(
  host: string | undefined,
  authToken: string | undefined,
): string {
  const bindHost = host?.trim() || "127.0.0.1";
  const isLoopback =
    bindHost === "localhost" ||
    bindHost === "::1" ||
    bindHost === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(bindHost);
  // 无凭据时禁止把完整 RPC 服务暴露到其他网络接口。
  if (!isLoopback && !authToken?.trim()) {
    throw new Error("Non-loopback HTTP binding requires an authentication token");
  }
  return bindHost;
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3033,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  const bindHost = resolveHttpBindHost(options.host, authToken);
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      if (!remoteConnections.tryStore(id, connection)) {
        // F13：未认领连接池已达上限，拒绝新连接并立即释放刚建立的连接，
        // 防止高频创建在认领超时窗口内绕过清理、堆积远端进程。
        connection.dispose();
        return c.json({ error: "Too many pending remote connections" }, 503);
      }

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，首次认领取出即移除，
          // 并同步清除该条目的认领超时定时器（F13 修复）。
          const connection = remoteConnections.claim(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }

          // 认领成功后所有权移交该 WS：挂 services，并把连接收口挂入 WS 关闭链（F31 修复）。
          attachClaimedRemoteConnection(ws.raw as WebSocket, connection);
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: bindHost, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = bindHost;
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
