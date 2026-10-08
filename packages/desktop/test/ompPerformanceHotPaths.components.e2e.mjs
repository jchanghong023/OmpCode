// 独立 Electron 真实组件验收，不调用模型；完整桌面链路另由 gui.e2e 覆盖。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { runComponentAssertions } from "./ompPerformanceHotPaths.componentAssertions.mjs";
import tailwindcss from "@tailwindcss/vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const require = createRequire(join(desktopRoot, "package.json"));
const runRoot = await mkdtemp(join(tmpdir(), "ompcode-components-hotpaths-"));
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR ?? join(runRoot, "evidence");
const cdpPort = Number(process.env.OMP_COMPONENT_CDP_PORT ?? 9247);
const rendererPort = Number(process.env.OMP_COMPONENT_RENDERER_PORT ?? 5207);
assert.ok(![9229, 9230].includes(cdpPort));
const endpoint = `http://127.0.0.1:${cdpPort}`;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
await mkdir(evidenceDir, { recursive: true });
for (const url of [rendererUrl, `${endpoint}/json/version`]) {
  const alive = await fetch(url, { signal: AbortSignal.timeout(500) })
    .then(() => true)
    .catch(() => false);
  assert.equal(alive, false, `Refuse existing listener ${url}`);
}
await writeFile(
  join(runRoot, "index.html"),
  `<!doctype html><html><body class="bg-background text-foreground" style="background:var(--color-background);color:var(--color-foreground)"><div id="root"></div><script type="module" src="/@fs/${repoRoot.replaceAll("\\", "/")}/packages/desktop/test/ompPerformanceHotPaths.fixture.jsx"></script></body></html>`,
);
const aliases = Object.fromEntries(
  ["react", "react-dom", "lucide-react"].map((name) => [
    name,
    dirname(require.resolve(`${name}/package.json`)),
  ]),
);
const vite = await createServer({
  configFile: false,
  root: runRoot,
  cacheDir: join(runRoot, "vite-cache"),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { exclude: ["@pierre/diffs/worker/worker.js"] },
  resolve: {
    alias: { "@": join(repoRoot, "packages/ui/src"), ...aliases },
    dedupe: Object.keys(aliases),
  },
  server: {
    host: "127.0.0.1",
    port: rendererPort,
    strictPort: true,
    fs: { allow: [repoRoot, runRoot] },
  },
  define: {
    __OMPCODE_CENTOS7_DESKTOP__: "false",
    __ZCODE_VERSION__: '"e2e"',
    __ZCODE_COMMIT__: '"e2e"',
    __ZCODE_BUILD_TIME__: '"e2e"',
    __ZCODE_ENV__: '"test"',
    __ZCODE_PRODUCT_FLAVOR__: '"test"',
    __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: "true",
  },
});
await vite.listen();
await writeFile(
  join(runRoot, "main.cjs"),
  `const {app,BrowserWindow}=require("electron");
app.setPath("userData",${JSON.stringify(join(runRoot, "userData"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{backgroundThrottling:false}}); await win.loadURL(${JSON.stringify(rendererUrl)}); win.showInactive();});
app.on("window-all-closed",()=>app.quit());`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(
  require("electron"),
  [join(runRoot, "main.cjs"), `--remote-debugging-port=${cdpPort}`],
  {
    cwd: desktopRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let processLog = "";
electron.stdout.on("data", (data) => {
  processLog += data;
});
electron.stderr.on("data", (data) => {
  processLog += data;
});
let browser;
const evidence = [];
const phase = process.env.OMP_COMPONENT_PHASE ?? "complete";
assert.ok(["complete", "visual"].includes(phase));
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (electron.exitCode !== null) throw new Error(`Electron exited: ${processLog}`);
    if (
      await fetch(`${endpoint}/json/version`)
        .then((res) => res.ok)
        .catch(() => false)
    )
      break;
    await sleep(250);
  }
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser
    .contexts()[0]
    .pages()
    .find((item) => item.url().startsWith(rendererUrl));
  assert.ok(page);
  page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => window.performanceFixture);
  await page.waitForFunction(() =>
    window.performanceFixture.status().content.includes("const value = 1;"),
  );
  await runComponentAssertions(page, evidenceDir, evidence, { skipComposer: phase === "visual" });
  await writeFile(
    join(
      evidenceDir,
      phase === "complete" ? "components-result.json" : "components-visual-result.json",
    ),
    JSON.stringify({ kind: "component-GUI", phase, runRoot, evidence }, null, 2),
  );
  console.log(`PASS component GUI: ${evidenceDir}`);
} catch (error) {
  if (browser) {
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((item) => item.url().startsWith(rendererUrl));
    await page
      ?.screenshot({ path: join(evidenceDir, "components-failure.png"), animations: "disabled" })
      .catch(() => {});
    const status = await page
      ?.evaluate(() => ({
        errors: window.performanceFixture?.status().errors,
        timeline: window.performanceFixture?.timeline(),
        composer: window.performanceFixture?.composer(),
        editorText: document
          .querySelector('[data-testid="v4-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText(),
        body: document.body.innerText,
      }))
      .catch(() => null);
    await writeFile(
      join(evidenceDir, "components-failure.json"),
      JSON.stringify({ message: error.message, evidence, status }, null, 2),
    );
  }
  throw error;
} finally {
  await writeFile(join(evidenceDir, "components-process.log"), processLog);
  await browser?.close();
  // 仅清理本脚本启动的 Electron PID；隔离目录保留截图与重跑证据。
  if (electron.exitCode === null && electron.pid) {
    if (process.platform === "win32") {
      await new Promise((done) => {
        const child = spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("exit", done);
        child.once("error", done);
      });
    } else electron.kill("SIGTERM");
  }
  await vite.close();
}
