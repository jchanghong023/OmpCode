// 门禁直接持有本启动器；Vite 同进程，Electron/Host/OMP 均属于本次进程树。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import {
  MOCK_MODEL_SELECTOR,
  startMockModelServer,
} from "../../omp-agent/test/fixtures/ompMockServer.mjs";
import { readIsolationEvidence, captureIsolationScreenshot } from "./ompCore.evidence.cjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.OMP_E2E_ISOLATED_ROOT;
assert.ok(root && isAbsolute(root), "Use an absolute isolated GUI root");
const require = createRequire(join(desktopRoot, "package.json"));
const omp = process.env.OMP_RPC_BINARY_PATH;
assert.ok(omp, "Use the installed OMP binary supplied by the gate");
const configRoot = join(root, "omp");
const workspace = join(root, "workspace");
await Promise.all(
  ["omp/agent", "workspace", "home/.claude", "userData", "sessionData", "evidence"].map((name) =>
    mkdir(join(root, name), { recursive: true }),
  ),
);
const startup = process.env.OMP_E2E_STARTUP === "1";
// 目录外默认值只用于设置页；其余角色（包括真实子代理）全部由本地 fixture 配置。
const mock = await startMockModelServer();
await mock.writeConfig(configRoot, {
  defaultModel: startup ? "zcode-missing/absent-model" : MOCK_MODEL_SELECTOR,
});
// 仅发布无认证头的请求体和健康状态，供独立 CDP 驱动进程关联实际工具/子代理请求。
const requestEvidence = () => mock.calls.map(({ context }) => ({ messages: context.messages }));
const diagnostics = createHttpServer((_request, response) => {
  try {
    mock.assertHealthy();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ baseUrl: mock.baseUrl, calls: requestEvidence() }));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message, calls: requestEvidence() }));
  }
});
await new Promise((done) => diagnostics.listen(0, "127.0.0.1", done));
const mockDiagnosticsUrl = `http://127.0.0.1:${diagnostics.address().port}/`;
process.chdir(desktopRoot);
process.env.ZCODE_ENV = "test";
const vite = await createServer({
  // 沙箱数据独立，但编译缓存按固定 fixture 角色复用，启动/identity 不并发改写同一缓存。
  cacheDir: join(desktopRoot, "node_modules/.vite/omp-core", startup ? "startup" : "identity"),
  // Worker 动态发现会在准备完成后触发整页 reload，打断真实菜单操作；提前加入现有优化器。
  optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
  server: { host: "127.0.0.1", port: 0, strictPort: true },
});
await vite.listen();
const rendererUrl = vite.resolvedUrls.local[0];
// 只删密钥无法阻止 broker 启动请求、settings 叠加与 Claude 配置读取；先剥离继承入口和大小写别名。
const inheritedEnv = { ...process.env };
for (const key of Object.keys(inheritedEnv)) {
  if (
    /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(key) ||
    /^(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL$/iu.test(key) ||
    /^(?:OMP_E2E_MODEL_SELECTOR|OMP_AUTH_BROKER_.+|PI_CONFIG_FILES|CLAUDE_CONFIG_DIR|OMP_OFFLINE|HOME|USERPROFILE|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|OMP_RPC_ARGS_JSON)$/iu.test(
      key,
    )
  )
    delete inheritedEnv[key];
}
const env = {
  ...inheritedEnv,
  // 从不读取用户认证库；模型 provider 的假密钥只存在于隔离 models.yml。
  ZCODE_ENV: "test",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DESKTOP_APPLICATION_NAME: "OmpCode Core Acceptance",
  OMP_CONFIG_ROOT: configRoot,
  OMP_PROFILE: "",
  PI_PROFILE: "",
  OMPCODE_CENTOS7_PROFILE: "",
  PI_CONFIG_DIR: "",
  PI_CODING_AGENT_DIR: "",
  PI_CONFIG_FILES: "",
  OMP_OFFLINE: "",
  CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  ZCODE_DATA_BASE_DIR: join(root, "data"),
  ZCODE_DESKTOP_HOME_DIR: join(root, "home"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(root, "userData"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(root, "sessionData"),
  ELECTRON_RENDERER_URL: rendererUrl,
  OMP_RPC_ARGS_JSON: JSON.stringify([
    "--no-title",
    "--no-extensions",
    "--no-rules",
    "--no-lsp",
    "--no-pty",
    "--approval-mode",
    "always-ask",
  ]),
};
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(
  require("electron"),
  [
    fileURLToPath(new URL("./ompCore.bootloader.cjs", import.meta.url)),
    "--remote-debugging-port=0",
    ...(!startup ? ["--open-workspace", workspace] : []),
  ],
  { cwd: desktopRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
electron.stdout.pipe(createWriteStream(join(root, "electron-stdout.log"), { flags: "a" }));
let screenshotUrl;
createInterface({ input: electron.stdout }).on("line", (line) => {
  if (line.startsWith("OMP_CORE_GUI_ISOLATION=")) console.log(line);
  if (line.startsWith("OMP_CORE_GUI_SCREENSHOT_URL="))
    screenshotUrl = line.slice("OMP_CORE_GUI_SCREENSHOT_URL=".length);
});
const stderr = createWriteStream(join(root, "electron-stderr.log"), { flags: "a" });
electron.stderr.pipe(stderr);
let announced = false;
let tail = "";
electron.stderr.setEncoding("utf8");
electron.stderr.on("data", (data) => {
  tail = (tail + data).slice(-4096);
  const match = tail.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//u);
  if (!match || announced) return;
  announced = true;
  void prepareRuntime(`http://${match[1]}`).catch((error) => {
    // 准备失败时保持启动器存活，让门禁清理完整树，不能先退出而遗留 Electron/Host。
    console.log(`OMP_CORE_GUI_FAILED=${error.message}`);
  });
});

async function isolationState() {
  const isolation = await readIsolationEvidence(
    join(root, "evidence", `window-isolation-${electron.pid}.jsonl`),
  );
  assert.equal(isolation.electronPid, electron.pid, "Verify this Electron process only");
  assert.equal(isolation.mode, "hidden-native-windows");
  assert.equal(isolation.verified, true, isolation.failure ?? "Native isolation must be verified");
  assert.ok(isolation.windows.length, "Verify every actual native window, not an empty report");
  for (const win of isolation.windows) {
    assert.equal(win.visible, false, `Native window ${win.id} must stay hidden`);
    assert.equal(win.focused, false, `Native window ${win.id} must not hold foreground focus`);
    assert.equal(win.focusable, false, `Native window ${win.id} must not be focusable`);
  }
  return isolation;
}

async function prepareRuntime(endpoint) {
  // CDP 监听早于窗口；必须等到当前 renderer 出现，不能按监听日志假定 UI 就绪。
  while (electron.exitCode === null) {
    const targets = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) })
      .then((response) => response.json())
      .catch(() => []);
    if (targets.some((target) => target.type === "page" && target.url.startsWith(rendererUrl)))
      break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(electron.exitCode, null, "Electron must survive until the renderer is ready");
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = browser
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().startsWith(rendererUrl));
    assert.ok(page, "Use the renderer of this isolated launch only");
    // 准备属于外层门禁计费，不另加 Playwright 默认的 30 秒阶段截止。
    page.setDefaultTimeout(0);
    await isolationState();
    const onboarding = page.getByTestId("onboarding-page");
    const settings = page.getByRole("button", { name: "设置", exact: true }).last();
    await onboarding.or(settings).first().waitFor({ state: "visible" });
    // 新沙箱会显示职业引导；只走真实三步跳过，不注入 store 或伪造已完成记录。
    if (await onboarding.isVisible()) {
      await captureIsolationScreenshot(
        join(root, "evidence", `onboarding-${electron.pid}.png`),
        screenshotUrl,
      );
      for (let step = 0; step < 3; step++)
        await onboarding.getByRole("button", { name: "跳过", exact: true }).click();
      await onboarding.waitFor({ state: "hidden" });
    }
    await settings.waitFor({ state: "visible" });
    await captureIsolationScreenshot(
      join(root, "evidence", `ready-${electron.pid}.png`),
      screenshotUrl,
    );
  } finally {
    await browser.close();
  }
  const isolation = await isolationState();
  const metadata = {
    runRoot: root,
    endpoint,
    rendererUrl,
    screenshotUrl,
    launcherPid: process.pid,
    electronPid: electron.pid,
    requestedWorkspace: workspace,
    isolation,
    isolationEvidence: join(root, "evidence", `window-isolation-${electron.pid}.jsonl`),
    mock: {
      baseUrl: mock.baseUrl,
      modelSelector: MOCK_MODEL_SELECTOR,
      diagnosticsUrl: mockDiagnosticsUrl,
    },
  };
  await writeFile(join(root, "runtime.json"), JSON.stringify(metadata, null, 2));
  console.log(`OMP_CORE_GUI_READY=${JSON.stringify(metadata)}`);
}
electron.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
try {
  await new Promise((done) => electron.once("close", done));
  mock.assertHealthy();
} finally {
  diagnostics.closeAllConnections();
  await Promise.all([vite.close(), mock.close(), new Promise((done) => diagnostics.close(done))]);
}
process.exitCode = electron.exitCode ?? 1;
