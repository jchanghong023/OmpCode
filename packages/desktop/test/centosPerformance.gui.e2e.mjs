import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

// 隔离 Electron 28 组件级 GUI 验证，不连接用户工作区、模型或输入法。
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "ompcode-performance-"));
try {
  const stylesheet = await readFile(join(root, "packages/ui/src/styles.css"), "utf8");
  const reducedStyles = stylesheet.slice(
    stylesheet.indexOf('html[data-ompcode-reduced-motion="true"]'),
  );
  assert.ok(reducedStyles.startsWith("html["));
  await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import React, { memo } from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { useBufferedStreamingText } from "./packages/ui/src/hooks/useBufferedStreamingText.ts";
        let renders = 0;
        const Markdown = memo(({ text }) => { renders++; return <span id="text">{text}</span>; });
        function View({ text, streaming, identity, delay }) {
          return <Markdown text={useBufferedStreamingText(text, streaming, identity, delay)} />;
        }
        const root = createRoot(document.getElementById("root"));
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        function check(value, message) { if (!value) throw new Error(message); }
        function show(text, streaming = true, identity = "a", delay = 100) {
          flushSync(() => root.render(<View {...{ text, streaming, identity, delay }} />));
        }
        const value = () => document.getElementById("text").textContent;
        window.runTest = async () => {
          show("首段");
          check(value() === "首段", "first text delayed");
          const before = renders;
          for (let i = 1; i <= 20; i++) show("首段" + "字".repeat(i));
          check(value() === "首段", "burst was not buffered");
          await pause(180);
          check(value() === "首段" + "字".repeat(20), "latest cumulative text lost");
          const bufferedRenders = renders - before;
          check(bufferedRenders === 1, "Markdown still renders for each chunk");
          show(value() + "待发布");
          show("完成全文", false);
          check(value() === "完成全文", "completion delayed");
          await pause(150);
          check(value() === "完成全文", "old timer replaced final text");
          show("新会话", true, "b");
          check(value() === "新会话", "session switch retained old text");
          show("新会话的待发布内容", true, "b");
          show("替换", true, "b");
          check(value() === "替换", "replacement delayed");
          await pause(150);
          check(value() === "替换", "replaced text revived");
          const beforeUnbuffered = renders;
          for (let i = 1; i <= 20; i++) show("原行为" + i, true, "c", 0);
          check(renders - beforeUnbuffered === 20, "other builds were throttled");
          check(matchMedia("(prefers-reduced-motion: reduce)").matches, "Electron reduced motion flag ignored");
          document.documentElement.dataset.ompcodeReducedMotion = "true";
          const decoration = document.createElement("div");
          let ended = 0;
          decoration.addEventListener("animationend", () => ended++);
          decoration.style.cssText = "animation: test-motion 10s linear infinite; backdrop-filter:blur(10px); scroll-behavior:smooth";
          document.body.append(decoration);
          const style = getComputedStyle(decoration);
          check(parseFloat(style.animationDuration) < 0.001, "CSS animation still long");
          check(style.backdropFilter === "none" && style.scrollBehavior === "auto", "expensive effects remain");
          await pause(150);
          check(ended === 1, "animation completion event lost");
          show("等待卸载", true, "d");
          show("等待卸载追加", true, "d");
          flushSync(() => root.unmount());
          await pause(150);
          return { bufferedRenders, unbufferedRenders: 20, animationEndEvents: ended };
        };
      `,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    outfile: join(directory, "renderer.js"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await writeFile(
    join(directory, "index.html"),
    `<html><head><style>@keyframes test-motion {from {opacity:0} to {opacity:1}}\n${reducedStyles}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`,
  );
  await writeFile(
    join(directory, "main.cjs"),
    `
    const { app, BrowserWindow } = require("electron");
    setTimeout(() => { console.error("GUI test timed out"); app.exit(2); }, 15000).unref();
    app.setPath("userData", ${JSON.stringify(join(directory, "user-data"))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false } });
      await win.loadFile(${JSON.stringify(join(directory, "index.html"))});
      const result = await win.webContents.executeJavaScript("window.runTest()");
      console.log("PERFORMANCE_TEST " + JSON.stringify(result));
      app.exit(0);
    }).catch((error) => { console.error(error); app.exit(1); });
  `,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = [
    resolve(root, "node_modules/electron/dist/electron"),
    "--no-sandbox",
    "--disable-gpu",
    "--force-prefers-reduced-motion",
    join(directory, "main.cjs"),
  ];
  const args =
    process.env.OMPCODE_E2E_X11_TCP === "1"
      ? [
          "-a",
          "-l",
          "bash",
          "-c",
          'export DISPLAY="localhost${DISPLAY}"; exec "$@"',
          "bash",
          ...electronArgs,
        ]
      : ["-a", ...electronArgs];
  const child = spawn("xvfb-run", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /PERFORMANCE_TEST/);
  console.log(output.split("\n").find((line) => line.startsWith("PERFORMANCE_TEST")));
} finally {
  await rm(directory, { recursive: true, force: true });
}
