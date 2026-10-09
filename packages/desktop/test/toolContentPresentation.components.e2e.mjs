// 专用 Electron + 临时 Vite/userData；不连接日常实例、不调用模型，限时 60 秒。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const require = createRequire(join(desktopRoot, "package.json"));
const runRoot = await mkdtemp(join(tmpdir(), "ompcode-tool-presentation-"));
const aliases = Object.fromEntries(
  ["react", "react-dom", "lucide-react"].map((name) => [
    name,
    dirname(require.resolve(`${name}/package.json`)),
  ]),
);
await writeFile(
  join(runRoot, "index.html"),
  `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${repoRoot.replaceAll("\\", "/")}/packages/desktop/test/toolContentPresentation.fixture.jsx"></script></body></html>`,
);
const vite = await createServer({
  configFile: false,
  root: runRoot,
  cacheDir: join(runRoot, "vite-cache"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": join(repoRoot, "packages/ui/src"), ...aliases },
    dedupe: Object.keys(aliases),
  },
  server: {
    host: "127.0.0.1",
    port: 0,
    watch: { ignored: ["**/userData/**"] },
    fs: { allow: [repoRoot, runRoot] },
  },
  define: {
    __OMPCODE_CENTOS7_DESKTOP__: "false",
    __ZCODE_VERSION__: '"fixture"',
    __ZCODE_COMMIT__: '"fixture"',
    __ZCODE_BUILD_TIME__: '"fixture"',
    __ZCODE_ENV__: '"test"',
    __ZCODE_PRODUCT_FLAVOR__: '"test"',
    __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: "true",
  },
});

async function assertions() {
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const section = (id) => document.getElementById(id);
  const tick = () =>
    new Promise((resolveTick) => requestAnimationFrame(() => requestAnimationFrame(resolveTick)));
  // 真实代码组件异步挂载至 shadow DOM，不能用 SSR 代替读取结果的验收。
  const codeText = (id) =>
    Array.from(section(id).querySelectorAll("diffs-container"))
      .map((el) => el.shadowRoot?.textContent ?? el.textContent)
      .join(" ");
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(label);
  };
  check(section("empty").textContent === "", "empty parameters rendered");
  check(section("zero").textContent.includes("0"), "zero result missing");
  check(section("false").textContent.includes("false"), "false result missing");
  check(section("plain").textContent.includes("first\n"), "plain text newlines lost");
  check(!section("plain").querySelector('[data-language="json"]'), "plain text rendered as JSON");
  check(!section("wait").textContent.includes("调用参数"), "empty wait parameters rendered");
  check(!section("wait").textContent.includes("raw-only-marker"), "raw visible initially");
  const raw = Array.from(section("wait").querySelectorAll("button")).find((el) =>
    el.textContent.includes("查看原始数据"),
  );
  raw.focus();
  check(document.activeElement === raw, "raw toggle is not focusable");
  raw.click();
  await tick();
  check(raw.getAttribute("aria-expanded") === "true", "raw toggle not expanded");
  check(section("wait").textContent.includes("raw-only-marker"), "raw data lost");
  raw.click();
  await tick();
  check(raw.getAttribute("aria-expanded") === "false", "raw toggle not collapsed");
  check(!section("mcp-empty").textContent.includes("查看调用详情"), "empty MCP details rendered");
  const details = Array.from(section("mcp-params").querySelectorAll("button")).find((el) =>
    el.textContent.includes("查看调用详情"),
  );
  check(Boolean(details), "MCP parameters entry missing");
  if (details.getAttribute("aria-expanded") !== "true") details.click();
  await tick();
  await waitFor(() => codeText("mcp-params").includes("task-123"), "MCP parameter content missing");
  await waitFor(() => codeText("json").includes('"value"'), "JSON content missing");
  check(
    section("markdown").querySelector("h2")?.textContent === "Completed (1)",
    "Markdown heading missing",
  );
  await waitFor(
    () => codeText("markdown").includes("<task-result>hello</task-result>"),
    "Markdown code content lost",
  );
  check(section("plan-error").textContent.includes("visible-plan-error"), "plan error hidden");
  check(
    !section("plan-error").textContent.includes("hidden-guidance"),
    "failed guidance hides error",
  );
  const plain = section("plain").querySelector(".whitespace-pre-wrap");
  check(plain.scrollWidth <= plain.clientWidth + 1, "plain text overflows narrow layout");
  return "PASS";
}

let electron;
try {
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const mainPath = join(runRoot, "main.cjs");
  await writeFile(
    mainPath,
    `
const {app,BrowserWindow}=require("electron");
const fs=require("node:fs/promises");
app.setPath("userData",${JSON.stringify(join(runRoot, "userData"))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false}});
 try {
  await win.loadURL("http://127.0.0.1:${address.port}");
  for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript("typeof window.renderToolFixture === 'function'"))break;await new Promise(r=>setTimeout(r,100));}
  for(const theme of ["light","dark"])for(const width of [1100,360]){
   win.setSize(width,900);
   await win.webContents.executeJavaScript('window.renderToolFixture('+JSON.stringify(theme)+')');
   await win.webContents.executeJavaScript(${JSON.stringify(`(${assertions.toString()})()`)});
   await fs.writeFile(${JSON.stringify(runRoot)}+'/'+theme+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
   console.log('PASS '+theme+' '+width);
  }
  app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}
});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = spawn(require("electron"), [mainPath], {
    cwd: desktopRoot,
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  const timer = setTimeout(() => {
    console.error("TIMEOUT: tool presentation component E2E exceeded 60 seconds");
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], { windowsHide: true });
    else electron.kill("SIGKILL");
  }, 60000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      electron.once("error", reject);
      electron.once("exit", resolveExit);
    });
    assert.equal(code, 0, "isolated component E2E failed");
    console.log(`Evidence: ${runRoot}`);
  } finally {
    clearTimeout(timer);
  }
} finally {
  await vite.close();
}
