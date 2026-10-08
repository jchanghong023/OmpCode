// Windows 隔离开发态的 Todo、子代理及 /loop 公开入口验收。
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { cli, evaluate, waitFor, submit } from "./gui-queue.mjs";

const workspace = process.env.OMP_GUI_WORKSPACE;
assert.ok(workspace, "OMP_GUI_WORKSPACE 必须指定当前隔离非项目工作区，禁止使用用户项目");
const evidence = [];
const shot = (name) => cli("screenshot", join(import.meta.dirname, `${name}.png`));
async function clickButton(text) {
  const find = `Array.from(document.querySelectorAll("button")).find(e => e.textContent === ${JSON.stringify(text)})`;
  await waitFor(`Boolean(${find})`);
  await evaluate(`${find}.click(); true`);
}
await cli("connect", process.env.OMP_GUI_CDP_PORT ?? "9230");
if (!(await evaluate('Boolean(document.querySelector("button[aria-label=设置]"))')))
  await clickButton("返回工作区");
await waitFor('Boolean(document.querySelector("button[aria-label=设置]"))');
await evaluate('document.querySelector("button[aria-label=设置]").click(); true');
await clickButton("模型设置");
await waitFor('document.querySelector("select[aria-label=default]") !== null');
assert.equal(await evaluate('document.body.innerText.includes("角色目录暂不可用")'), false);
evidence.push({ event: "model-role-directory", result: "passed" });
await shot("models-final");
await clickButton("常规");
await waitFor('Boolean(document.querySelector("[role=switch][aria-label=显示待办]"))');
await evaluate(
  '(() => { const b = document.querySelector("[role=switch][aria-label=显示待办]"); if (b.getAttribute("aria-checked") !== "true") b.click(); return true; })()',
);
await clickButton("返回工作区");
await waitFor('Boolean(document.querySelector("button[aria-label=新建任务]"))');
await evaluate('document.querySelector("button[aria-label=新建任务]").click(); true');
assert.ok(await evaluate('document.body.innerText.includes("zhipu-coding-plan/GLM-5.3-Flash")'));
const originalFiles = new Set(await readdir(workspace));
let captured;
const observeFiles = (async () => {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const files = (await readdir(workspace)).filter((name) => !originalFiles.has(name));
    const data = await Promise.all(
      files.map(async (name) => {
        try {
          return { name, content: (await readFile(join(workspace, name), "utf8")).trim() };
        } catch {
          return null;
        }
      }),
    );
    const matches = data.filter((row) => row && ["1", "2", "3"].includes(row.content));
    if (new Set(matches.map((row) => row.content)).size === 3) {
      captured = matches;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("未观察到内容分别为 1、2、3 的三个真实文件");
})();
await submit(
  "写3个文件，文件名随意，内容分别是1-3，写完后删除，用todo工具跟踪进度。要求界面上有进度。",
);
await waitFor(
  'document.body.innerText.includes("待办") && /\\d+\\/\\d+/.test(document.body.innerText)',
  90000,
);
await shot("todo-progress");
await waitFor('document.querySelector("button[aria-label=发送]") !== null', 90000);
await observeFiles;
for (const file of captured) await assert.rejects(access(join(workspace, file.name)));
await evaluate(
  'Array.from(document.querySelectorAll("button")).filter(e => /已工作/.test(e.textContent) && e.getAttribute("aria-expanded") === "false").forEach(e => e.click()); true',
);
const todoText = await evaluate("document.body.innerText");
assert.ok(todoText.includes("待办"));
evidence.push({ event: "todo", files: captured, finalText: todoText });
await shot("todo-completed");

await evaluate('document.querySelector("button[aria-label=新建任务]").click(); true');
await submit("分配一个子代理，让它返回hello。");
await waitFor('document.body.innerText.includes("子智能体")', 90000);
await shot("subagent-running");
await waitFor('document.querySelector("button[aria-label=发送]") !== null', 90000);
await evaluate(
  'Array.from(document.querySelectorAll("button")).filter(e => /已工作/.test(e.textContent) && e.getAttribute("aria-expanded") === "false").forEach(e => e.click()); true',
);
await waitFor(
  'Array.from(document.querySelectorAll("summary")).some(e => e.textContent === "查看子代理记录")',
);
await shot("subagent-completed-final");
await evaluate(
  'Array.from(document.querySelectorAll("summary")).find(e => e.textContent === "查看子代理记录").click(); true',
);
const subagentText = await evaluate("document.body.innerText");
assert.ok(subagentText.includes("hello"));
assert.ok(subagentText.includes("success"));
evidence.push({ event: "subagent", text: subagentText });
await shot("subagent-record-final");

await submit("/loop");
await waitFor('document.body.innerText.includes("需要终端运行时")');
evidence.push({ event: "loop", result: "expected-tui-only-rejection" });
await shot("loop-rejected");
await writeFile(join(import.meta.dirname, "extra-result.json"), JSON.stringify(evidence, null, 2));
console.log("PASS: 模型角色目录、Todo 真实文件及进度、子代理记录；/loop 按能力限制拒绝。");
