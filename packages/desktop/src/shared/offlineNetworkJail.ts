import nodeHttp from "node:http";
import nodeHttps from "node:https";
import nodeNet from "node:net";
import nodeTls from "node:tls";

/**
 * 离线网络 jail（docs/requirements/offline-network-isolation.md）：
 * 除豁免的 OMP app-server 子进程外，main / host 进程禁止一切非回环出站。
 *
 * 实现依据：undici、ws、ssh2 等出网库都构建在 node:net / node:tls 之上，
 * node:http(s) 也经由同一底座建连；patch 这组底层 API 即可统一拦截，
 * 并把「离线环境挂超时」变成毫秒级快速失败。default import 拿到的是
 * 内建模块的 module.exports 对象（可变），对它的属性赋值对全部消费方生效。
 *
 * 边界：Electron 的 net 模块走 Chromium 网络栈、不经过 Node 通道；其使用点
 * （遥测、client/configs 灰度、帮助配置）已在装配层停用，需求上禁止新增。
 */

type JailLogger = (message: string, meta?: Record<string, unknown>) => void;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "::ffff:127.0.0.1"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return LOOPBACK_HOSTNAMES.has(normalized) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function urlHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function blockedError(api: string, target: string): Error {
  return new Error(`[offline-network-jail] ${api} blocked non-loopback outbound: ${target}`);
}

/** 出站目标判定：仅带 path 的连接是本机命名管道 / Unix socket（CUA broker 等）与缺省 host（node 默认 localhost）都放行。 */
function outboundTargetOf(options: unknown): string | null {
  if (typeof options !== "object" || options === null) return null;
  const candidate = options as { host?: unknown; hostname?: unknown };
  const host = candidate.hostname ?? candidate.host;
  if (host === undefined || host === null || host === "") return null;
  return typeof host === "string" ? host : String(host);
}

interface PatchableHttpModule {
  request: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
}

interface PatchableNetModule {
  connect: (...args: unknown[]) => unknown;
  createConnection: (...args: unknown[]) => unknown;
}

let installed = false;

export function installOfflineNetworkJail(options?: { label?: string; logger?: JailLogger }): void {
  if (installed) return;
  installed = true;
  const label = options?.label ?? "node";
  const logger = options?.logger;
  const reportBlocked = (api: string, target: string): void => {
    logger?.(`[offline-network-jail] ${label} 拒绝非回环出站`, { api, target });
  };

  // 1) globalThis.fetch：覆盖直接使用 fetch / undici fetch 的散点（营销、分享 artifact 等）。
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const hostname = urlHostname(url);
      if (hostname && !isLoopbackHostname(hostname)) {
        reportBlocked("fetch", hostname);
        return Promise.reject(blockedError("fetch", hostname));
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  // 2) node:http / node:https 的 request / get（feedbackHttpClient 的 node:http 直用等）。
  const patchHttpModule = (moduleName: string, module_: unknown): void => {
    const target = module_ as PatchableHttpModule;
    for (const api of ["request", "get"] as const) {
      const original = target[api];
      target[api] = (...args: unknown[]) => {
        const urlArg = args.find((arg) => typeof arg === "string" || arg instanceof URL);
        const outbound = urlArg !== undefined
          ? urlHostname(typeof urlArg === "string" ? urlArg : urlArg.href)
          : outboundTargetOf(args[0]);
        if (outbound && !isLoopbackHostname(outbound)) {
          reportBlocked(`${moduleName}.${api}`, outbound);
          throw blockedError(`${moduleName}.${api}`, outbound);
        }
        return original(...args);
      };
    }
  };
  patchHttpModule("http", nodeHttp);
  patchHttpModule("https", nodeHttps);

  // 3) node:net / node:tls 的 connect / createConnection：undici、ws、ssh2 的统一底座。
  const patchNetModule = (moduleName: string, module_: unknown): void => {
    const target = module_ as PatchableNetModule;
    for (const api of ["connect", "createConnection"] as const) {
      const original = target[api];
      if (typeof original !== "function") continue;
      target[api] = (...args: unknown[]) => {
        const first = args[0];
        let outbound: string | null = null;
        if (typeof first === "object" && first !== null) {
          outbound = outboundTargetOf(first);
        } else if (typeof first === "number" && typeof args[1] === "string") {
          outbound = args[1];
        }
        if (outbound && !isLoopbackHostname(outbound)) {
          reportBlocked(`${moduleName}.${api}`, outbound);
          throw blockedError(`${moduleName}.${api}`, outbound);
        }
        return original(...args);
      };
    }
  };
  patchNetModule("net", nodeNet);
  patchNetModule("tls", nodeTls);
}
