// 只读探针：订阅 omp-gui-ws 下冷会话的 conversation topic，检查快照/恢复帧。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const adapter = process.argv[2];
const omp = process.argv[3];
const ws = "C:\\Users\\jiang\\AppData\\Local\\Temp\\omp-gui-ws";
const child = spawn(process.execPath, [adapter, "app-server", "--stdio"], {
  cwd: ws,
  env: { ...process.env, OMP_RPC_BINARY_PATH: omp, ZCODE_WORKSPACE_IDENTITY: "omp-gui-ws" },
  stdio: ["pipe", "pipe", "inherit"],
});
const frames = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  try { frames.push(JSON.parse(line)); } catch {}
});
const waitUntil = async (cond, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const m = cond();
    if (m) return m;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};
let n = 0;
const request = (method, params) => {
  const id = `q${++n}`;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return waitUntil(() => frames.find((f) => f.id === id && ("result" in f || "error" in f)));
};
await waitUntil(() => frames.find((f) => f.method === "startup/storageState" && f.params?.phase === "ready"));
// sessions-index 快照拿冷会话 id
const idx = await request("v4/conversation/subscribe", {
  topic: "sessions-index/omp-gui-ws",
  connectionId: "probe",
});
const ack = idx.result?.ack;
await new Promise((r) => setTimeout(r, 3000));
const idxFrames = frames.filter((f) => f.method === "v4/conversation/frame");
const idxPayloads = idxFrames.map((f) => f.params?.frame?.payload ?? f.params?.payload);
const sessions = [];
for (const p of idxPayloads) {
  const list = p?.snapshot?.sessions ?? (p?.deltas ?? []).filter(d => d.op === "session.upserted").map(d => d.session);
  for (const s of list) sessions.push({ id: s.sessionId, title: (s.title ?? "").slice(0, 30), phase: s.phase });
}
console.log("sessions:", JSON.stringify(sessions, null, 1));
const target = sessions.find((s) => s.id && !s.id.startsWith("sess_"));
if (!target) {
  console.log("no cold omp session found");
  child.kill();
  process.exit(0);
}
console.log("resume target:", target.id);
frames.length = 0;
const sub = await request("v4/conversation/subscribe", {
  topic: `conversation/${target.id}`,
  connectionId: "probe2",
  clientMode: "desktop-continuous",
});
console.log("sub ack:", JSON.stringify(sub).slice(0, 240));
await new Promise((r) => setTimeout(r, 5000));
const conv = frames.filter((f) => f.method === "v4/conversation/frame");
console.log("conversation frames:", conv.length);
for (const f of conv.slice(0, 4)) {
  const p = f.params?.frame ?? f.params;
  console.log(" frame kind=", p?.payload?.kind, "deliveryKind=", f.params?.deliveryKind, "rows=", p?.payload?.snapshot?.rows?.totalCount ?? "-", "deltas=", p?.payload?.deltas?.length ?? "-");
}
// 错误帧?
const errs = frames.filter((f) => f.error || (f.params?.fault));
console.log("errors:", JSON.stringify(errs).slice(0, 300));
child.kill();
