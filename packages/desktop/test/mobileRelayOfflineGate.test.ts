import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

/**
 * 手机远控 relay 离线锁定门控回归（mobile-relay.md 验收 5 的 UT 部分）：
 * 门控派生（不监听）、握手直通与畸形帧拒绝、入口禁用状态。
 * 真实 TLS/WebSocket 链路探测见 mobileRelayOfflineGate.e2e.test.ts。
 */

// logger/server 模块顶层会确定日志目录；先切到测试目录再动态 import，避免污染用户目录。
process.env.ZCODE_ENV = "test";
const logRoot = await mkdtemp(join(tmpdir(), "omp-mobile-relay-gate-"));
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = logRoot;

const {
  resolveOfflineGateState,
  parseOfflineGateState,
  buildOfflineLockedMobileRelayEntryStatus,
  MOBILE_RELAY_OFFLINE_LOCKED_ERROR,
} = await import("@zcode/shared");
const { MobileRelayServer } = await import("../src/main/mobileRelay/mobileRelayServer.js");
const { loadOrCreateMobileRelayCertificate } = await import(
  "../src/main/mobileRelay/mobileRelayCertificate.js"
);
const { MOBILE_RELAY_WS_PATH } = await import("../src/main/mobileRelay/mobileRelayProtocol.js");

const { createServer } = await import("node:net");

/** 申请临时端口（listen(0) 语义）；端口释放后再交给被测服务，不抢占固定 8765。 */
async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolve(address.port));
    });
    probe.on("error", reject);
  });
}

test.after(() => rm(logRoot, { recursive: true, force: true }));

test("门控派生：未锁定时 11 项功能面全部可用（与 Windows 全功能基准一致）", () => {
  const gate = resolveOfflineGateState({ OMPCODE_CENTOS7_LOCAL_ONLY: "0" });
  assert.equal(gate.localOnly, false);
  assert.deepEqual(Object.values(gate.disabledFeatures).every((value) => value === false), true);
});

test("门控派生：离线锁定时全部后端关闭，relay 不监听由该状态驱动", () => {
  const gate = resolveOfflineGateState({ OMPCODE_CENTOS7_LOCAL_ONLY: "1" });
  assert.equal(gate.localOnly, true);
  // 与 centos7-release.md 门控面清单一一对应的 11 项。
  assert.deepEqual(gate.disabledFeatures, {
    mobileRelay: true,
    publicUpdateCheck: true,
    publicConfig: true,
    publicHelp: true,
    community: true,
    feedback: true,
    accountShare: true,
    externalBrowser: true,
    telemetry: true,
    hostOnlineBots: true,
    remoteRecommendedPrompts: true,
  });
});

test("运行时校验：非法门控状态被拒绝，合法载荷可解析", () => {
  const valid = resolveOfflineGateState({});
  assert.deepEqual(parseOfflineGateState(JSON.parse(JSON.stringify(valid))), valid);
  assert.throws(() => parseOfflineGateState({ localOnly: "yes", disabledFeatures: {} }));
  assert.throws(() =>
    parseOfflineGateState({ ...valid, disabledFeatures: { ...valid.disabledFeatures, extra: true } }),
  );
  assert.throws(() => parseOfflineGateState(null));
});

test("入口状态：离线锁定下 relay 入口回报禁用原因码且不运行", () => {
  const status = buildOfflineLockedMobileRelayEntryStatus({
    url: "https://8.137.101.112/remote/v4?sid=s&hash=h&t=1",
    listenPort: 8765,
  });
  assert.equal(status.running, false);
  assert.equal(status.connections, 0);
  assert.equal(status.error, MOBILE_RELAY_OFFLINE_LOCKED_ERROR);
  assert.equal(status.url, "https://8.137.101.112/remote/v4?sid=s&hash=h&t=1");
  assert.equal(status.listenPort, 8765);
});

test("握手直通与畸形帧拒绝：真实 TLS relay 上的门控无关协议行为", async (context) => {
  const certificate = await loadOrCreateMobileRelayCertificate(
    await mkdtemp(join(tmpdir(), "omp-mobile-relay-cert-")),
  );
  const listenPort = await allocateFreePort();
  const server = new MobileRelayServer({
    certificate,
    listenPort,
    resolveFocusHost: () => undefined,
    requestBridgeableWorkspaces: async () => [],
  });
  context.after(() => server.stop());
  await server.start();

  // 握手直通：auth_init（无鉴权开放接入，relay 不校验 sid/hash）→ auth_ack matched。
  const handshake = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${listenPort}${MOBILE_RELAY_WS_PATH}`, {
      rejectUnauthorized: false,
    });
    socket.on("message", (raw) => {
      resolve(JSON.parse(String(raw)) as Record<string, unknown>);
      socket.close();
    });
    socket.on("error", reject);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "auth_init", role: "terminal", sid: "s", hash: "h" }));
    });
  });
  assert.equal(handshake.type, "auth_ack");
  assert.equal(handshake.pair_status, "matched");

  // 畸形帧拒绝：非 JSON 帧必须断开连接（1002），不进入任何桥接流程。
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${listenPort}${MOBILE_RELAY_WS_PATH}`, {
      rejectUnauthorized: false,
    });
    const timeout = setTimeout(() => reject(new Error("malformed frame was not rejected")), 5_000);
    socket.on("close", (code) => {
      clearTimeout(timeout);
      assert.equal(code, 1002);
      resolve();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("open", () => {
      socket.send("not-json-at-all");
    });
  });
});
