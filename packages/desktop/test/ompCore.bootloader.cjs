// 仅本次沙箱 Electron 进程：先封闭原生窗口展示，再导入真实 main/preload。
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { registerHooks, syncBuiltinESMExports } = require("node:module");
const { appendIsolationEvidence } = require("./ompCore.evidence.cjs");
const { isAbsolute, join, resolve } = require("node:path");
const { ownedHostUtilityProcess } = require("./ompInteractionQueryFault.cjs");
const { pathToFileURL } = require("node:url");
const electron = require("electron");
const { app, BrowserWindow: NativeBrowserWindow } = electron;
const root = process.env.OMP_E2E_ISOLATED_ROOT;
assert.ok(root && isAbsolute(root), "Use an absolute isolated GUI root");
const desktopRoot = resolve(__dirname, "..");
const evidencePath = join(root, "evidence", `window-isolation-${process.pid}.jsonl`);
const interactionFault =
  process.env.OMP_E2E_SUITE === "agents"
    ? ownedHostUtilityProcess(electron.utilityProcess, {
        root,
        hostPath: join(desktopRoot, "out", "host", "index.js"),
        nonce: randomUUID(),
      })
    : null;
const native = Object.fromEntries(
  ["isVisible", "isFocused", "isFocusable"].map((name) => [
    name,
    NativeBrowserWindow.prototype[name],
  ]),
);
let failure;
let previous;
let evidenceWrite = Promise.resolve();
const suppressed = {};
// 仅观察真实公开调用；不替换 bridge、结果或业务状态，也不保存参数正文。
const observations = { agentInteractionQueries: 0 };
const observedPorts = new WeakSet();
function observeQuery(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (["session/agentInteractions", "listSessionAgentInteractions"].includes(value)) return true;
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        return observeQuery(JSON.parse(value), seen);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => observeQuery(item, seen));
}
function observePacket(event, args) {
  if (observeQuery(args)) observations.agentInteractionQueries++;
  for (const port of event?.ports ?? []) {
    if (observedPorts.has(port)) continue;
    observedPorts.add(port);
    port.on("message", (message) => observePacket(message, message.data));
  }
}
const realHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (channel, listener) =>
  realHandle(channel, (event, ...args) => {
    observePacket(event, args);
    return listener(event, ...args);
  });
const realEmit = electron.ipcMain.emit;
electron.ipcMain.emit = function (channel, event, ...args) {
  observePacket(event, args);
  return realEmit.call(this, channel, event, ...args);
};

// 沙箱数据根不隔离 HKCU；测试 Main 不得覆盖用户协议处理器或 Explorer 菜单。
app.setAsDefaultProtocolClient = () => {
  suppressed.protocolRegistration = (suppressed.protocolRegistration ?? 0) + 1;
  return false;
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (/(?:^|[\\/])reg(?:\.exe)?$/iu.test(command) && args?.[0]?.toLowerCase() === "add") {
    suppressed.registryWrite = (suppressed.registryWrite ?? 0) + 1;
    throw new Error("System registry writes are outside the isolated GUI fixture");
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();

function report() {
  const windows = NativeBrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed())
    .map((win) => ({
      id: win.id,
      visible: native.isVisible.call(win),
      focused: native.isFocused.call(win),
      focusable: native.isFocusable.call(win),
    }));
  if (windows.some((win) => win.visible || win.focused || win.focusable))
    failure ??= "Native window escaped hidden/unfocused/nonfocusable isolation";
  const state = {
    electronPid: process.pid,
    mode: "hidden-native-windows",
    verified: !failure,
    checkedAt: new Date().toISOString(),
    windows,
    suppressed,
    ...(failure ? { failure } : {}),
  };
  // 事件检查同步 fail-closed；证据写入串行异步，避免每次窗口事件阻塞 main。
  evidenceWrite = evidenceWrite
    .then(() => appendIsolationEvidence(evidencePath, state))
    .catch((error) => {
      console.error(`OMP_CORE_GUI_FAILED=${error.message}`);
      app.exit(1);
    });
  const summary = JSON.stringify({ ...state, checkedAt: undefined });
  if (summary !== previous) {
    previous = summary;
    console.log(`OMP_CORE_GUI_ISOLATION=${JSON.stringify(state)}`);
  }
  if (failure) {
    console.error(`OMP_CORE_GUI_FAILED=${failure}`);
    app.exit(1);
    throw new Error(failure);
  }
  return state;
}

// 即便 product 调用 show/focus，或 CDP 请求激活，窗口也不能展示或抢前台。
for (const name of [
  "show",
  "showInactive",
  "focus",
  "moveTop",
  "restore",
  "maximize",
  "setFullScreen",
]) {
  Object.defineProperty(NativeBrowserWindow.prototype, name, {
    configurable: false,
    writable: false,
    value() {
      suppressed[name] = (suppressed[name] ?? 0) + 1;
      report();
    },
  });
}
const setFocusable = NativeBrowserWindow.prototype.setFocusable;
Object.defineProperty(NativeBrowserWindow.prototype, "setFocusable", {
  configurable: false,
  writable: false,
  value() {
    setFocusable.call(this, false);
    report();
  },
});
app.focus = () => {
  suppressed.appFocus = (suppressed.appFocus ?? 0) + 1;
  report();
};
const HiddenBrowserWindow = new Proxy(NativeBrowserWindow, {
  construct(Target, args, newTarget) {
    const win = Reflect.construct(
      Target,
      [
        {
          ...args[0],
          show: false,
          focusable: false,
          // 普通隐藏窗口没有持续可见合成面；离屏渲染让真实 DOM/动画帧运行，不展示原生窗口。
          webPreferences: {
            ...args[0]?.webPreferences,
            backgroundThrottling: false,
            offscreen: true,
          },
        },
      ],
      newTarget,
    );
    report();
    return win;
  },
});
// Electron 的原生导出是不可改写 getter；进程内模块 hook 只替换构造器，其他 API 原样转发。
const isolatedElectron = Object.create(electron);
Object.defineProperty(isolatedElectron, "BrowserWindow", { value: HiddenBrowserWindow });
if (interactionFault)
  Object.defineProperty(isolatedElectron, "utilityProcess", {
    value: interactionFault.utilityProcess,
  });
const exportKey = Symbol.for("omp-core-isolated-electron");
globalThis[exportKey] = isolatedElectron;
const electronSource = [
  'const electron = globalThis[Symbol.for("omp-core-isolated-electron")];',
  "export default electron;",
  ...Object.keys(electron).map(
    (name) => `export const ${name} = electron[${JSON.stringify(name)}];`,
  ),
].join("\n");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (["electron", "electron/main", "electron/common"].includes(specifier))
      return { url: "omp-core:electron", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "omp-core:electron")
      return { format: "module", source: electronSource, shortCircuit: true };
    return nextLoad(url, context);
  },
});

