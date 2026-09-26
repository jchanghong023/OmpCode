// 校验恢复会话快照帧是否通过 wire schema（contentFault 假设验证）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = "D:/code1111111111/forkZcode";
const packageRoot = join(repo, "packages", "omp-agent");
const adapter = join(packageRoot, "dist", "omp-agent.cjs");
const omp = join(
  packageRoot,
  "..",
  "desktop",
  "dist",
  "win-unpacked",
  "resources",
  "glm",
  "omp",
  "omp.exe",
);
const ws = "C:\\Users\\jiang\\AppData\\Local\\Temp\\omp-gui-ws";
const child = spawn(process.execPath, [adapter, "app-server", "--stdio"], {
  cwd: ws,
  env: { ...process.env, OMP_RPC_BINARY_PATH: omp, ZCODE_WORKSPACE_IDENTITY: "omp-gui-ws" },
  stdio: ["pipe", "pipe", "inherit"],
});
const frames = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    frames.push(JSON.parse(line));
  } catch {}
});
const waitUntil = async (cond, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const m = cond();
    if (m) return m;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
};
let n = 0;
const request = (method, params) => {
  const id = `q${++n}`;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return waitUntil(() => frames.find((f) => f.id === id && ("result" in f || "error" in f)));
};
await waitUntil(() =>
  frames.find((f) => f.method === "startup/storageState" && f.params?.phase === "ready"),
);
const idx = await request("v4/conversation/subscribe", {
  topic: "sessions-index/omp-gui-ws",
  connectionId: "p",
});
await new Promise((r) => setTimeout(r, 2500));
const idxFrames = frames.filter((f) => f.method === "v4/conversation/frame");
let target = null;
for (const f of idxFrames) {
  const p = f.params?.frame?.payload;
  const list = p?.snapshot?.sessions ?? [];
  if (list.length) {
    target = list[0].sessionId;
  }
}
console.log("target:", target);
frames.length = 0;
await request("v4/conversation/subscribe", {
  topic: `conversation/${target}`,
  connectionId: "p2",
  clientMode: "desktop-continuous",
});
await new Promise((r) => setTimeout(r, 5000));
const { conversationTopicWireFrameSchema } = await import(
  join("file://", repo, "packages", "shared", "src", "zcode-protocol-v4", "snapshot.js").replace(
    /\\/g,
    "/",
  )
).catch(() => ({}));
let schema = null;
try {
  schema = (
    await import(
      "file:///" + join(repo, "packages", "shared", "src", "zcode-protocol-v4", "index.ts")
    )
  ).conversationTopicWireFrameSchema;
} catch {}
const conv = frames.filter((f) => f.method === "v4/conversation/frame");
console.log("conv frames:", conv.length);
let bad = 0;
for (const f of conv) {
  const payload = f.params?.frame ?? f.params;
  if (!schema) break;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    bad++;
    if (bad <= 2)
      console.log(
        "INVALID:",
        JSON.stringify(parsed.error.issues.slice(0, 4)),
        "| payload:",
        JSON.stringify(payload).slice(0, 300),
      );
  }
}
console.log(bad === 0 ? "ALL FRAMES VALID" : `INVALID FRAMES: ${bad}/${conv.length}`);
child.kill();
