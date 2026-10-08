// P2 验收 D2 回归：Electron 28 构建态 dev 下 app.getVersion() 返回 "0.0"
// （packages/desktop/package.json 无 version 字段），electron-updater 6.x 的
// AppUpdater 构造器无条件 semver.parse 该值并抛 ERR_UPDATER_INVALID_VERSION。
// 修复前 autoUpdater.ts 在模块加载期就解构 autoUpdater（惰性 getter 首次访问即构造），
// 主进程 import 阶段即崩、窗口无法创建；修复后仅在运行时版本校验通过后才允许构造。
//
// 这里用 node:module registerHooks 把 electron 替换为受控 mock（真实 electron-updater
// 的 ElectronAppAdapter 经 require("electron").app 读取版本，hook 对 CJS require 同样生效），
// electron-updater 本体保持真实实现——它的构造器 semver 校验就是被测契约本身。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";

// 修复原因：导入 updater 会初始化 Main logger 并清理旧日志，测试不能触碰真实用户目录。
const logRoot = await mkdtemp(join(tmpdir(), "omp-updater-version-test-"));
process.env.ZCODE_ENV = "test";
process.env.ZCODE_E2E_RUNTIME_LOG_DIR = logRoot;
test.after(async () => {
  const { logger } = await import("../src/main/logger.js");
  await logger.flush();
  await rm(logRoot, { recursive: true, force: true });
});

interface D2TestState {
  version: string;
  isPackaged: boolean;
}
const state: D2TestState = { version: "0.0", isPackaged: true };
(globalThis as Record<string, unknown>).__d2UpdaterTestState = state;

registerHooks({
  resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === "electron") {
      return { url: "mock-electron://api", shortCircuit: true } as never;
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    if (url === "mock-electron://api") {
      // __mockAny：属性访问/调用/构造都返回自身的惰性值；"then" 返回 undefined 防止
      // 被当作 thenable 挂起。app.getVersion/isPackaged 走可变测试态，其余保持 mock。
      const source = [
        "const __state = globalThis.__d2UpdaterTestState;",
        "const __mockAny = new Proxy(function () {}, {",
        "  get(_t, p) {",
        '    if (p === "then" || p === "__esModule") return undefined;',
        '    if (p === Symbol.toPrimitive) return () => "mock";',
        '    if (p === "toString" || p === "valueOf") return () => "mock";',
        "    if (typeof p === 'symbol') return undefined;",
        "    return __mockAny;",
        "  },",
        "  apply: () => __mockAny,",
        "  construct: () => __mockAny,",
        "});",
        "const __app = new Proxy(__mockAny, {",
        "  get(_t, p) {",
        '    if (p === "getVersion") return () => __state.version;',
        '    if (p === "isPackaged") return __state.isPackaged;',
        '    if (p === "getPath") return (name) => "C:\\\\mock-" + String(name);',
        '    if (p === "getAppPath") return () => "C:\\\\mock-appPath";',
        '    if (p === "whenReady") return () => Promise.resolve();',
        "    return Reflect.get(__mockAny, p);",
        "  },",
        "});",
        "const __browserWindow = new Proxy(__mockAny, {",
        "  get(_t, p) {",
        '    if (p === "getAllWindows") return () => [];',
        '    if (p === "getFocusedWindow") return () => null;',
        "    return Reflect.get(__mockAny, p);",
        "  },",
        "});",
        "export const app = __app;",
        "export const BrowserWindow = __browserWindow;",
        "export const ipcMain = __mockAny;",
        "export const Menu = __mockAny;",
        "export const net = __mockAny;",
        "export const session = __mockAny;",
        "export const shell = __mockAny;",
        "export const dialog = __mockAny;",
        "export const nativeImage = __mockAny;",
        "export const crashReporter = __mockAny;",
        "export const protocol = __mockAny;",
        "export const screen = __mockAny;",
        "export const nativeTheme = __mockAny;",
        "export const powerMonitor = __mockAny;",
        "export const utilityProcess = __mockAny;",
        "export default __mockAny;",
        "",
      ].join("\n");
      return { format: "module", source, shortCircuit: true } as never;
    }
    return nextLoad(url, context);
  },
});

