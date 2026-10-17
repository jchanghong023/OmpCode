// Component behavior only, not real Main/Preload, OMP, model, or CentOS acceptance.
// The gate owns the total deadline; this runner adds no competing early-stop timer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { behaviorAssertions, presentationAssertions } from "./ompProductTools.assertions.mjs";
import { admissionAssertions } from "./ompNativeTools.assertions.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const require = createRequire(join(desktopRoot, "package.json"));
const runRoot = await mkdtemp(join(tmpdir(), "omp-product-tools-"));
const evidenceRoot = join(runRoot, "evidence");
const aliases = Object.fromEntries(
  ["react", "react-dom", "lucide-react"].map((name) => [
    name,
    dirname(require.resolve(`${name}/package.json`)),
  ]),
);

async function nativeAssertions(locale) {
  const f = window.productToolsFixture;
  const check = (value, label) => {
    if (!value) throw new Error(label);
  };
  const tick = () =>
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const index = () => document.getElementById("index-panel");
  const orchestration = () => document.getElementById("orchestration-panel");
  const forceSubmit = (form) =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  f.reset(locale);
  f.mount("native", "native", false);
  await tick();
  check(
    [...index().querySelectorAll("button")].every((button) => button.disabled),
    "missing catalog allows index execution",
  );
  check(
    index().querySelector("textarea").disabled,
    "missing repo capability permits model query input",
  );
  forceSubmit(index().querySelector("form"));
  forceSubmit(orchestration().querySelector("form"));
  await tick();
  check(f.executions.length === 0, "missing catalog submitted through DOM form events");
  f.unmount();
  f.mount("native", "native", true);
  await tick();
  check(index().querySelector('button[type="submit"]').disabled, "empty code query is executable");
  check(
    orchestration().querySelector('button[type="submit"]').disabled,
    "empty goal objective is executable",
  );
  forceSubmit(index().querySelector("form"));
  forceSubmit(orchestration().querySelector("form"));
  await tick();
  check(f.executions.length === 0, "empty parameters passed DOM submission guards");
  const action = orchestration().querySelectorAll('[role="combobox"]')[1];
  action.click();
  await tick();
  const drop = [...document.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent === (locale === "zh-CN" ? "删除目标" : "Drop goal"),
  );
  check(drop, "destructive goal action missing from actual select");
  drop.click();
  await tick();
  const confirmation = orchestration().querySelector('[role="checkbox"]');
  check(
    confirmation && confirmation.getAttribute("aria-checked") === "false",
    "destructive confirmation not initially unchecked",
  );
  check(
    orchestration().querySelector("pre").textContent === "/goal drop",
    "drop command preview incorrect",
  );
  forceSubmit(orchestration().querySelector("form"));
  await tick();
  check(f.executions.length === 0, "destructive action submitted without confirmation");
  confirmation.click();
  await tick();
  check(
    !orchestration().querySelector('button[type="submit"]').disabled,
    "explicit confirmation did not admit drop",
  );
  orchestration().querySelector('button[type="submit"]').click();
  await tick();
  check(
    f.executions.length === 1 && f.executions[0] === "/goal drop",
    "confirmed DOM action did not submit the exact command once",
  );
  check(
    orchestration().querySelector('[role="checkbox"]').getAttribute("aria-checked") === "false",
    "destructive confirmation survived submission",
  );
  f.unmount();
  return `PASS ${locale}: native DOM admission and destructive confirmation (component boundary only)`;
}

