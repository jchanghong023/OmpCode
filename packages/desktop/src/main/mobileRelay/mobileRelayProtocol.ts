import { randomUUID } from "node:crypto";

/**
 * 手机远控内嵌中继的固定网络契约。
 *
 * 按用户要求不做运行时配置：公网入口、本机监听端口全部固定常量，
 * 两个仓库（本仓库与 ompMobile）各自写死同一组值，需求见
 * docs/requirements/mobile-relay.md。
 */

/** 公网入口 origin：frps 对外 443（TCP 透传，不做 TLS 终结）。 */
export const MOBILE_RELAY_PUBLIC_ORIGIN = "https://8.137.101.112";

/** 本机监听地址：只绑回环，公网可达性由外部 frp 隧道承担。 */
export const MOBILE_RELAY_LISTEN_HOST = "127.0.0.1";

/** 本机监听端口：frpc 的 localPort 必须与此一致。 */
export const MOBILE_RELAY_LISTEN_PORT = 8765;

/** 手机端 WebSocket 端点路径（手机端 connection.ts 同源 /ws）。 */
export const MOBILE_RELAY_WS_PATH = "/ws";

/**
 * 手机入口链接：路径与参数形状必须满足 ompMobile 深链校验
 * （https + 同源 host + /remote/v4 + sid/hash/t）。
 * 无鉴权开放接入模型下 sid/hash 仅为格式占位、无时效语义。
 */
export function buildMobileRelayEntryUrl(): string {
  const params = new URLSearchParams({
    sid: randomUUID(),
    // 手机端只校验非空；hash 用随机 hex 占位，避免被当成真实凭据理解。
    hash: randomUUID().replaceAll("-", ""),
    t: String(Date.now()),
  });
  return `${MOBILE_RELAY_PUBLIC_ORIGIN}/remote/v4?${params.toString()}`;
}
