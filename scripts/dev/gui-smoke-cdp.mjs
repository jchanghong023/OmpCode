// GUI 冒烟（CDP）：验证 dev 桌面 renderer 的 OmpCode 品牌、composer 可用性，并截图存档。
// 前台短连接，每步超时 15s；只读检查，不持久化任何业务状态。
import { writeFileSync } from "node:fs";

const CDP_PORT = 9229;
const STEP_TIMEOUT_MS = 15000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), STEP_TIMEOUT_MS)),
  ]);
}

async function main() {
  const targets = await withTimeout(
    fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()),
    "json/list",
  );
  const page = targets.find((t) => t.type === "page" && t.url.includes("localhost"));
  if (!page) throw new Error("page target not found");

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
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry(message);
    }
  });

  const call = (method, params = {}) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, (message) => {
          if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
          else resolve(message.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      method,
    );

  const evaluate = async (label, expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`${label}: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    }
    console.log(`[gui] ${label}:`, JSON.stringify(result.result.value));
    return result.result.value;
  };

  await evaluate("title", "document.title");
  await evaluate("brand", `(() => {
    const text = document.body.innerText;
    const count = (n) => text.split(n).length - 1;
    return { ompcode: count("OmpCode"), zcodeBrand: count("ZCode"), zCode: count("Z Code") };
  })()`);
  await evaluate("composer", `(() => {
    const textarea = document.querySelector("textarea");
    return { hasTextarea: Boolean(textarea), placeholder: textarea?.placeholder ?? null };
  })()`);

  const shot = await call("Page.captureScreenshot", { format: "png" });
  const shotPath = "C:/Users/jiang/AppData/Local/Temp/ompcode-gui-01-initial.png";
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("[gui] screenshot:", shotPath, Buffer.from(shot.data, "base64").length, "bytes");

  ws.close();
  console.log("[gui] PASS");
}

main().catch((error) => {
  console.error("[gui] FAILED:", error.message);
  process.exit(1);
});
