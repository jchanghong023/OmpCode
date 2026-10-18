// 门禁直接持有本启动器；Vite 同进程，Electron/Host/OMP 均属于本次进程树。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import {
  MOCK_MODEL_SELECTOR,
  GUI_MOCK_MODELS,
  startMockModelServer,
} from "../../omp-agent/test/fixtures/ompMockServer.mjs";
import { readIsolationEvidence, captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { prepareAcceptanceSuite } from "./ompAcceptance.fixture.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.OMP_E2E_ISOLATED_ROOT;
assert.ok(root && isAbsolute(root), "Use an absolute isolated GUI root");
const require = createRequire(join(desktopRoot, "package.json"));
const omp = process.env.OMP_RPC_BINARY_PATH;
assert.ok(omp, "Use the installed OMP binary supplied by the gate");
const startup = process.env.OMP_E2E_STARTUP === "1";
const suite = process.env.OMP_E2E_SUITE ?? (startup ? "startup" : "identity");
const phase = process.env.OMP_E2E_PHASE ?? "live";
const stageId = process.env.OMP_E2E_STAGE_ID ?? "standalone";
const log = (event) =>
  console.log(
    `[GUI] stage=${stageId} suite=${suite} phase=${phase} launcherPid=${process.pid} ${event}`,
  );
log(`fixture preparation begin evidence=${root}`);
const configRoot = join(root, "omp");
const workspace = join(root, "workspace");
await Promise.all(
  ["omp/agent", "workspace", "home/.claude", "userData", "sessionData", "evidence"].map((name) =>
    mkdir(join(root, name), { recursive: true }),
  ),
);
const acceptance = await prepareAcceptanceSuite({ suite, phase, root, workspace, configRoot });
log(`fixture preparation complete evidence=${root}`);
log("model preparation begin");
const mock = await startMockModelServer({
  handler: acceptance.handler,
  ...(!["startup", "identity"].includes(suite) ? { models: GUI_MOCK_MODELS } : {}),
});
await mock.writeConfig(configRoot, {
  defaultModel: startup ? "zcode-missing/absent-model" : MOCK_MODEL_SELECTOR,
  preserveConfig: phase !== "live",
});
if (suite === "models")
  await mock.writeConfig(configRoot, { profile: "acceptance", preserveConfig: phase !== "live" });
await acceptance.prepare?.(mock);
log("model preparation complete");
log("diagnostics startup begin");
// 诊断只暴露测试自有 HTTP 事实；控制端点只能推进模拟模型，不能代执行产品动作。
const diagnostics = createHttpServer(async (request, response) => {
  try {
    mock.assertHealthy();
    if (request.method === "POST" && request.url === "/control") {
      assert.equal(typeof acceptance.control, "function", "This suite has no model controls");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await acceptance.control(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result ?? { released: true }));
    } else if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          baseUrl: mock.baseUrl,
          calls: mock.requests,
          acceptance: acceptance.snapshot?.() ?? {},
        }),
      );
    } else {
      response.writeHead(404).end("Unknown fixture diagnostics route");
    }
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message, calls: mock.requests }));
  }
});
await new Promise((done) => diagnostics.listen(0, "127.0.0.1", done));
const mockDiagnosticsUrl = `http://127.0.0.1:${diagnostics.address().port}/`;
log("diagnostics startup complete");
log("Vite startup begin");
process.chdir(desktopRoot);
process.env.ZCODE_ENV = "test";
// Chromium 按 origin 隔离草稿；冷启动仍须访问 live 相位的同一存储域。
const rendererOriginFile = join(root, "evidence", "renderer-origin.json");
const rendererPort =
  phase === "live"
    ? 0
    : Number(new URL(JSON.parse(await readFile(rendererOriginFile, "utf8")).origin).port);
