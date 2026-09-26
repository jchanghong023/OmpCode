// conversation topic 发布器：订阅管理、flush 窗口与 wire 帧编码。
// 从 conversationEngine 拆出（架构 maxFileLines=400）；只依赖投影读面与 gateway。

import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type ConversationDelta,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { createId, createSubscriptionId } from "../domain/ids.js";
import type { ConversationProjection } from "../domain/conversationProjection.js";
import { ProtocolError } from "./errors.js";
import type { HostGateway } from "./ports.js";

const FLUSH_WINDOW_MS = 30;

interface Subscriber {
  subscriptionId: string;
  sessionId: string;
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  lastDeliveredSeq: number;
  logicalFrameOrdinal: number;
}

export interface SubscribeOptions {
  sessionId?: string;
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  base?: { logEpoch: string; seq: number } | null;
}

export class ConversationTopicPublisher {
  private subscribers = new Map<string, Subscriber>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly projection: ConversationProjection,
    private readonly gateway: HostGateway,
  ) {}

  subscribe(params: SubscribeOptions): {
    subscriptionId: string;
    mode: "snapshot" | "resume";
    logEpoch: string;
  } {
    this.flushNow();
    const subscriptionId = createSubscriptionId();
    const resumeDeltas =
      params.base && params.base.logEpoch === this.projection.logEpoch
        ? this.projection.deltasBetween(params.base.seq, this.projection.seq)
        : null;
    const subscriber: Subscriber = {
      subscriptionId,
      sessionId: params.sessionId ?? this.sessionId,
      connectionId: params.connectionId,
      clientMode: params.clientMode,
      lastDeliveredSeq: this.projection.seq,
      logicalFrameOrdinal: 0,
    };
    this.subscribers.set(subscriptionId, subscriber);
    if (resumeDeltas && params.base) {
      this.emitFrames(
        subscriptionId,
        params.base.seq,
        { kind: "deltas", deltas: resumeDeltas },
        "recovery",
      );
      subscriber.lastDeliveredSeq = this.projection.seq;
    } else {
      this.emitFrames(
        subscriptionId,
        0,
        { kind: "snapshot", snapshot: this.projection.buildSnapshot() },
        "initial",
      );
    }
    return {
      subscriptionId,
      mode: resumeDeltas ? "resume" : "snapshot",
      logEpoch: this.projection.logEpoch,
    };
  }

  resync(
    subscriptionId: string,
    base: { logEpoch: string; seq: number } | null,
    forceSnapshot = false,
  ): { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string } {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber) {
      // 上游契约：未知 subscription 必须回 notOwned——renderer 对它特判为
      // 「换 fresh subscribe 自愈」；其他错误会让会话永久 fail-closed（GUI 实测踩坑）。
      throw new ProtocolError(-32004, "fault.subscription.notOwned");
    }
    this.flushNow();
    const resumeDeltas =
      !forceSnapshot && base !== null && base.logEpoch === this.projection.logEpoch
        ? this.projection.deltasBetween(base.seq, this.projection.seq)
        : null;
    if (resumeDeltas && base && resumeDeltas.length > 0) {
      this.emitFrames(
        subscriptionId,
        base.seq,
        { kind: "deltas", deltas: resumeDeltas },
        "recovery",
      );
      subscriber.lastDeliveredSeq = this.projection.seq;
      return { subscriptionId, mode: "resume", logEpoch: this.projection.logEpoch };
    }
    // forceSnapshot 或无增量可续：必须回 snapshot + mode=snapshot。
    // renderer 以「ack=resume 且无帧到达」判 recovery 超时（GUI 链路实测踩坑）。
    this.emitFrames(
      subscriptionId,
      0,
      { kind: "snapshot", snapshot: this.projection.buildSnapshot() },
      "recovery",
    );
    subscriber.lastDeliveredSeq = this.projection.seq;
    return { subscriptionId, mode: "snapshot", logEpoch: this.projection.logEpoch };
  }

  unsubscribe(subscriptionId: string): void {
    this.subscribers.delete(subscriptionId);
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushCallbacks = [];
    this.subscribers.clear();
  }

  // flush 窗口内注册的回调全部保留，flush 后依次执行。此前「定时器已挂起就丢弃回调」
  // 会把轮次终态的 sessions-index 通知一起丢掉（GUI 实测缺陷：侧栏会话转圈不止）。
  private flushCallbacks: (() => void)[] = [];

  scheduleFlush(onFlushed: () => void): void {
    this.flushCallbacks.push(onFlushed);
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
      const callbacks = this.flushCallbacks;
      this.flushCallbacks = [];
      for (const callback of callbacks) {
        callback();
      }
    }, FLUSH_WINDOW_MS);
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    this.projection.drainPendingDeltas();
    for (const subscriber of this.subscribers.values()) {
      const deltas = this.projection.deltasBetween(
        subscriber.lastDeliveredSeq,
        this.projection.seq,
      );
      if (deltas === null) {
        // 水位早于 log 覆盖范围：整快照重同步，避免订阅者永久等待缺口。
        this.emitFrames(
          subscriber.subscriptionId,
          0,
          { kind: "snapshot", snapshot: this.projection.buildSnapshot() },
          "recovery",
        );
        subscriber.lastDeliveredSeq = this.projection.seq;
        continue;
      }
      if (deltas.length === 0) {
        continue;
      }
      this.emitFrames(
        subscriber.subscriptionId,
        subscriber.lastDeliveredSeq,
        { kind: "deltas", deltas },
        "online",
      );
      subscriber.lastDeliveredSeq = this.projection.seq;
    }
  }

  private emitFrames(
    subscriptionId: string,
    fromSeq: number,
    payload:
      | { kind: "snapshot"; snapshot: ConversationSnapshot }
      | { kind: "deltas"; deltas: ConversationDelta[] },
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    const subscriber = this.subscribers.get(subscriptionId);
    if (!subscriber) return;
    // 临时 ID 订阅保持原 topic；UUID 新订阅必须以请求的 ID 发 topic 与 snapshot。
    // 两者仅是同一投影的传输别名，不创建第二份可写会话状态。
    const topic = `conversation/${subscriber.sessionId}`;
    const deliveredPayload =
      payload.kind === "snapshot"
        ? {
            kind: "snapshot" as const,
            snapshot: { ...payload.snapshot, sessionId: subscriber.sessionId },
          }
        : payload;
    const toSeq =
      deliveredPayload.kind === "snapshot" ? deliveredPayload.snapshot.seq : this.projection.seq;
    const frame = {
      topic,
      subscriptionId,
      fromSeq,
      toSeq,
      sentAt: Date.now(),
      payload: deliveredPayload,
    };
    // 同一订阅的每个逻辑帧都要递增；恒为 1 会让客户端把后续流式帧
    // 判为 proto.frameAssemblyOrdinalConflict，恢复快照也无法接管。
    subscriber.logicalFrameOrdinal += 1;
    const wires = encodeTopicWireFrames(frame, {
      deliveryKind,
      topic,
      subscriptionId,
      logicalFrameId: createId("frame"),
      logicalFrameOrdinal: subscriber.logicalFrameOrdinal,
      // 接收端按三种承载的最大 envelope 校验；发送端必须使用同一口径预分片。
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    });
    for (const wire of wires) {
      this.gateway.emitFrame(wire);
    }
  }
}
