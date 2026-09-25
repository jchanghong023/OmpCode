import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const ws = "C:\\Users\\jiang\\AppData\\Local\\Temp\\omp-gui-ws";
const child = spawn(process.execPath, [process.argv[2], "app-server", "--stdio"], {
  cwd: ws,
  env: { ...process.env, OMP_RPC_BINARY_PATH: process.argv[3] },
  stdio: ["pipe", "pipe", "inherit"],
});
const frames = [];
createInterface({ input: child.stdout }).on("line", (l) => { try { frames.push(JSON.parse(l)); } catch {} });
const waitUntil = async (cond, ms = 20000) => { const t0 = Date.now(); for (;;) { const m = cond(); if (m) return m; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 40)); } };
let n = 0;
const request = (method, params) => { const id = `q${++n}`; child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); return waitUntil(() => frames.find((f) => f.id === id && ("result" in f || "error" in f))); };
await waitUntil(() => frames.find((f) => f.method === "startup/storageState" && f.params?.phase === "ready"));
await request("v4/conversation/subscribe", { topic: "sessions-index/omp-gui-ws", connectionId: "p" });
await new Promise((r) => setTimeout(r, 4000));
const conv = frames.filter((f) => f.method === "v4/conversation/frame");
console.log("frames:", conv.length);
for (const f of conv) {
  const p = f.params?.frame ?? f.params;
  console.log(JSON.stringify(p).slice(0, 600));
}
child.kill();
