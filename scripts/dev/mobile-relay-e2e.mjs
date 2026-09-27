// 手机远控数据面 E2E 探针：完整复刻手机端协议链路（auth → bootstrap → bridge → RPC）。
// 用途：绕开手机 UI，验证 relay 数据面（HostV4RpcBridge ↔ Host attachment）的 RPC 往返。
// 用法：pnpm exec tsx scripts/dev/mobile-relay-e2e.mjs [origin]
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const { connectViaProtocol } = await import("../../packages/client/src/index.js");
const { HostV4RpcBridge } = await import(
  "../../packages/desktop/src/main/mobileRelay/hostV4RpcBridge.js"
);

const origin = process.argv[2] ?? "wss://8.137.101.112:443";
const socket = new WebSocket(`${origin}/ws?mid=e2e-probe`, { rejectUnauthorized: false });
const hardTimeout = setTimeout(() => {
  console.log("E2E TIMEOUT");
  process.exit(1);
}, 45000);

let bridge;
let services;
let bridgeSessionId;
let opened = false;

const send = (value) => socket.send(JSON.stringify(value));
const sendPayload = (payload) => send({ type: "data", payload, client_ts: Date.now() });

socket.on("open", () => {
  send({ type: "auth_init", role: "terminal", device_sid: "e2e-probe", client_ts: Date.now() });
});
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "auth_ack" || message.type === "pair_status_ack") {
    sendPayload({ zcode_type: "bootstrap-request", requestId: "e2e-boot" });
    return;
  }
  if (message.type === "error") {
    console.log("RELAY ERROR:", message.code);
    process.exit(2);
    return;
  }
  const payload = message.payload;
  if (!payload) return;
  if (payload.zcode_type === "bootstrap-response" && !opened) {
    const workspaces = payload.result?.workspaces ?? [];
    console.log("BOOTSTRAP:", workspaces.map((w) => w.workspacePath));
    if (!workspaces.length) process.exit(3);
    bridgeSessionId = randomUUID();
    const first = workspaces[0];
    sendPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "e2e-open",
      bridgeSessionId,
      bridgeGeneration: 1,
      workspaceKey: first.workspaceIdentity?.trim() || first.workspacePath,
    });
    return;
  }
  if (payload.zcode_type === "workspace-bridge-ready" && !opened) {
    opened = true;
    console.log("BRIDGE READY:", JSON.stringify(payload.bridge).slice(0, 140));
    bridge = new HostV4RpcBridge(payload.bridge, sendPayload);
    bridge.onFatalError((error) => {
      console.log("BRIDGE FATAL:", error.message);
      process.exit(4);
    });
    services = connectViaProtocol(bridge.protocol);
    void runRpcChecks();
    return;
  }
  if (bridge) {
    try {
      if (bridge.accept(payload)) return;
    } catch (error) {
      console.log("ACCEPT ERROR:", error.message);
      process.exit(5);
    }
  }
});
socket.on("error", (error) => {
  console.log("WS ERROR:", error.message);
  process.exit(6);
});
socket.on("close", (code) => {
  if (!opened) {
    console.log("CLOSED before bridge:", code);
    process.exit(7);
  }
});

async function runRpcChecks() {
  try {
    const settings = await services.settingService.get();
    console.log("RPC setting.get OK; recentProjects:", (settings?.recentProjects ?? []).length);
  } catch (error) {
    console.log("RPC setting.get FAILED:", error?.message ?? error);
  }
  try {
    const view = await services.modelSelectionService.getView();
    console.log(
      "RPC model-selection.getView OK; providers:",
      view?.providers?.length ?? "?",
      "revision:",
      view?.revision,
    );
  } catch (error) {
    console.log("RPC model-selection.getView FAILED:", error?.message ?? error);
  }
  try {
    const taskList = await services.windowControllerService.list({
      query: { membership: "active" },
    });
    console.log("RPC window-controller.list OK; items:", taskList?.items?.length ?? "?");
  } catch (error) {
    console.log("RPC window-controller.list FAILED:", error?.message ?? error);
  }
  console.log("E2E DONE");
  clearTimeout(hardTimeout);
  services.dispose();
  bridge.dispose();
  socket.close();
  process.exit(0);
}
