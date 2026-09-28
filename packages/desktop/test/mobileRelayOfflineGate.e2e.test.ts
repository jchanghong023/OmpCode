import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

/**
 * 手机远控 relay 离线门控的本机 WebSocket 探测 E2E（mobile-relay.md 验收 5）。
 *
 * 真实链路：node:https + ws 的真实 TLS relay → Node 模拟 terminal WebSocket 直连
 * 127.0.0.1 临时端口 → auth_init/auth_ack 握手 → bootstrap 分发（无 Host 时
 * bridge_unavailable）→ 停止监听后同端口探测被拒。
 *
 * 证据边界：锁定桌面的完整进程级探测（对 8765 探测已锁定的真实应用）属 P2/VM
 * 验收；frp 真机链路缺失时如实记录为未验证范围，不以条件判断替代。
 */

// logger/server 模块顶层会确定日志目录；先切到测试目录再动态 import，避免污染用户目录。
process.env.ZCODE_ENV = "test";
const logRoot = await mkdtemp(join(tmpdir(), "omp-mobile-relay-e2e-"));
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = logRoot;

const { resolveOfflineGateState, buildOfflineLockedMobileRelayEntryStatus } = await import(
  "@zcode/shared"
);
const { MobileRelayServer } = await import("../src/main/mobileRelay/mobileRelayServer.js");
const { loadOrCreateMobileRelayCertificate } = await import(
  "../src/main/mobileRelay/mobileRelayCertificate.js"
);
const { MOBILE_RELAY_WS_PATH } = await import("../src/main/mobileRelay/mobileRelayProtocol.js");

const { createServer } = await import("node:net");

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

test("真实 TLS relay：握手 → bootstrap 分发 → 停止后同端口探测被拒", async (context) => {
  const certificate = await loadOrCreateMobileRelayCertificate(
    await mkdtemp(join(tmpdir(), "omp-mobile-relay-e2e-cert-")),
  );
  const listenPort = await allocateFreePort();
  const server = new MobileRelayServer({
    certificate,
    listenPort,
    resolveFocusHost: () => undefined,
    requestBridgeableWorkspaces: async () => [],
  });
  // 失败中止时也必须停掉监听，否则残留 httpServer 会挂住测试进程。
  context.after(() => server.stop());
  await server.start();

  // Phase 1：真实 TLS + WebSocket 握手直通与 bootstrap 分发（无焦点 Host → 明确错误码）。
  const frames = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const socket = new WebSocket(`wss://127.0.0.1:${listenPort}${MOBILE_RELAY_WS_PATH}`, {
      rejectUnauthorized: false,
    });
    const timeout = setTimeout(() => reject(new Error("relay E2E timeout")), 10_000);
    socket.on("message", (raw) => {
      received.push(JSON.parse(String(raw)) as Record<string, unknown>);
      if (received.length >= 2) {
        clearTimeout(timeout);
        socket.close();
        resolve(received);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "auth_init", role: "terminal", sid: "s", hash: "h" }));
      socket.send(
        JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request" } }),
      );
    });
  });
  assert.equal(frames[0]!.type, "auth_ack");
  assert.equal(frames[0]!.pair_status, "matched");
  assert.equal(frames[1]!.type, "error");
  assert.equal(frames[1]!.code, "bridge_unavailable");
  assert.equal(server.getStatus().running, true);

  // Phase 2：门控即桌面行为——LOCAL_ONLY=1 时 startMobileRelay 不会被调用，
  // 入口回报禁用状态；relay 停止监听后，同端口本机探测连接被拒。
  const gated = resolveOfflineGateState({ OMPCODE_CENTOS7_LOCAL_ONLY: "1" });
  assert.equal(gated.disabledFeatures.mobileRelay, true);
  const entry = buildOfflineLockedMobileRelayEntryStatus({
    url: `https://8.137.101.112/remote/v4?sid=s&hash=h&t=${Date.now()}`,
    listenPort,
  });
  assert.equal(entry.running, false);
  assert.equal(entry.error, "offline-locked");

  await server.stop();
  assert.equal(server.getStatus().running, false);
  await new Promise<void>((resolve, reject) => {
    const probe = new WebSocket(`wss://127.0.0.1:${listenPort}${MOBILE_RELAY_WS_PATH}`, {
      rejectUnauthorized: false,
    });
    const timeout = setTimeout(() => reject(new Error("gated relay unexpectedly accepted")), 5_000);
    probe.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    probe.on("open", () => {
      clearTimeout(timeout);
      probe.close();
      reject(new Error("locked relay must not listen"));
    });
  });
});
