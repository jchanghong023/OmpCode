// N06：本任务专用 Windows 桌面启动器。只派生临时根与进程，不连接用户日常实例。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  nativeCredentialEnv,
  nativeFixtureEnv,
  prepareNativeFixture,
} from "../../omp-agent/test/fixtures/nativeCommandFixture.mjs";

assert.equal(process.platform, "win32", "This launcher is for the isolated Windows acceptance");
assert.equal(process.env.OMP_NATIVE_E2E, "1", "Set OMP_NATIVE_E2E=1 to opt into real GLM calls");
const desktop = resolve(import.meta.dirname, "..");
const fixture = await prepareNativeFixture(process.env.OMP_NATIVE_GUI_ROOT);
const credentials = await nativeCredentialEnv();
// Desktop Host 为每个工作区显式派生身份；stdio 单工作区 harness 的固定身份不能污染整棵桌面进程。
const fixtureEnv = nativeFixtureEnv(fixture, credentials);
delete fixtureEnv.ZCODE_WORKSPACE_IDENTITY;
const applicationName = `OmpCode Native E2E ${basename(fixture.root)}`;
const userData = join(`${fixture.configRoot}_ompcode`, "electron", applicationName);
// renderer 来源由隔离准备器持有；保留手动入口默认值，但配置不能被固定端口覆盖。
const rendererUrl = (
  process.env.OMP_E2E_RENDERER_URL ??
  (process.env.OMP_E2E_RUNTIME_MANIFEST
    ? JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8")).rendererUrl
    : undefined) ??
  "http://localhost:5194"
).replace(/\/+$/u, "");
// 本任务使用独占端口；禁止接入日常 CDP 或复用任何已有监听。
const cdpPort = Number(process.env.OMP_E2E_CDP_PORT ?? 9257);
assert.ok(
  Number.isInteger(cdpPort) && cdpPort > 0 && cdpPort <= 65535,
  "OMP_E2E_CDP_PORT must be a valid dedicated port",
);
assert.ok(cdpPort !== 9230 && cdpPort !== 9229, "Use a dedicated test CDP port");
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const metaPath = join(fixture.root, "native-gui-launch.json");
const require = createRequire(import.meta.url);
const electron = join(dirname(require.resolve("electron/package.json")), "dist", "electron.exe");
await Promise.all([
  access(electron),
  access(join(desktop, "out/main/index.js")),
  access(join(desktop, "out/host/index.js")),
  access(join(desktop, "out/preload/index.cjs")),
  mkdir(join(fixture.root, "home"), { recursive: true }),
]);
assert.ok((await fetch(rendererUrl, { method: "HEAD" })).ok, "Start this worktree's Vite first");
await new Promise((resolveFree, reject) => {
  const probe = createServer();
  probe.once("error", () =>
    reject(new Error(`Dedicated CDP ${cdpPort} is occupied; stop only this fixture's launcher`)),
  );
  probe.listen(cdpPort, "127.0.0.1", () => probe.close(resolveFree));
});
const child = spawn(
  electron,
  [".", `--remote-debugging-port=${cdpPort}`, "--open-workspace", fixture.workspace],
  {
    cwd: desktop,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...fixtureEnv,
      OMP_OFFLINE: "",
      OMPCODE_CENTOS7_LOCAL_ONLY: "",
      ELECTRON_RENDERER_URL: rendererUrl,
      ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
      ZCODE_DESKTOP_APPLICATION_NAME: applicationName,
      ZCODE_DESKTOP_HOME_DIR: join(fixture.root, "home"),
      ZCODE_DESKTOP_USER_DATA_DIR: userData,
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(userData, "session"),
    },
  },
);
const meta = {
  ...fixture,
  applicationName,
  userData,
  rendererUrl,
  cdpUrl,
  pid: child.pid,
  requestedWorkspace: fixture.workspace,
  workspaceSelection: "GUI must create the task in this exact project sidebar entry",
  state: "starting",
  startedAt: new Date().toISOString(),
};
await writeFile(metaPath, JSON.stringify(meta, null, 2));
// 子进程诊断可能跨 chunk 含密钥；按完整行缓冲并脱敏后才落盘，不输出凭据。
const secrets = Object.values(credentials).filter(Boolean);
const redact = (line) =>
  secrets
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line)
    .replace(/(Bearer\s+)[^\s"']+/giu, "$1[redacted]");
let logWrites = Promise.resolve();
for (const [kind, stream] of [
  ["stdout", child.stdout],
  ["stderr", child.stderr],
]) {
  let pending = "";
  const record = (line) => {
    logWrites = logWrites.then(async () => {
      const path = join(fixture.evidence, `desktop-${kind}.log`);
      await appendFile(path, `${redact(line)}\n`);
    });
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) record(line);
  });
  stream.on("end", () => {
    if (pending) record(pending);
  });
}
let closed = false;
let shuttingDown = false;
const exited = new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => {
    closed = true;
    resolveExit(code ?? 1);
  });
});
function stop() {
  if (closed || shuttingDown) return;
  shuttingDown = true;
  child.kill();
  const timer = setTimeout(() => {
    if (!closed && child.pid)
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  }, 5000);
  timer.unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
try {
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!closed && Date.now() < deadline) {
    const response = await fetch(`${cdpUrl}/json/version`).catch(() => undefined);
    if (response?.ok) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  assert.ok(ready, "Isolated Electron failed to expose its dedicated CDP");
  meta.state = "ready";
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  console.log(
    JSON.stringify({
      metaPath,
      root: fixture.root,
      evidence: fixture.evidence,
      cdpUrl,
      pid: child.pid,
    }),
  );
  process.exitCode = await exited;
} finally {
  stop();
  await exited;
  await logWrites;
  meta.state = "closed";
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}