// Chromium 原生 window.open 也必须保持隐藏；保留 product 的 allow/deny 和安全选项。
app.on("web-contents-created", (_, contents) => {
  const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
  contents.setWindowOpenHandler = (handler) =>
    setWindowOpenHandler((details) => {
      const result = handler(details);
      return result.action === "allow"
        ? {
            ...result,
            overrideBrowserWindowOptions: {
              ...result.overrideBrowserWindowOptions,
              show: false,
              focusable: false,
            },
          }
        : result;
    });
  contents.setWindowOpenHandler(() => ({ action: "allow" }));
});
app.on("browser-window-created", (_, win) => {
  win.on("show", report);
  win.on("focus", report);
  win.on("ready-to-show", report);
  win.webContents.on("did-finish-load", report);
  report();
});
app.setAppPath(desktopRoot);

void (async () => {
  const captureRoute = `/capture/${randomUUID()}`;
  const observationsRoute = `/observations/${randomUUID()}`;
  const shutdownRoute = `/shutdown/${randomUUID()}`;
  const captureServer = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === shutdownRoute) {
      // 普通重启先走 Chromium 持久化/应用退出；不能把强杀前的内存存储冒充冷恢复事实。
      const sessions = new Set(
        NativeBrowserWindow.getAllWindows().map((win) => win.webContents.session),
      );
      for (const session of sessions) session.flushStorageData();
      response.writeHead(200).end();
      setImmediate(() => app.quit());
      return;
    }
    if (request.method === "GET" && request.url === observationsRoute) {
      report();
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ...observations, ...interactionFault?.observations() }));
      return;
    }
    if (request.method !== "GET" || request.url !== captureRoute) {
      response.writeHead(404).end();
      return;
    }
    try {
      report();
      const win = NativeBrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith(process.env.ELECTRON_RENDERER_URL),
      );
      assert.ok(win, "Capture this isolated Renderer only");
      const image = await win.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      report();
      response.writeHead(200, { "Content-Type": "image/png" }).end(image.toPNG());
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });
  await new Promise((done, reject) => {
    captureServer.once("error", reject);
    captureServer.listen(0, "127.0.0.1", done);
  });
  console.log(
    `OMP_CORE_GUI_SCREENSHOT_URL=http://127.0.0.1:${captureServer.address().port}${captureRoute}`,
  );
  console.log(
    `OMP_CORE_GUI_OBSERVATIONS_URL=http://127.0.0.1:${captureServer.address().port}${observationsRoute}`,
  );
  console.log(
    `OMP_CORE_GUI_SHUTDOWN_URL=http://127.0.0.1:${captureServer.address().port}${shutdownRoute}`,
  );
  // Electron ESM 必须看到同一构造器；不允许补救为已展示窗口事后 hide。
  assert.equal((await import("electron")).BrowserWindow, HiddenBrowserWindow);
  await import(pathToFileURL(join(desktopRoot, "out", "main", "index.js")).href);
  await app.whenReady();
  report();
  setInterval(report, 250).unref();
})().catch((error) => {
  failure ??= error.message;
  try {
    report();
  } catch {
    app.exit(1);
  }
});