let vite;
let electron;
let stopping;
async function stopElectron() {
  if (!electron?.pid || electron.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const killer = spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", done);
      killer.once("close", done);
    });
  } else electron.kill("SIGKILL");
}
async function cleanup() {
  if (stopping) return stopping;
  stopping = (async () => {
    await stopElectron();
    await vite?.close();
    for (const name of ["main.cjs", "index.html", "userData", "vite-cache"]) {
      await rm(join(runRoot, name), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  })();
  return stopping;
}
const interrupt = () => {
  void cleanup().finally(() => process.exit(1));
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  await mkdir(evidenceRoot);
  await writeFile(
    join(runRoot, "index.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${repoRoot.replaceAll("\\", "/")}/packages/desktop/test/ompProductTools.fixture.tsx"></script></body></html>`,
  );
  vite = await createServer({
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
      watch: { ignored: ["**/userData/**", "**/evidence/**"] },
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
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const mainPath = join(runRoot, "main.cjs");
  await writeFile(
    mainPath,
    `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
app.setPath("userData", ${JSON.stringify(join(runRoot, "userData"))});
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,focusable:false,skipTaskbar:true,x:-20000,y:-20000,width:1100,height:1100,webPreferences:{offscreen:true,backgroundThrottling:false}});
 win.webContents.setWindowOpenHandler(() => ({action:"deny"}));
 win.webContents.on("will-navigate", (event,url) => {if(!url.startsWith("http://127.0.0.1:${address.port}/"))event.preventDefault();});
 try {
  await win.loadURL("http://127.0.0.1:${address.port}/");
  let loaded = false;
  for(let i=0;i<200;i++){if(await win.webContents.executeJavaScript("Boolean(window.productToolsFixture)")){loaded=true;break;}await new Promise(r=>setTimeout(r,50));}
  if(!loaded)throw new Error("Product tools fixture failed to mount");
  win.webContents.debugger.attach("1.3");
  console.log(await win.webContents.executeJavaScript(${JSON.stringify(`(${behaviorAssertions.toString()})()`)}));
  console.log(await win.webContents.executeJavaScript(${JSON.stringify(`(${admissionAssertions.toString()})()`)}));
  if(win.isVisible()||win.isFocused()||win.isFocusable())throw new Error("Admission fixture window became visible/focusable");
  const admissionImage=await win.webContents.capturePage();
  if(admissionImage.isEmpty())throw new Error("Empty admission offscreen capture");
  await fs.writeFile(${JSON.stringify(join(evidenceRoot, "native-admission.png"))},admissionImage.toPNG());
  for(const locale of ["en-US","zh-CN"]) {
   console.log(await win.webContents.executeJavaScript('('+${JSON.stringify(nativeAssertions.toString())}+')('+JSON.stringify(locale)+')'));
   for(const theme of ["light","dark"])for(const width of [1100,360]) {
    win.setContentSize(width,1100);
    // 隐藏的 Windows 窗口尺寸回报可能滞后；等待 Chromium 确认 CSS 视口，不放宽宽度断言。
    await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride",{width,height:1100,deviceScaleFactor:1,mobile:false});
    const viewportWidth=await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.innerWidth))))");
    if(viewportWidth!==width)throw new Error("Incorrect component viewport width: expected "+width+", actual "+viewportWidth);
    console.log(await win.webContents.executeJavaScript('('+${JSON.stringify(presentationAssertions.toString())}+')('+JSON.stringify(locale)+','+JSON.stringify(theme)+')'));
    if(win.isVisible()||win.isFocused()||win.isFocusable())throw new Error("Fixture window became visible/focusable");
    const image=await win.webContents.capturePage();
    if(image.isEmpty())throw new Error("Empty offscreen capture");
    await fs.writeFile(${JSON.stringify(evidenceRoot)}+'/'+locale+'-'+theme+'-'+width+'.png',image.toPNG());
   }
  }
  win.destroy();app.exit(0);
 } catch(error) {
  console.error(error.stack);
  try{await fs.writeFile(${JSON.stringify(join(evidenceRoot, "failure.png"))},(await win.webContents.capturePage()).toPNG());}catch{}
  win.destroy();app.exit(1);
 }
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
  const code = await new Promise((done, reject) => {
    electron.once("error", reject);
    electron.once("close", done);
  });
  assert.equal(code, 0, "isolated product tools component regression failed");
  console.log(`Evidence: ${evidenceRoot}`);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await cleanup();
}
