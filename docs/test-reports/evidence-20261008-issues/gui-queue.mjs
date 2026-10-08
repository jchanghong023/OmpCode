// Windows 真实桌面公开输入框验收；需隔离桌面已启动、CDP 9230、会话模型 GLM-5.3-Flash。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const run = promisify(execFile);
const binary =
  process.env.OMP_GUI_AGENT_BROWSER ??
  join(process.env.APPDATA, "npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe");
const session = "omp-issues";
const evidence = [];
export async function cli(...args) {
  const { stdout } = await run(binary, ["--session", session, ...args], {
    timeout: 20000,
    maxBuffer: 1048576,
  });
  return stdout.trim();
}
export async function evaluate(js) {
  return JSON.parse(await cli("eval", "-b", Buffer.from(js).toString("base64")));
}
export async function waitFor(js, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await evaluate(js);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`UI wait failed: ${js}`);
}
const editor = 'document.querySelector("[contenteditable=true][role=textbox]")';
export async function submit(text) {
  // Tiptap 通过真实编辑事件更新受控草稿；不修改运行时或队列 store。
  await evaluate(
    `(() => { const e = ${editor}; e.focus(); const r = document.createRange(); r.selectNodeContents(e); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("insertText", false, ${JSON.stringify(text)}); return e.innerText; })()`,
  );
  const label = await evaluate(
    `(() => { const b = Array.from(document.querySelectorAll("button")).find(e => ["发送", "加入队列", "引导"].includes(e.getAttribute("aria-label"))); if (!b || b.disabled) throw new Error("submit disabled"); b.click(); return b.getAttribute("aria-label"); })()`,
  );
  await waitFor(`${editor}?.innerText.trim() === ""`);
  evidence.push({ event: "submitted", text, label, at: new Date().toISOString() });
}
async function queueScenario() {
  await cli("connect", process.env.OMP_GUI_CDP_PORT ?? "9230");
  await evaluate('document.querySelector("button[aria-label=新建任务]").click(); true');
  await waitFor(`${editor} !== null`);
  await submit("hello");
  await submit("hello");
  await submit("hello");
  const queue = await waitFor(
    '(() => { const items = Array.from(document.querySelectorAll("li[data-queue-item-id]")); return items.length === 2 ? items.map(e => ({id:e.getAttribute("data-queue-item-id"), text:e.innerText})) : null; })()',
  );
  assert.equal(new Set(queue.map((item) => item.id)).size, 2);
  assert.ok(queue.every((item) => item.text.includes("hello")));
  evidence.push({ event: "queued", items: queue });
  await cli("screenshot", join(import.meta.dirname, "queue-waiting.png"));
  await waitFor(
    'document.querySelector("button[aria-label=发送]") !== null && !document.querySelector("[data-queue-count]")',
    90000,
  );
  const result = await evaluate("document.body.innerText");
  evidence.push({ event: "completed", text: result });
  await cli("screenshot", join(import.meta.dirname, "queue-completed.png"));
  await writeFile(
    join(import.meta.dirname, "queue-result.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("PASS: 3 次 hello；2 条独立等待项；队列消费后清空并完成。");
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await queueScenario();
