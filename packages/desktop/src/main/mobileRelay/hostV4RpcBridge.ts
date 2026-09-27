import { Emitter, VSBuffer } from "@zcode/rpc";

/**
 * 手机远控 v4 RPC 帧桥（host 侧）。
 *
 * 与手机端 ompMobile `packages/web/src/remote-v4/frame.ts` 的 V4RpcBridge 对称：
 * 两端各自持有 messageSeq/ACK 与出站未确认队列，relay 只转发 JSON 帧、不参与
 * 序号语义。本类把窗口 Host 的 MessagePort 二进制 RPC（VSBuffer）与手机的
 * rpc-frame / rpc-frame-ack JSON 载荷互转，含分片（256 KiB/片、≤64 片）、
 * CRC32 校验、入站序号连续性 fail-closed 与重连重放。
 */

export interface HostV4BridgeInfo {
  bridgeSessionId: string;
  bridgeGeneration: number;
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

interface RpcFrame {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration: number;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  dataBase64: string;
}

interface PendingMessage {
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  fragments: Array<Uint8Array | undefined>;
  received: number;
}

/** 入站分片组装窗口：首片到达后未集齐即判永久空洞，fail-closed 断开。 */
const INBOUND_FRAGMENT_TIMEOUT_MS = 30_000;
/** 出站未确认上限：手机端停止 ACK（半开连接）时防止无界内存与重发风暴。 */
const MAX_PENDING_OUTBOUND_MESSAGES = 512;
const MAX_PENDING_OUTBOUND_BYTES = 32 * 1024 * 1024;
const CHUNK_SIZE = 256 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});
const crcTable1 = Uint32Array.from(
  { length: 256 },
  (_, index) => ((crcTable[index]! >>> 8) ^ crcTable[crcTable[index]! & 0xff]!) >>> 0,
);
const crcTable2 = Uint32Array.from(
  { length: 256 },
  (_, index) => ((crcTable1[index]! >>> 8) ^ crcTable[crcTable1[index]! & 0xff]!) >>> 0,
);
const crcTable3 = Uint32Array.from(
  { length: 256 },
  (_, index) => ((crcTable2[index]! >>> 8) ^ crcTable[crcTable2[index]! & 0xff]!) >>> 0,
);

