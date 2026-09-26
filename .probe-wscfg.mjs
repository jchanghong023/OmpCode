// 只读探针：拉起打包态 omp-agent.cjs，订阅 workspace-config topic，打印 configOptions。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adapter = process.argv[2];
const omp = process.argv[3];
const cwd = mkdtempSync(join(tmpdir(), "omp-wscfg-probe-"));
const child = spawn(process.execPath, [adapter, "app-server", "--stdio"], {
  cwd,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    OMP_RPC_BINARY_PATH: omp,
    ZCODE_WORKSPACE_IDENTITY: "probe-ws",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const frames = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
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
    await new Promise((r) => setTimeout(r, 50));
  }
};
let nextId = 0;
const request = (method, params) => {
  const id = `p${++nextId}`;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return waitUntil(() => frames.find((f) => f.id === id && ("result" in f || "error" in f)));
};
await waitUntil(() =>
  frames.find((f) => f.method === "startup/storageState" && f.params?.phase === "ready"),
);
const sub = await request("v4/conversation/subscribe", {
  topic: "workspace-config/probe-ws",
  connectionId: "probe-conn",
  clientMode: "desktop-continuous",
});
console.log("subscribe:", JSON.stringify(sub).slice(0, 200));
await new Promise((r) => setTimeout(r, 12000));
const cfgFrames = frames.filter((f) => f.method === "v4/conversation/frame");
console.log("config frames:", cfgFrames.length);
const last = cfgFrames[cfgFrames.length - 1];
if (last) {
  const payload = last.params?.frame?.payload ?? last.params?.payload;
  const snapshot = payload?.snapshot;
  const opts = snapshot?.config?.configOptions ?? [];
  const modelOption = opts.find((o) => o.id === "model" || o.category === "model");
  console.log(
    "configOptions count:",
    opts.length,
    "model option:",
    modelOption
      ? `id=${modelOption.id} currentValue=${modelOption.currentValue} options=${modelOption.options?.length}`
      : "NONE",
  );
  if (modelOption?.options?.length) {
    for (const o of modelOption.options.slice(0, 8)) console.log("  ", o.value, "|", o.name);
    console.log("   ...", modelOption.options.length, "total");
  }
  console.log("slashCommands:", (snapshot?.slashCommands ?? []).length);
} else {
  console.log("no config frame");
}
child.stdin.end();
setTimeout(() => child.kill(), 300);
