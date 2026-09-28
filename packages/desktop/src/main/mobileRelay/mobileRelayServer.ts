import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:https";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { WebSocket, WebSocketServer } from "ws";
import { MessagePortProtocol } from "@zcode/rpc";
import {
  HostMessageTypes,
  type MobileRelayEntryStatus,
  type WindowBridgeableWorkspace,
} from "@zcode/shared";
import { logger } from "../logger.js";
import {
  MOBILE_RELAY_LISTEN_HOST,
  MOBILE_RELAY_LISTEN_PORT,
  MOBILE_RELAY_WS_PATH,
  buildMobileRelayEntryUrl,
} from "./mobileRelayProtocol.js";
import type { MobileRelayCertificate } from "./mobileRelayCertificate.js";
import { HostV4RpcBridge, type HostV4BridgeInfo } from "./hostV4RpcBridge.js";
import { wrapElectronPort } from "./wrapElectronPort.js";

/**
 * 手机远控内嵌中继（无鉴权开放接入）。
 *
 * 协议帧形状对齐 ompMobile 手机端 connection.ts：auth_init 直接回 auth_ack
 * （matched），不做 challenge/凭据校验——进程存活即接受连接，信任边界是
 * frp 隧道与 TLS 层（需求见 docs/requirements/mobile-relay.md）。
 *
 * 单帧语义：bootstrap-request 查询焦点窗口工作区；workspace-bridge-open 把
 * 该连接以 web-remote-replayable clientMode attach 到焦点窗口 Host 并建立
 * RPC 帧桥；rpc-frame/rpc-frame-ack 透传给 HostV4RpcBridge。
 */

interface RelayMessage {
  type?: string;
  role?: string;
  payload?: Record<string, unknown>;
}

interface BridgeAttachment {
  attachmentId: string;
  bridge: HostV4BridgeInfo;
  rpc: HostV4RpcBridge;
  portProtocol: MessagePortProtocol;
  host: ElectronUtilityProcess;
}

interface RelaySession {
  socket: WebSocket;
  /** 焦点窗口 Host 在 bootstrap/bridge 时解析并固定到该连接，避免换窗错位。 */
  host: ElectronUtilityProcess | undefined;
  workspaces: WindowBridgeableWorkspace[];
  attachment: BridgeAttachment | undefined;
}

export interface MobileRelayServerOptions {
  certificate: MobileRelayCertificate;
  /** 解析当前焦点窗口的 Host 进程；无窗口/未就绪返回 undefined。 */
  resolveFocusHost: () => ElectronUtilityProcess | undefined;
  /** 向 Host 查询可桥接工作区（Main 侧负责消息关联与超时）。 */
  requestBridgeableWorkspaces: (
    host: ElectronUtilityProcess,
  ) => Promise<WindowBridgeableWorkspace[]>;
  onConnectionsChanged?: (connections: number) => void;
  /** 仅测试注入；真实桌面固定用 MOBILE_RELAY_LISTEN_PORT，E2E 用临时端口。 */
  listenPort?: number;
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
/** 空闲保活：frp TCP 隧道与 NAT 对长空闲连接不友好，RPC 层心跳之外保持链路活性。 */
const KEEPALIVE_PING_INTERVAL_MS = 30_000;

export class MobileRelayServer {
  private readonly sessions = new Set<RelaySession>();
  private httpServer: HttpServer | undefined;
  private wss: WebSocketServer | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private runningError: string | undefined;

  constructor(private readonly options: MobileRelayServerOptions) {}

