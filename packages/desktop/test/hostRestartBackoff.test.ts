import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// 纯 Node 测试进程无法加载 electron（包内 "type":"module" 使命名导入在链接期直接
// 失败，且传递依赖存在导入期副作用）。这里用模块钩子把 electron 替换为惰性 Proxy
// mock，仅为让被测模块可导入；退避逻辑本身是纯函数，不触碰任何 Electron API。
// 不改生产代码结构、不引入测试专用导出分支。
registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "electron") {
      return { url: "mock-electron://api", shortCircuit: true } as never;
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    if (url === "mock-electron://api") {
      const names = [
        "BrowserWindow",
        "Menu",
        "MessageChannelMain",
        "ipcMain",
        "nativeImage",
        "nativeTheme",
        "screen",
        "shell",
        "webContents",
        "session",
        "crashReporter",
        "protocol",
        "dialog",
        "clipboard",
        "globalShortcut",
        "net",
        "netLog",
        "Notification",
        "powerMonitor",
        "powerSaveBlocker",
        "systemPreferences",
        "touchBar",
        "utilityProcess",
        "Tray",
        "MenuItem",
        "BaseWindow",
        "BrowserView",
        "View",
        "ShareMenu",
        "contentTracing",
        "desktopCapturer",
        "inAppPurchase",
        "autoUpdater",
      ];
      // __mockAny：属性访问/调用/构造都返回自身的惰性值；toString/toPrimitive 提供
      // 基础类型转换，"then" 返回 undefined 防止被当作 thenable 挂起。
      // app.getPath 必须返回真实字符串：desktopRuntimeEnv 导入期会用它 join 路径。
      const source = [
        "const __mockAny = new Proxy(function () {}, {",
        "  get(_t, p) {",
        '    if (p === "then" || p === "__esModule") return undefined;',
        '    if (p === Symbol.toPrimitive) return () => "mock";',
        '    if (p === Symbol.toStringTag) return "Object";',
        '    if (p === "toString" || p === "valueOf") return () => "mock";',
        '    if (typeof p === "symbol") return undefined;',
        "    return __mockAny;",
        "  },",
        "  apply: () => __mockAny,",
        "  construct: () => __mockAny,",
        "});",
        "const __app = new Proxy(__mockAny, {",
        "  get(_t, p) {",
        '    if (p === "getPath") return (name) => "C:\\\\mock-" + String(name);',
        '    if (p === "whenReady") return () => Promise.resolve();',
        "    return Reflect.get(__mockAny, p);",
        "  },",
        "});",
        names.map((n) => `export const ${n} = __mockAny;`).join("\n"),
        "export const app = __app;",
        "export default __mockAny;",
        "",
      ].join("\n");
      return { format: "module", source, shortCircuit: true } as never;
    }
    return nextLoad(url, context);
  },
});

// registerHooks 需先于被测模块注册，因此这里用动态 import 而非静态导入。
const { nextHostRestartDelayMs } = await import("../src/main/desktopWindowLifecycle.js");

test("consecutive fast crashes keep exponential backoff", () => {
  assert.deepEqual(nextHostRestartDelayMs(500, 0), { delayMs: 1_000, attempts: 1 });
  assert.deepEqual(nextHostRestartDelayMs(1_000, 1), { delayMs: 2_000, attempts: 2 });
  assert.deepEqual(nextHostRestartDelayMs(2_000, 2), { delayMs: 4_000, attempts: 3 });
  assert.deepEqual(nextHostRestartDelayMs(3_000, 3), { delayMs: 8_000, attempts: 4 });
  assert.deepEqual(nextHostRestartDelayMs(4_000, 4), { delayMs: 16_000, attempts: 5 });
});

test("backoff delay caps at 30s and counter keeps incrementing", () => {
  assert.equal(nextHostRestartDelayMs(100, 5).delayMs, 30_000);
  assert.equal(nextHostRestartDelayMs(100, 9).delayMs, 30_000);
  assert.deepEqual(nextHostRestartDelayMs(100, 5), { delayMs: 30_000, attempts: 6 });
});

test("host alive for a full max-backoff round resets counter and next delay to 1s", () => {
  // 修复前：历史实现只累加不清零，历史 4 次崩溃会把本次延迟推到 16s。
  assert.deepEqual(nextHostRestartDelayMs(30_000, 4), { delayMs: 1_000, attempts: 1 });
  assert.deepEqual(nextHostRestartDelayMs(120_000, 7), { delayMs: 1_000, attempts: 1 });
});

test("host alive just under the reset threshold keeps backoff", () => {
  assert.deepEqual(nextHostRestartDelayMs(29_999, 4), { delayMs: 16_000, attempts: 5 });
});
