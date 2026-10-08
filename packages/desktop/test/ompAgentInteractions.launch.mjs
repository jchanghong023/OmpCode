// 专用隔离启动器；只启动本次验收进程，不连接或关闭用户日常实例。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktopRoot, "package.json"));
const runRoot = process.env.OMP_E2E_ISOLATED_ROOT;
const cdpPort = Number(process.env.OMP_E2E_CDP_PORT ?? 9232);
const rendererPort = Number(process.env.OMP_E2E_RENDERER_PORT ?? 5196);
assert.ok(runRoot && isAbsolute(runRoot), "Set an absolute OMP_E2E_ISOLATED_ROOT");
assert.ok(cdpPort !== 9230 && cdpPort !== 9229, "Use a dedicated test CDP port");
assert.ok(rendererPort !== 5194, "Use a dedicated test renderer port");
const rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const endpoint = `http://127.0.0.1:${cdpPort}`;
const manifestPath = join(runRoot, "runtime.json");
const env = {
  ...process.env,
  ZCODE_ENV: "test",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DESKTOP_APPLICATION_NAME: "OmpCode Agent Interactions Acceptance",
  ZCODE_DATA_BASE_DIR: join(runRoot, "data"),
  ZCODE_DESKTOP_HOME_DIR: join(runRoot, "home"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(runRoot, "userData"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(runRoot, "sessionData"),
  ELECTRON_RENDERER_URL: rendererUrl,
};
const requestedWorkspace =
  process.env.OMP_E2E_OPEN_TEST_PROJECT === "1" ? join(runRoot, "acceptance-project") : undefined;
// OMP_CONFIG_ROOT 派生应用目录的优先级更高；绝不能让测试落到用户的派生目录。
assert.ok(!env.OMP_CONFIG_ROOT?.trim(), "Unset OMP_CONFIG_ROOT for isolated GUI acceptance");
for (const name of ["data", "home", "userData", "sessionData"])
  await mkdir(join(runRoot, name), { recursive: true });
// 每个task的默认模型可能来自用户@task角色；仅给隔离工作区提供专用agent，
// 把主/子/嵌套验收都固定到GLM而不改变用户配置。
const agentDir = join(
  requestedWorkspace ?? join(env.ZCODE_DATA_BASE_DIR, ".ompcode/workspace/default"),
  ".omp/agents",
);
await mkdir(agentDir, { recursive: true });
const agentFixture = await readFile(
  join(desktopRoot, "test/fixtures/ompInteractionAgent.md"),
  "utf8",
);
await writeFile(join(agentDir, "interaction-test.md"), agentFixture);
// 模型可能在嵌套task中选择默认task；项目级覆盖仍只作用于这个测试workspace。
await writeFile(
  join(agentDir, "task.md"),
  agentFixture.replace("name: interaction-test", "name: task"),
);

async function ensureFree(url) {
  const alive = await fetch(url, { signal: AbortSignal.timeout(1000) })
    .then(() => true)
    .catch(() => false);
  assert.equal(alive, false, `Refusing to share an existing listener at ${url}`);
}
await ensureFree(rendererUrl);
await ensureFree(`${endpoint}/json/version`);
const children = [];
function launch(name, executable, args) {
  const child = spawn(executable, args, { cwd: desktopRoot, env, windowsHide: true });
  child.stdout.pipe(createWriteStream(join(runRoot, `${name}-stdout.log`), { flags: "a" }));
  child.stderr.pipe(createWriteStream(join(runRoot, `${name}-stderr.log`), { flags: "a" }));
  children.push(child);
  child.on("error", (error) => console.error(`${name}: ${error.message}`));
  return child;
}
async function waitReady(url, child) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child.exitCode !== null) throw new Error(`Startup exited with ${child.exitCode}`);
    if (
      await fetch(url, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok)
        .catch(() => false)
    )
      return;
    await sleep(250);
  }
  throw new Error(`Startup did not become ready: ${url}`);
}
const viteRoot = dirname(require.resolve("vite/package.json"));
const vite = launch("vite", process.execPath, [
  join(viteRoot, "bin/vite.js"),
  "--host",
  "127.0.0.1",
  "--port",
  String(rendererPort),
  "--strictPort",
]);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === "win32") {
      await new Promise((done) => {
        // PID 来自本启动器的 spawn；仅结束自己启动的测试进程树。
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("exit", done);
        killer.once("error", done);
      });
    } else child.kill("SIGTERM");
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await stop();
    process.exit(0);
  });
try {
  await waitReady(rendererUrl, vite);
  const electronRoot = dirname(require.resolve("electron/package.json"));
  const electronBinary =
    process.platform === "win32"
      ? join(electronRoot, "dist/electron.exe")
      : join(electronRoot, "dist/electron");
  const electron = launch("electron", electronBinary, [
    ".",
    `--remote-debugging-port=${cdpPort}`,
    ...(requestedWorkspace ? ["--open-workspace", requestedWorkspace] : []),
  ]);
  await waitReady(`${endpoint}/json/version`, electron);
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        runRoot,
        endpoint,
        rendererUrl,
        launcherPid: process.pid,
        electronPid: electron.pid,
        ...(requestedWorkspace ? { requestedWorkspace } : {}),
      },
      null,
      2,
    ),
  );
  console.log(`READY ${manifestPath}`);
  await new Promise((done) => electron.once("exit", done));
} finally {
  await stop();
}