  getStatus(): MobileRelayEntryStatus {
    return {
      url: buildMobileRelayEntryUrl(),
      connections: this.sessions.size,
      listenPort: MOBILE_RELAY_LISTEN_PORT,
      running: this.running,
      ...(this.runningError ? { error: this.runningError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    const { certPem, keyPem } = this.options.certificate;
    const httpServer = createServer(
      {
        cert: certPem,
        key: keyPem,
        // TLS 终止在本 relay；公网侧 frp 是 TCP 透传，SNI/ALPN 无需特殊处理。
      },
      (_req, res) => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("mobile relay: only /ws is served");
      },
    );
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (request, socket, head) => {
      const { pathname } = new URL(
        request.url ?? "/",
        `https://${request.headers.host ?? "local"}`,
      );
      if (pathname !== MOBILE_RELAY_WS_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as never, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
    wss.on("connection", (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      const listenPort = this.options.listenPort ?? MOBILE_RELAY_LISTEN_PORT;
      httpServer.listen(listenPort, MOBILE_RELAY_LISTEN_HOST, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });

    this.httpServer = httpServer;
    this.wss = wss;
    this.running = true;
    this.runningError = undefined;
    this.keepaliveTimer = setInterval(() => {
      for (const session of this.sessions) {
        if (session.socket.readyState === WebSocket.OPEN) session.socket.ping();
      }
    }, KEEPALIVE_PING_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
    logger.info(
      `mobile relay listening on wss://${MOBILE_RELAY_LISTEN_HOST}:${MOBILE_RELAY_LISTEN_PORT}${MOBILE_RELAY_WS_PATH}`,
    );
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    const snapshot = [...this.sessions];
    for (const session of snapshot) {
      this.closeSession(session, 1001, "server shutdown");
    }
    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = undefined;
    this.httpServer = undefined;
    this.running = false;
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
      httpServer?.close(() => resolve());
      resolve();
    });
    logger.info("mobile relay stopped");
  }

  private handleConnection(socket: WebSocket): void {
    const session: RelaySession = {
      socket,
      host: undefined,
      workspaces: [],
      attachment: undefined,
    };
    this.sessions.add(session);
    this.options.onConnectionsChanged?.(this.sessions.size);

    const handshakeTimer = setTimeout(() => {
      // 与手机端 30s 配对超时对齐：未完成握手的连接直接回收。
      if (session.attachment === undefined) this.closeSession(session, 1000, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    socket.on("message", (raw) => {
      let message: RelayMessage;
      try {
        message = JSON.parse(String(raw)) as RelayMessage;
      } catch {
        this.closeSession(session, 1002, "invalid json");
        return;
      }
      if (message.type === "auth_init") {
        clearTimeout(handshakeTimer);
        if (message.role !== "terminal") {
          this.closeSession(session, 1002, "unsupported role");
          return;
        }
        // 无鉴权开放接入：不校验 sid/hash，直接放行。重连（重复 auth_init）
        // 回 pair_status_ack，与手机端重放语义对齐并触发未确认帧重放。
        const bridged = session.attachment !== undefined;
        socket.send(
          JSON.stringify(
            bridged
              ? { type: "pair_status_ack", pair_status: "matched", client_ts: Date.now() }
              : { type: "auth_ack", pair_status: "matched", client_ts: Date.now() },
          ),
        );
        if (bridged) session.attachment?.rpc.replayUnacknowledged();
        return;
      }
      if (message.type === "error" || message.type === "auth_response") {
        // 手机端理论上不发这两类帧；记录用于排查协议错位。
        logger.warn("[mobile-relay] unexpected inbound frame type=" + String(message.type));
        return;
      }
      if (
        message.type !== "data" ||
        typeof message.payload !== "object" ||
        message.payload === null
      ) {
        logger.debug("[mobile-relay] inbound frame type=" + String(message.type));
        return;
      }
      void this.handleDataPayload(session, message.payload).catch((error: unknown) => {
        logger.warn("mobile relay payload handling failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.disposeSession(session);
    });
    socket.on("error", () => {
      clearTimeout(handshakeTimer);
      this.disposeSession(session);
      socket.close();
    });
  }

  private sendPayload(session: RelaySession, payload: object): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    logger.debug(
      "[mobile-relay] out payload zcode_type=",
      (payload as { zcode_type?: string }).zcode_type,
    );
    session.socket.send(JSON.stringify({ type: "data", payload, client_ts: Date.now() }));
  }

  private sendError(session: RelaySession, code: string): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;
    // 帧级诊断：error 帧如实记录 code，便于定位手机端错误文案来源。
    logger.info("[mobile-relay] out error frame code=" + code);
    session.socket.send(JSON.stringify({ type: "error", code, client_ts: Date.now() }));
  }

  private async handleDataPayload(
    session: RelaySession,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const zcodeType = payload.zcode_type;

    if (zcodeType === "bootstrap-request") {
      const host = this.options.resolveFocusHost();
      if (!host) {
        this.sendError(session, "bridge_unavailable");
        return;
      }
      try {
        const workspaces = await this.options.requestBridgeableWorkspaces(host);
        if (workspaces.length === 0) {
          this.sendError(session, "bridge_unavailable");
          return;
        }
        // 连接内固定 Host 与工作区快照；手机点选其他项目时按 workspaceKey 精确匹配。
        session.host = host;
        session.workspaces = workspaces;
        this.sendPayload(session, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          result: { workspaces },
        });
      } catch (error) {
        logger.warn("mobile relay bootstrap query failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendError(session, "bridge_unavailable");
      }
      return;
    }

    if (zcodeType === "workspace-bridge-open") {
      if (!session.host) {
        this.sendError(session, "bridge_unavailable");
        return;
      }
      const bridgeSessionId =
        typeof payload.bridgeSessionId === "string" ? payload.bridgeSessionId : "";
      const generation = payload.bridgeGeneration;
      if (!bridgeSessionId || generation !== 1 || typeof payload.workspaceKey !== "string") {
        this.closeSession(session, 1002, "invalid bridge open");
        return;
      }
      const workspaceKey = payload.workspaceKey;
      const workspace = session.workspaces.find(
        (item) => (item.workspaceIdentity?.trim() || item.workspacePath) === workspaceKey,
      );
      if (!workspace) {
        this.sendError(session, "bridge_unavailable");
        return;
      }
      const host = session.host;
      // 同一手机连接重开 bridge（切换项目/断线恢复）时先释放旧 attachment。
      this.releaseAttachment(session);
      // electron 只在 main 进程提供 MessageChannelMain；延迟解析让纯 Node
      // 测试也能装载本模块做握手/门控回归（main 进程内行为不变）。
      const { MessageChannelMain } = await import("electron");
      const { port1, port2 } = new MessageChannelMain();
      const attachmentId = randomUUID();
      const bridgeInfo: HostV4BridgeInfo = {
        bridgeSessionId,
        bridgeGeneration: 1,
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        ...(typeof payload.taskId === "string" && payload.taskId
          ? { initialTaskId: payload.taskId }
          : {}),
      };
      const rpc = new HostV4RpcBridge(bridgeInfo, (frame) => this.sendPayload(session, frame));
      rpc.onFatalError(() => {
        // 帧层不可恢复（序号空洞/组装超时/积压超限）：断开让手机端重连恢复。
        this.closeSession(session, 1011, "rpc bridge fatal");
      });
      const portProtocol = new MessagePortProtocol(wrapElectronPort(port1));
      // Host → 手机：MessagePort 二进制 RPC 分片成 rpc-frame。
      portProtocol.onMessage((buffer) => {
        try {
          rpc.send(buffer.buffer);
        } catch {
          this.closeSession(session, 1011, "rpc send failed");
        }
      });
      // 手机 → Host：组装完成的 RPC 消息写回 MessagePort。
      rpc.onMessage((buffer) => portProtocol.send(buffer));

      try {
        host.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "web-remote-replayable",
            scope: { kind: "local" },
          },
          [port2],
        );
      } catch (error) {
        rpc.dispose();
        portProtocol.disconnect();
        port1.close();
        port2.close();
        logger.warn("mobile relay attach service port failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.sendError(session, "bridge_unavailable");
        return;
      }
      session.attachment = { attachmentId, bridge: bridgeInfo, rpc, portProtocol, host };
      port1.on("close", () => {
        // Host 侧 attachment 关闭（窗口关闭/Host 退出）：通知手机可重试。
        if (session.attachment?.attachmentId === attachmentId) {
          session.attachment = undefined;
          this.sendError(session, "bridge_unavailable");
        }
      });
      this.sendPayload(session, {
        zcode_type: "workspace-bridge-ready",
        requestId: payload.requestId,
        bridge: {
          bridgeSessionId,
          bridgeGeneration: 1,
          workspaceKey,
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
          ...(bridgeInfo.initialTaskId ? { initialTaskId: bridgeInfo.initialTaskId } : {}),
        },
      });
      logger.info("mobile relay bridge opened", {
        attachmentId,
        workspacePath: workspace.workspacePath,
      });
      return;
    }

    // rpc-frame / rpc-frame-ack / 未知 zcode_type：交给桥；桥按 bridgeSessionId 过滤。
    if (session.attachment) {
      try {
        session.attachment.rpc.accept(payload);
      } catch (error) {
        logger.warn("mobile rpc frame rejected", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.closeSession(session, 1002, "invalid rpc frame");
      }
    }
  }

  private releaseAttachment(session: RelaySession): void {
    const attachment = session.attachment;
    if (!attachment) return;
    session.attachment = undefined;
    // 手机 → Host 方向先关协议与端口（在途 RPC fail-closed），再通知 Host detach。
    attachment.rpc.dispose();
    attachment.portProtocol.disconnect();
    try {
      attachment.host.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: attachment.attachmentId,
      });
    } catch {
      // Host 进程可能已退出；端口关闭足以触发 Host 侧回收。
    }
  }

  private disposeSession(session: RelaySession): void {
    this.releaseAttachment(session);
    if (this.sessions.delete(session)) {
      this.options.onConnectionsChanged?.(this.sessions.size);
    }
  }

  private closeSession(session: RelaySession, code: number, reason: string): void {
    this.disposeSession(session);
    if (
      session.socket.readyState === WebSocket.OPEN ||
      session.socket.readyState === WebSocket.CONNECTING
    ) {
      session.socket.close(code, reason);
    }
  }
}
