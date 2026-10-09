// 三代理执行页联合验收的可复现启动器；只管理自己创建的隔离进程。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { snapshot } from "../../../scripts/test-gates-process.mjs";
import {
  nativeCredentialEnv,
  nativeFixtureEnv,
  nativeModel,
  nativeOmpBinary,
  prepareNativeFixture,
} from "../../omp-agent/test/fixtures/nativeCommandFixture.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.env.OMP_NATIVE_E2E, "1", "Opt into this isolated real OMP/GLM fixture");
const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const fixture = await prepareNativeFixture(process.env.OMP_E2E_ISOLATED_ROOT);
const configPath = join(fixture.configRoot, "agent/config.yml");
const config = await readFile(configPath, "utf8");
// task 角色只作用于这个临时根；不读取或改写用户的模型角色配置。
const taskRole = `  task: ${nativeModel}`;
await writeFile(
  configPath,
  /^  task:.*$/mu.test(config)
    ? config.replace(/^  task:.*$/mu, taskRole)
    : config.replace("modelRoles:\n", `modelRoles:\n${taskRole}\n`),
);
const credentials = await nativeCredentialEnv();
async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  assert.ok(port !== 9229 && port !== 9230);
  return port;
}
const rendererUrl = `http://127.0.0.1:${await freePort()}/`;
const endpoint = `http://127.0.0.1:${await freePort()}`;
const hash = createHash("sha256");
for await (const chunk of createReadStream(nativeOmpBinary)) hash.update(chunk);
const meta = {
  ...fixture,
  rendererUrl,
  endpoint,
  source: await snapshot(),
  model: nativeModel,
  node: process.versions.node,
  ompBinary: nativeOmpBinary,
  ompSha256: hash.digest("hex"),
  launcherPid: process.pid,
  startedAt: new Date().toISOString(),
};
const runtimePath = join(fixture.root, "runtime.json");
const env = {
  ...nativeFixtureEnv(fixture, credentials),
  PATH: `${dirname(process.execPath)};${process.env.PATH}`,
  ZCODE_ENV: "test",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DESKTOP_APPLICATION_NAME: `OmpCode Execution Pages ${basename(fixture.root)}`,
  ZCODE_DATA_BASE_DIR: join(fixture.root, "data"),
  ZCODE_DESKTOP_HOME_DIR: join(fixture.root, "home"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(fixture.root, "userData"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(fixture.root, "sessionData"),
  ELECTRON_RENDERER_URL: rendererUrl,
};
delete env.ZCODE_WORKSPACE_IDENTITY;
delete env.ELECTRON_RUN_AS_NODE;
const args = JSON.parse(env.OMP_RPC_ARGS_JSON);
const approval = args.indexOf("--approval-mode");
assert.ok(approval >= 0);
args[approval + 1] = "yolo";
env.OMP_RPC_ARGS_JSON = JSON.stringify(args);
for (const dir of ["data", "home", "userData", "sessionData"])
  await mkdir(join(fixture.root, dir), { recursive: true });

const processes = [];
let logWrites = Promise.resolve();
const redact = (line) =>
  Object.values(credentials)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line)
    .replace(/(Bearer\s+)[^\s"']+/giu, "$1[redacted]");
function launch(name, binary, args) {
  const child = spawn(binary, args, {
    cwd: desktop,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  for (const [kind, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ]) {
    let pending = "";
    const record = (line) => {
      logWrites = logWrites.then(() =>
        appendFile(
          join(fixture.evidence, `${name}-${kind}-${process.pid}.log`),
          `${redact(line)}\n`,
        ),
      );
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
  child.on("error", (error) => {
    child.launchError = error;
  });
  return child;
}
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  for (const child of processes.toReversed()) {
    if (!child.pid || child.exitCode !== null) continue;
    await new Promise((done) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", done);
      killer.once("error", done);
    });
  }
  await logWrites;
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
async function ready(url, child, accepts = () => true) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.launchError) throw child.launchError;
    assert.equal(child.exitCode, null, "Owned test process exited before readiness");
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok && accepts(await response.text())) return;
    await sleep(200);
  }
  throw new Error(`Isolated readiness timed out: ${url}`);
}
try {
  const vite = launch("vite", process.execPath, [
    join(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    new URL(rendererUrl).port,
    "--strictPort",
  ]);
  await ready(rendererUrl, vite);
  const electron = launch(
    "electron",
    join(dirname(require.resolve("electron/package.json")), "dist/electron.exe"),
    [
      ".",
      `--remote-debugging-port=${new URL(endpoint).port}`,
      "--open-workspace",
      fixture.workspace,
    ],
  );
  await ready(`${endpoint}/json/list`, electron, (text) =>
    JSON.parse(text).some((tab) => tab.url.startsWith(rendererUrl)),
  );
  meta.electronPid = electron.pid;
  await writeFile(runtimePath, JSON.stringify(meta, null, 2));
  console.log(
    JSON.stringify({
      state: "ready",
      runtimePath,
      root: fixture.root,
      endpoint,
      rendererUrl,
      evidence: fixture.evidence,
      electronPid: electron.pid,
    }),
  );
  await new Promise((done) => electron.once("exit", done));
} finally {
  await stop();
}