function crc32(bytes: Uint8Array): string {
  let value = 0xffffffff;
  let index = 0;
  for (; index + 4 <= bytes.length; index += 4) {
    value ^=
      bytes[index]! |
      (bytes[index + 1]! << 8) |
      (bytes[index + 2]! << 16) |
      (bytes[index + 3]! << 24);
    value =
      crcTable3[value & 0xff]! ^
      crcTable2[(value >>> 8) & 0xff]! ^
      crcTable1[(value >>> 16) & 0xff]! ^
      crcTable[(value >>> 24) & 0xff]!;
  }
  for (; index < bytes.length; index += 1) {
    value = crcTable[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  }
  return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export class HostV4RpcBridge {
  private readonly messages = new Emitter<VSBuffer>();
  private readonly fatalErrors = new Emitter<Error>();
  private readonly pending = new Map<number, PendingMessage>();
  private readonly pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private physicalSeq = 1;
  private messageSeq = 1;
  private lastInboundMessageSeq = 0;
  private lastAckedMessageSeq = 0;
  private readonly outbound = new Map<number, RpcFrame[]>();
  private outboundBytes = 0;
  private fatalError: Error | null = null;

  /** 不可恢复协议状态（序号空洞/组装超时/积压超限）时触发，relay 断开该连接。 */
  readonly onFatalError = this.fatalErrors.event;

  /** 手机 → Host 的完整 RPC 消息（已组装、已校验），relay 转发到 MessagePort。 */
  readonly onMessage = this.messages.event;

  /** 与手机端 V4RpcBridge.protocol 对称的 RPC 协议适配（connectViaProtocol 消费）。 */
  readonly protocol = {
    onMessage: this.messages.event,
    send: (buffer: import("@zcode/rpc").VSBuffer) => this.send(buffer.buffer),
    drain: () => Promise.resolve(),
  };

  constructor(
    private readonly bridge: HostV4BridgeInfo,
    private readonly sendPayload: (payload: object) => void,
  ) {}

  private fatal(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.fatalErrors.fire(error);
  }

  accept(payload: Record<string, unknown>): boolean {
    if (this.fatalError) throw this.fatalError;
    if (payload.bridgeSessionId !== this.bridge.bridgeSessionId) return false;
    if (payload.bridgeGeneration !== this.bridge.bridgeGeneration) return false;
    if (payload.zcode_type === "rpc-frame-ack") {
      const ack = payload.ackMessageSeq;
      if (typeof ack === "number" && ack >= this.lastAckedMessageSeq && ack < this.messageSeq) {
        this.lastAckedMessageSeq = ack;
        for (const seq of this.outbound.keys()) {
          if (seq <= ack) {
            this.outboundBytes -= this.outbound.get(seq)?.[0]?.messageBytes ?? 0;
            this.outbound.delete(seq);
          }
        }
      }
      return true;
    }
    if (payload.zcode_type !== "rpc-frame") return false;
    const frame = payload as unknown as RpcFrame;
    if (
      !Number.isSafeInteger(frame.messageSeq) ||
      !Number.isSafeInteger(frame.fragmentIndex) ||
      !Number.isSafeInteger(frame.fragmentCount) ||
      !Number.isSafeInteger(frame.messageBytes) ||
      frame.fragmentCount < 1 ||
      frame.fragmentCount > 64 ||
      frame.messageBytes < 1 ||
      frame.messageBytes > MAX_MESSAGE_BYTES ||
      frame.fragmentIndex < 0 ||
      frame.fragmentIndex >= frame.fragmentCount ||
      frame.checksum?.algorithm !== "crc32" ||
      typeof frame.dataBase64 !== "string"
    ) {
      throw new Error("Invalid mobile RPC frame");
    }
    if (frame.messageSeq <= this.lastInboundMessageSeq) {
      // 已投递消息的重放/重复帧：重新确认即可，不构成错误。
      this.ack(this.lastInboundMessageSeq);
      return true;
    }
    let message = this.pending.get(frame.messageSeq);
    if (!message) {
      message = {
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum.value,
        fragments: Array.from({ length: frame.fragmentCount }),
        received: 0,
      };
      this.pending.set(frame.messageSeq, message);
      this.armFragmentTimer(frame.messageSeq, message);
    }
    if (
      message.fragmentCount !== frame.fragmentCount ||
      message.messageBytes !== frame.messageBytes ||
      message.checksum !== frame.checksum.value
    ) {
      throw new Error("Conflicting mobile RPC fragments");
    }
    const bytes = decodeBase64(frame.dataBase64);
    if (!message.fragments[frame.fragmentIndex]) {
      message.fragments[frame.fragmentIndex] = bytes;
      message.received += 1;
    }
    if (message.received !== message.fragmentCount) return true;
    const joined = new Uint8Array(message.messageBytes);
    let offset = 0;
    for (const part of message.fragments) {
      if (!part || offset + part.length > joined.length) throw new Error("Invalid mobile RPC length");
      joined.set(part, offset);
      offset += part.length;
    }
    if (offset !== joined.length || crc32(joined) !== message.checksum) {
      throw new Error("Invalid mobile RPC checksum");
    }
    this.pending.delete(frame.messageSeq);
    this.clearFragmentTimer(frame.messageSeq);
    // 与手机端同构：完成投递必须序号连续，中间有洞即 fail-closed，避免上层缺块。
    if (frame.messageSeq > this.lastInboundMessageSeq + 1) {
      this.fatal(
        new Error(
          `mobile RPC inbound sequence gap: expected messageSeq ${this.lastInboundMessageSeq + 1}, delivered ${frame.messageSeq}`,
        ),
      );
      return true;
    }
    this.lastInboundMessageSeq = frame.messageSeq;
    this.messages.fire(VSBuffer.wrap(joined));
    this.ack(frame.messageSeq);
    return true;
  }

  private armFragmentTimer(messageSeq: number, message: PendingMessage): void {
    const handle = setTimeout(() => {
      this.pendingTimers.delete(messageSeq);
      if (!this.pending.has(messageSeq)) return;
      this.fatal(
        new Error(
          `mobile RPC fragment assembly timed out after ${INBOUND_FRAGMENT_TIMEOUT_MS}ms: messageSeq ${messageSeq} (${message.received}/${message.fragmentCount} fragments)`,
        ),
      );
    }, INBOUND_FRAGMENT_TIMEOUT_MS);
    handle.unref?.();
    this.pendingTimers.set(messageSeq, handle);
  }

  private clearFragmentTimer(messageSeq: number): void {
    const handle = this.pendingTimers.get(messageSeq);
    if (handle === undefined) return;
    clearTimeout(handle);
    this.pendingTimers.delete(messageSeq);
  }

  private ack(messageSeq: number): void {
    this.sendPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: this.bridge.bridgeSessionId,
      bridgeGeneration: this.bridge.bridgeGeneration,
      ackMessageSeq: messageSeq,
    });
  }

  /** Host → 手机：RPC 字节分片、记录出站未确认并发送。 */
  send(bytes: Uint8Array): void {
    if (this.fatalError) throw this.fatalError;
    if (bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) throw new Error("Invalid RPC size");
    const fragmentCount = Math.ceil(bytes.length / CHUNK_SIZE);
    if (fragmentCount > 64) throw new Error("RPC fragment limit exceeded");
    const checksum = { algorithm: "crc32" as const, value: crc32(bytes) };
    const messageSeq = this.messageSeq++;
    const frames: RpcFrame[] = [];
    for (let index = 0; index < fragmentCount; index += 1) {
      frames.push({
        zcode_type: "rpc-frame",
        bridgeSessionId: this.bridge.bridgeSessionId,
        bridgeGeneration: this.bridge.bridgeGeneration,
        seq: this.physicalSeq++,
        messageSeq,
        fragmentIndex: index,
        fragmentCount,
        messageBytes: bytes.length,
        checksum,
        dataBase64: encodeBase64(bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)),
      });
    }
    this.outbound.set(messageSeq, frames);
    this.outboundBytes += bytes.length;
    if (
      this.outbound.size > MAX_PENDING_OUTBOUND_MESSAGES ||
      this.outboundBytes > MAX_PENDING_OUTBOUND_BYTES
    ) {
      const error = new Error(
        `mobile RPC outbound backlog limit exceeded: ${this.outbound.size} messages / ${this.outboundBytes} bytes unacknowledged`,
      );
      this.fatal(error);
      throw error;
    }
    for (const frame of frames) this.sendPayload(frame);
  }

  /** 手机重连（pair_status_ack）后重放未确认帧。 */
  replayUnacknowledged(): void {
    for (const frames of this.outbound.values()) {
      for (const frame of frames) this.sendPayload(frame);
    }
  }

  dispose(): void {
    this.messages.dispose();
    this.fatalErrors.dispose();
    for (const handle of this.pendingTimers.values()) clearTimeout(handle);
    this.pendingTimers.clear();
    this.pending.clear();
    this.outbound.clear();
    this.outboundBytes = 0;
  }
}
