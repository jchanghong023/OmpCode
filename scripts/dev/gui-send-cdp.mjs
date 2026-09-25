// GUI 端到端驱动：向 composer 真实输入提示词并发送，随后轮询会话界面状态。
// 阶段一：输入 + 发送 + 截图。后续阶段由 poll 脚本接管。
import { writeFileSync } from "node:fs";

const STEP_TIMEOUT_MS = 20000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), STEP_TIMEOUT_MS)),
  ]);
}

async function main() {
  const targets = await fetch("http://127.0.0.1:9230/json/list").then((r) => r.json());
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(
    new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    }),
    "ws open",
  );
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      }),
      method,
    );
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result.result.value;
  };
  const screenshot = async (path) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    console.log("[gui] screenshot:", path);
  };

  // 1. 聚焦 composer（真实点击其坐标）
  const rect = await evaluate(`(() => {
    const textarea = document.querySelector("textarea");
    if (!textarea) return null;
    const r = textarea.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(40, r.height / 2) };
  })()`);
  if (!rect) throw new Error("composer textarea not found");
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await new Promise((sleep) => setTimeout(sleep, 300));

  // 2. 输入提示词（insertText 走 IME 通道，React 受控组件可收到）
  const prompt = "请用 write 工具创建文件 hello-gui.txt，内容写：GUI e2e via omp core。完成后简短说明。";
  await call("Input.insertText", { text: prompt });
  await new Promise((sleep) => setTimeout(sleep, 500));

  const typed = await evaluate(
    "(() => { const t = document.querySelector('textarea'); return { value: t ? t.value.slice(0, 40) : null, len: t ? t.value.length : 0 }; })()",
  );
  console.log("[gui] typed:", JSON.stringify(typed));
  await screenshot("C:/Users/jiang/AppData/Local/Temp/ompcode-gui-02-typed.png");

  // 3. 回车发送
  await call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter",
    text: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    code: "Enter",
    key: "Enter",
  });
  await new Promise((sleep) => setTimeout(sleep, 2500));

  const after = await evaluate(
    "(() => { const t = document.querySelector('textarea'); return { cleared: t ? t.value.length === 0 : null, text: document.body.innerText.slice(0, 500) }; })()",
  );
  console.log("[gui] after send, cleared:", after.cleared);
  console.log("[gui] body snippet:", JSON.stringify(after.text.slice(0, 300)));
  await screenshot("C:/Users/jiang/AppData/Local/Temp/ompcode-gui-03-sent.png");
  ws.close();
  console.log("[gui] send phase done");
}

main().catch((error) => {
  console.error("[gui] FAILED:", error.message);
  process.exit(1);
});
