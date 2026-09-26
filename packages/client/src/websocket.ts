import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

export function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const maxBufferedBytes = 16 * 1024 * 1024;
  const drainedBytes = 1024 * 1024;
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        // Bug 根因：慢网络下 send 不等待，浏览器队列可无限增长。
        // 超界关闭连接后由现有 Web 恢复链路重订阅同一水位。
        if (ws.bufferedAmount + buffer.byteLength > maxBufferedBytes) {
          ws.close(1013, "transport buffer saturated");
          return;
        }
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (ws.readyState !== WebSocket.OPEN)
            return reject(new Error("WebSocket closed before drain"));
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

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      const client = new ChannelClient(new SocketProtocol(socket));
      // SocketProtocol 只暴露消息；浏览器 socket 关闭时主动终结 Channel，
      // 否则已发出的 RPC Promise 会无限等待响应。
      socket.onClose(() => client.dispose());
      resolve(new RemoteServiceAccess(client));
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}