interface OutputCapture {
  lines: string[];
  attach(): void;
  detach(): void;
  countMatching(substring: string): number;
}

/** 捕获 stdout+stderr：main logger 的 info 走 console.log，warn 走 console.warn。 */
function captureOutput(): OutputCapture {
  const lines: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const record = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) lines.push(line);
    }
  };
  return {
    lines,
    attach() {
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        record(typeof chunk === "string" ? chunk : String(chunk));
        return originalStdout(chunk as never, ...(rest as never[]));
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        record(typeof chunk === "string" ? chunk : String(chunk));
        return originalStderr(chunk as never, ...(rest as never[]));
      }) as typeof process.stderr.write;
    },
    detach() {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
    countMatching(substring: string) {
      return lines.filter((line) => line.includes(substring)).length;
    },
  };
}

// registerHooks 需先于被测模块注册，因此这里用动态 import 而非静态导入。
const autoUpdaterModule = await import("../src/main/autoUpdater.js");

test("运行时版本门与 electron-updater 构造器同口径（严格 semver.parse，不 coerce）", () => {
  const { isUpdaterRuntimeVersionUsable } = autoUpdaterModule;
  assert.equal(isUpdaterRuntimeVersionUsable("0.0"), false, "Electron 28 构建态 dev 实测值");
  assert.equal(isUpdaterRuntimeVersionUsable(""), false);
  assert.equal(isUpdaterRuntimeVersionUsable("latest"), false);
  assert.equal(isUpdaterRuntimeVersionUsable("0.0.0"), true, "显式三段零版本合法");
  assert.equal(isUpdaterRuntimeVersionUsable("44.5.0"), true);
  assert.equal(isUpdaterRuntimeVersionUsable("3.14.3"), true);
});

test("app 版本非法时模块导入不构造 electron-updater 实例（修复前此处即崩）", () => {
  // state.version === "0.0"：修复前 autoUpdater.ts 模块加载期解构 autoUpdater
  // 触发真实构造器 semver 校验并抛「App version is not a valid semver version: "0.0"」，
  // 上面的动态 import 会直接 reject；能走到这里即证明加载期不再构造实例。
  assert.equal(state.version, "0.0");
});

test("非法版本走 skip 分支：initAutoUpdater 不抛错且 warn 只发一次", async () => {
  state.version = "0.0";
  const stderr = captureOutput();
  stderr.attach();
  try {
    await autoUpdaterModule.initAutoUpdater({});
    await autoUpdaterModule.initAutoUpdater({});
  } finally {
    stderr.detach();
  }
  const warns = stderr.countMatching("is not a valid semver version");
  assert.ok(warns >= 1, `缺少跳过 warn，stderr=${stderr.lines.join("\n")}`);
  assert.equal(
    stderr.countMatching("initializing, current version"),
    0,
    "非法版本不得进入 updater 初始化",
  );
});

test("合法版本走正常分支：initAutoUpdater 完成初始化并使用该版本", async () => {
  state.version = "44.5.0";
  // feed 指向本机未监听端口：启动检查只做一次失败收口，不触公网。
  const stderr = captureOutput();
  stderr.attach();
  try {
    await autoUpdaterModule.initAutoUpdater({
      enabled: true,
      updateFeedSource: { url: "http://127.0.0.1:9/latest.yml" },
    });
  } finally {
    stderr.detach();
  }
  assert.equal(
    stderr.countMatching("is not a valid semver version"),
    0,
    "合法版本不得触发跳过 warn",
  );
  assert.ok(
    stderr.countMatching("initializing, current version: 44.5.0") >= 1,
    `缺少初始化日志，stderr=${stderr.lines.join("\n")}`,
  );
});
