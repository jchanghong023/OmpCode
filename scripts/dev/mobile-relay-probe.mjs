// 手机远控管道自测：真实 wss 连接（不打桩）验证 relay 握手与 bootstrap。
// 用法：node mobile-relay-probe.mjs [origin]  （默认公网入口，可传 wss://127.0.0.1:8765 直连本机）
const origin = process.argv[2] ?? "wss://8.137.101.112:443";
const url = `${origin}/ws?mid=probe-script`;
const WebSocket = (await import("ws")).default;

const socket = new WebSocket(url, { rejectUnauthorized: false });
const timeout = setTimeout(() => {
  console.log("PROBE TIMEOUT");
  socket.terminate();
  process.exit(1);
}, 15000);

let authAcked = false;
socket.on("open", () => {
  console.log("OPEN", url);
  socket.send(JSON.stringify({ type: "auth_init", role: "terminal", device_sid: "probe", meta: { platform: "web", version: "probe" }, client_ts: Date.now() }));
});
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "auth_ack" || message.type === "pair_status_ack") {
    authAcked = true;
    console.log(message.type, message.pair_status);
    socket.send(JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "probe-1" }, client_ts: Date.now() }));
    return;
  }
  if (message.type === "error") {
    console.log("RELAY ERROR:", message.code);
    clearTimeout(timeout);
    socket.close();
    process.exit(message.code === "bridge_unavailable" ? 2 : 3);
  }
  const payload = message.payload;
  if (payload?.zcode_type === "bootstrap-response") {
    const workspaces = payload.result?.workspaces ?? [];
    console.log("BOOTSTRAP workspaces:", JSON.stringify(workspaces));
    clearTimeout(timeout);
    socket.close();
    process.exit(workspaces.length > 0 ? 0 : 2);
  }
});
socket.on("error", (error) => {
  console.log("WS ERROR:", error.message);
  clearTimeout(timeout);
  process.exit(1);
});
socket.on("close", (code, reason) => {
  if (!authAcked) {
    console.log("CLOSED before auth:", code, String(reason));
    clearTimeout(timeout);
    process.exit(1);
  }
});