const vite = await createServer({
  // 沙箱数据独立，但编译缓存按固定 fixture 角色复用，启动/identity 不并发改写同一缓存。
  cacheDir: join(desktopRoot, "node_modules/.vite/omp-core", suite),
  // Worker 动态发现会在准备完成后触发整页 reload，打断真实菜单操作；提前加入现有优化器。
  optimizeDeps: { include: ["@pierre/diffs/worker/worker.js"] },
  server: { host: "127.0.0.1", port: rendererPort, strictPort: true },
});
await vite.listen();
const rendererUrl = vite.resolvedUrls.local[0];
await writeFile(rendererOriginFile, JSON.stringify({ origin: new URL(rendererUrl).origin }));
log("Vite startup complete");
// 只删密钥无法阻止 broker 启动请求、settings 叠加与 Claude 配置读取；先剥离继承入口和大小写别名。
const inheritedEnv = { ...process.env };
for (const key of Object.keys(inheritedEnv)) {
  if (
    /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(key) ||
    /^(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL$/iu.test(key) ||
    /^(?:OMP_E2E_MODEL_SELECTOR|OMP_AUTH_BROKER_.+|PI_CONFIG_FILES|CLAUDE_CONFIG_DIR|OMP_OFFLINE|HOME|USERPROFILE|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|OMP_RPC_ARGS_JSON|OMP_SKILLS_DIR|OMP_WIKI_DIR)$/iu.test(
      key,
    )
  )
    delete inheritedEnv[key];
}
const suiteEnv = {};
for (const [key, value] of Object.entries(acceptance.env ?? {})) {
  assert.ok(["OMP_SKILLS_DIR", "OMP_WIKI_DIR"].includes(key), `Forbidden suite env: ${key}`);
  const local = relative(root, value);
  assert.ok(
    isAbsolute(value) && local && !local.startsWith("..") && !isAbsolute(local),
    `${key} must be an input directory owned by this fixture`,
  );
  suiteEnv[key] = value;
}
const env = {
  ...inheritedEnv,
  ...suiteEnv,
  // 从不读取用户认证库；模型 provider 的假密钥只存在于隔离 models.yml。
  OMP_E2E_ISOLATED_ROOT: root,
  OMP_E2E_SUITE: suite,
  OMP_E2E_INTERACTION_FAULT_NONCE: "",
  ZCODE_ENV: "test",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DESKTOP_APPLICATION_NAME: "OmpCode Core Acceptance",
  OMP_CONFIG_ROOT: configRoot,
  OMP_PROFILE: "",
  PI_PROFILE: "",
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
    ...(acceptance.rpcArgs?.includes("--extension") ? [] : ["--no-extensions"]),
    "--no-rules",
    "--no-lsp",
    "--no-pty",
    "--approval-mode",
    "yolo",
    ...(acceptance.rpcArgs ?? []),
  ]),
};
delete env.ELECTRON_RUN_AS_NODE;
log("Electron startup begin");
const electron = spawn(
  require("electron"),
  [
    fileURLToPath(new URL("./ompCore.bootloader.cjs", import.meta.url)),
    "--remote-debugging-port=0",
    ...(!startup ? ["--open-workspace", workspace] : []),
  ],
  { cwd: desktopRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
log(`Electron startup complete electronPid=${electron.pid ?? "unavailable"}`);
log("CDP readiness begin");
electron.stdout.pipe(createWriteStream(join(root, "electron-stdout.log"), { flags: "a" }));
let screenshotUrl;
let observationsUrl;
let shutdownUrl;
createInterface({ input: electron.stdout }).on("line", (line) => {
  if (line.startsWith("OMP_CORE_GUI_ISOLATION=")) console.log(line);
  if (line.startsWith("OMP_CORE_GUI_SCREENSHOT_URL="))
    screenshotUrl = line.slice("OMP_CORE_GUI_SCREENSHOT_URL=".length);
  if (line.startsWith("OMP_CORE_GUI_OBSERVATIONS_URL="))
    observationsUrl = line.slice("OMP_CORE_GUI_OBSERVATIONS_URL=".length);
  if (line.startsWith("OMP_CORE_GUI_SHUTDOWN_URL="))
    shutdownUrl = line.slice("OMP_CORE_GUI_SHUTDOWN_URL=".length);
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
  log(`CDP readiness complete electronPid=${electron.pid}`);
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
  log(`renderer target readiness begin electronPid=${electron.pid}`);
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
  log(`renderer target readiness complete electronPid=${electron.pid}`);
  log("CDP connection begin");
  const browser = await chromium.connectOverCDP(endpoint);
  log("CDP connection complete");
  try {
    const page = browser
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().startsWith(rendererUrl));
    assert.ok(page, "Use the renderer of this isolated launch only");
    // 准备属于外层门禁计费，不另加 Playwright 默认的 30 秒阶段截止。
    page.setDefaultTimeout(0);
    if (suite === "agents") {
      // Install before application timers in the replacement document. Time runs normally
      // until the interaction Retry case pauses it; no production polling switch is added.
      await page.clock.install();
      await page.reload();
    }
    await isolationState();
    log("onboarding readiness begin");
    const onboarding = page.getByTestId("onboarding-page");
    const settings = page.getByRole("button", { name: "设置", exact: true }).last();
    await onboarding.or(settings).first().waitFor({ state: "visible" });
    // 新沙箱会显示职业引导；只走真实三步跳过，不注入 store 或伪造已完成记录。
    if (await onboarding.isVisible()) {
      log("onboarding completion begin");
      await captureIsolationScreenshot(
        join(root, "evidence", `onboarding-${electron.pid}.png`),
        screenshotUrl,
      );
      for (let step = 0; step < 3; step++)
        await onboarding.getByRole("button", { name: "跳过", exact: true }).click();
      await onboarding.waitFor({ state: "hidden" });
      log("onboarding completion complete");
    }
    log("onboarding readiness complete");
    log("renderer settings readiness begin");
    await settings.waitFor({ state: "visible" });
    log("renderer settings readiness complete");
    log("readiness screenshot begin");
    await captureIsolationScreenshot(
      join(root, "evidence", `ready-${electron.pid}.png`),
      screenshotUrl,
    );
    log("readiness screenshot complete");
  } finally {
    await browser.close();
  }
  log("runtime evidence publication begin");
  const isolation = await isolationState();
  const metadata = {
    stageId,
    runRoot: root,
    suite,
    phase,
    configRoot,
    ompBinary: omp,
    profile: suite === "models" && phase === "profile" ? "acceptance" : "",
    acceptance: acceptance.manifest ?? {},
    observationsUrl,
    shutdownUrl,
    interactionQueryClock: suite === "agents",
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
      controlUrl: `${mockDiagnosticsUrl}control`,
      models: mock.models,
    },
  };
  await writeFile(join(root, "runtime.json"), JSON.stringify(metadata, null, 2));
  log(`runtime evidence publication complete electronPid=${electron.pid} evidence=${root}`);
  console.log(`OMP_CORE_GUI_READY=${JSON.stringify(metadata)}`);
}
electron.once("error", (error) => {
  console.log(`OMP_CORE_GUI_FAILED=Electron failed to start: ${error.message}`);
  process.exitCode = 1;
});
electron.once("exit", (code, signal) => {
  log(`Electron exited electronPid=${electron.pid} exitCode=${code} signal=${signal}`);
  // The gate detaches its failure watcher before requesting an owned shutdown.
  console.log(`OMP_CORE_GUI_EXITED=Electron exited: code=${code} signal=${signal}`);
});
try {
  await new Promise((done) => electron.once("close", done));
  mock.assertHealthy();
} finally {
  log(`launcher shutdown begin evidence=${root}`);
  diagnostics.closeAllConnections();
  await Promise.all([vite.close(), mock.close(), new Promise((done) => diagnostics.close(done))]);
  log(`launcher shutdown complete evidence=${root}`);
}
process.exitCode = electron.exitCode ?? 1;
