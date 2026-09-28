import assert from "node:assert/strict";
import { test } from "node:test";
import { HostV4RpcBridge, type HostV4BridgeInfo } from "../src/main/mobileRelay/hostV4RpcBridge.js";

/**
 * Host 侧 v4 RPC 帧桥 UT。协议两端对称（手机端 V4RpcBridge 与本实现同构），
 * 测试用两个 HostV4RpcBridge 实例在内存中互连，验证分片组装、ACK 推进、
 * 重放与 fail-closed 语义。
 */

interface FramePipe {
  deliver: (payload: Record<string, unknown>) => void;
}

function createPair() {
  const infoA: HostV4BridgeInfo = {
    bridgeSessionId: "session-a",
    bridgeGeneration: 1,
    workspacePath: "D:/demo",
  };
  const infoB: HostV4BridgeInfo = {
    bridgeSessionId: "session-a",
    bridgeGeneration: 1,
    workspacePath: "D:/demo",
  };

  const channelAToB: FramePipe[] = [];
  const channelBToA: FramePipe[] = [];

  const bridgeA = new HostV4RpcBridge(infoA, (payload) => {
    for (const consumer of channelAToB) consumer(payload as Record<string, unknown>);
  });
  const bridgeB = new HostV4RpcBridge(infoB, (payload) => {
    for (const consumer of channelBToA) consumer(payload as Record<string, unknown>);
  });

  const receivedByA: Uint8Array[] = [];
  const receivedByB: Uint8Array[] = [];
  const fatalsA: Error[] = [];
  const fatalsB: Error[] = [];
  bridgeA.onMessage((buffer) => receivedByA.push(buffer.buffer));
  bridgeB.onMessage((buffer) => receivedByB.push(buffer.buffer));
  bridgeA.onFatalError((error) => fatalsA.push(error));
  bridgeB.onFatalError((error) => fatalsB.push(error));

  function connect(): void {
    channelAToB.push((payload) => {
      if (bridgeB["fatalError"]) return;
      bridgeB.accept(payload);
    });
    channelBToA.push((payload) => {
      if (bridgeA["fatalError"]) return;
      bridgeA.accept(payload);
    });
  }

  return {
    bridgeA,
    bridgeB,
    receivedByA,
    receivedByB,
    fatalsA,
    fatalsB,
    connect,
    channelAToB,
    channelBToA,
  };
}

test("往返：小消息经分片、组装、ACK 双向投递", () => {
  const pair = createPair();
  pair.connect();

  const message = new TextEncoder().encode("hello mobile relay");
  pair.bridgeA.send(message);
  assert.equal(pair.receivedByB.length, 1);
  assert.deepEqual(Buffer.from(pair.receivedByB[0]!), Buffer.from(message));

  const reply = new TextEncoder().encode("ack from host");
  pair.bridgeB.send(reply);
  assert.equal(pair.receivedByA.length, 1);
  assert.deepEqual(Buffer.from(pair.receivedByA[0]!), Buffer.from(reply));
});

test("分片：超过单片上限的消息按 256KiB 分片并在对端重组", () => {
  const pair = createPair();
  pair.connect();

  const big = new Uint8Array(256 * 1024 * 3 + 1234);
  for (let index = 0; index < big.length; index += 1) big[index] = index % 251;
  pair.bridgeA.send(big);
  assert.equal(pair.receivedByB.length, 1);
  assert.deepEqual(Buffer.from(pair.receivedByB[0]!), Buffer.from(big));
});

test("会话隔离：不匹配 bridgeSessionId 的帧被忽略", () => {
  const pair = createPair();
  pair.connect();

  const foreign = {
    zcode_type: "rpc-frame",
    bridgeSessionId: "other-session",
    bridgeGeneration: 1,
    seq: 1,
    messageSeq: 1,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: 4,
    checksum: { algorithm: "crc32" as const, value: "00000000" },
    dataBase64: Buffer.from("test").toString("base64"),
  };
  // accept 返回 false 表示不属于本桥。
  assert.equal(pair.bridgeA.accept(foreign), false);
  assert.equal(pair.receivedByA.length, 0);
});

test("跳洞 fail-closed：完成投递的 messageSeq 出现空洞时触发 fatal", () => {
  const pair = createPair();
  pair.connect();

  // 手工构造 seq=1、seq=3 两帧（跳过 2），第 3 帧完成投递时必须 fatal 而非静默投递。
  const payload = new TextEncoder().encode("x");
  const { crc32 } = (() => {
    // 复用被测模块同算法：直接借 bridge 内部不可行，这里在测试内实现一份 CRC32。
    const table = Uint32Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      return value >>> 0;
    });
    const crc32 = (bytes: Uint8Array): string => {
      let value = 0xffffffff;
      for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
      return ((value ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
    };
    return { crc32 };
  })();

  const frame = (messageSeq: number) => ({
    zcode_type: "rpc-frame" as const,
    bridgeSessionId: pair.bridgeA["bridge"].bridgeSessionId,
    bridgeGeneration: 1,
    seq: messageSeq,
    messageSeq,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: payload.length,
    checksum: { algorithm: "crc32" as const, value: crc32(payload) },
    dataBase64: Buffer.from(payload).toString("base64"),
  });

  pair.channelBToA.length = 0; // 断开自动通道，手工投递
  pair.bridgeA.accept(frame(1));
  assert.equal(pair.receivedByA.length, 1);
  pair.bridgeA.accept(frame(3));
  assert.equal(pair.fatalsA.length, 1, "序号空洞必须 fail-closed");
  assert.match(pair.fatalsA[0]!.message, /sequence gap/);
});

test("重放：replayUnacknowledged 重发未确认帧，对端按重复帧幂等处理", () => {
  const pair = createPair();
  // 不连接：发送后没有任何 ACK。
  const message = new TextEncoder().encode("unacked");
  pair.bridgeA.send(message);

  let deliveries = 0;
  pair.channelAToB.push((payload) => {
    deliveries += 1;
    pair.bridgeB.accept(payload);
  });
  pair.bridgeA.replayUnacknowledged();
  pair.bridgeA.replayUnacknowledged();
  // 两次重放产生重复帧，但 messageSeq 相同：对端只投递一次并重复确认。
  assert.equal(pair.receivedByB.length, 1);
  assert.ok(deliveries >= 2);
});

test("CRC 校验：篡改分片数据在组装完成时被拒绝", () => {
  const pair = createPair();
  pair.channelAToB.push((payload) => {
    const frame = { ...(payload as Record<string, unknown>) };
    if (frame.zcode_type === "rpc-frame") {
      frame.dataBase64 = Buffer.from("tampered!!!").toString("base64");
    }
    assert.throws(() => pair.bridgeB.accept(frame as Record<string, unknown>), /checksum|length/i);
  });
  pair.bridgeA.send(new TextEncoder().encode("integrity"));
  assert.equal(pair.receivedByB.length, 0);
});

test("ACK 确认推进：对端确认后 outbound 清空", () => {
  const pair = createPair();
  // 未连接时发送：无 ACK，消息保留在 outbound。
  pair.bridgeA.send(new TextEncoder().encode("first"));
  pair.bridgeA.send(new TextEncoder().encode("second"));
  assert.equal(pair.bridgeA["outbound"].size, 2, "未确认消息应保留在 outbound");

  // 连接并重放：B 投递并同步回 ACK，A 的 outbound 应清空。
  pair.connect();
  pair.bridgeA.replayUnacknowledged();
  assert.equal(pair.receivedByB.length, 2);
  assert.equal(pair.bridgeA["outbound"].size, 0, "已确认消息应从 outbound 释放");
});
