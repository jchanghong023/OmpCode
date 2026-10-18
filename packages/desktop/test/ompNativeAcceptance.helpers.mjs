import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reveal } from "./ompMockInteractions.assertions.mjs";

export async function diagnostics(runtime) {
  const response = await fetch(runtime.mock.diagnosticsUrl);
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.ok(Array.isArray(value.calls));
  assert.ok(value.acceptance && Array.isArray(value.acceptance.catalog));
  assert.ok(
    value.acceptance.catalog.length >= 4,
    "An empty real catalog cannot prove skill parity",
  );
  return value;
}
export async function eventually(read, check, label) {
  const deadline = Date.now() + 90_000;
  // 单项证据也必须有界，不能依赖整个套件的外层截止时间。
  for (;;) {
    let value;
    try {
      value = await read();
    } catch (error) {
      throw new Error(`${label}: ${error.message}`, { cause: error });
    }
    if (check(value)) return value;
    assert.ok(
      Date.now() < deadline,
      `${label}: exceeded 90s waiting for actual evidence; last=${JSON.stringify(value)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
export async function visibleText(page, text) {
  const target = page.getByTestId("v4-timeline").getByText(text, { exact: true });
  await reveal(page, target);
  await target.waitFor({ state: "visible" });
  assert.equal(await target.count(), 1, `One visible timeline record for ${text}`);
}
export async function timelineContains(page, pattern) {
  const target = page.getByTestId("v4-timeline").getByText(pattern);
  await reveal(page, target.first());
  await target.first().waitFor({ state: "visible" });
  return target;
}
export async function idle(page) {
  await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("v4-stop").count(), 0);
}
export async function send(page, text, reply) {
  await page.getByTestId("v4-composer-input").fill(text);
  await page.getByTestId("v4-composer-send").click();
  await visibleText(page, reply);
  await idle(page);
}
export const taskIds = (page) =>
  page
    .locator('li[data-testid^="task-item-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
export async function canonicalTask(page, before) {
  const ids = await eventually(
    () => taskIds(page),
    (all) => {
      const added = all.filter((id) => !before.includes(id));
      return (
        added.length === 1 &&
        /^task-item-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(added[0])
      );
    },
    "native-first canonical UUID",
  );
  return ids.filter((id) => !before.includes(id))[0];
}
export async function choice(page, name) {
  // Select options add a renderer ordinal; match the actual visible label inside the control.
  const target = page
    .getByRole("option")
    .filter({
      has: page.getByText(name, { exact: typeof name === "string" }),
    })
    .or(page.getByRole("button", { name, exact: typeof name === "string" }));
  await target.waitFor({ state: "visible" });
  assert.equal(await target.count(), 1, `Exactly one native choice ${name}`);
  await target.click();
}
export async function confirm(page, accepted) {
  const name = accepted
    ? /^(?:是|确认|确定|Yes|Confirm|Approve)$/u
    : /^(?:否|取消|拒绝|No|Cancel|Deny)$/u;
  const control = page.getByRole("button", { name });
  await choice(page, name);
  await control.waitFor({ state: "hidden" });
}
export async function nativeInput(page, value, title) {
  const request = page
    .getByTestId("v4-user-input-dialog")
    .filter({ has: page.getByText(title, { exact: true }) });
  await request.waitFor({ state: "visible" });
  const textbox = request.getByRole("textbox");
  assert.equal(await textbox.count(), 1, `One actual native input for ${title}`);
  await textbox.fill(value);
  await request.getByRole("button", { name: /^(?:提交|确认|Submit|Confirm)$/u }).click();
  // Match the old question, not the reused card: the next native input can mount immediately.
  await request.waitFor({ state: "hidden" });
}
export async function panel(page, runtime, tab) {
  await page.getByRole("button", { name: "原生工具", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  assert.ok(
    (await dialog.innerText()).includes(runtime.requestedWorkspace),
    "Panel must identify the actual workspace",
  );
  await dialog.getByRole("tab", { name: tab, exact: true }).click();
  return dialog;
}
export async function dashboard(page, runtime, kind, statusOnly = false) {
  const dialog = await panel(page, runtime, "知识与代码索引");
  await dialog
    .getByRole("button", {
      name: kind === "Wiki" ? "打开 /wiki 面板" : "打开 /repo 面板",
      exact: true,
    })
    .click();
  await dialog.waitFor({ state: "hidden" });
  // RPC dashboards output status first, then expose real maintenance choices (no Status action).
  await page
    .getByRole("option")
    .filter({
      has: page.getByText(kind === "Wiki" ? "New document index" : "Rebuild repository index", {
        exact: true,
      }),
    })
    .waitFor({ state: "visible" });
  if (statusOnly) {
    const request = page.locator('[data-elicitation-dialog-card="true"]').filter({
      has: page.getByRole("listbox", {
        name: kind === "Wiki" ? "Document indexes" : "Repository index",
        exact: true,
      }),
    });
    await request.getByRole("button", { name: /^(?:忽略|Dismiss)$/u }).click();
    await request.waitFor({ state: "hidden" });
  }
}
export async function selectValue(page, combobox, name) {
  // Select 内容通过 Portal 渲染；必须限定当前打开的 listbox，不能点到其他原生交互选项。
  await combobox.click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name, exact: typeof name === "string" })
    .click();
}
export async function orchestrate(page, runtime, command, action, args = {}, expectedPreview) {
  const dialog = await panel(page, runtime, "编排快捷操作");
  await selectValue(page, dialog.getByRole("combobox", { name: "命令", exact: true }), command);
  if (action)
    await selectValue(
      page,
      dialog.getByRole("combobox", {
        name: command === "/goal" ? "目标操作" : "循环操作",
        exact: true,
      }),
      action,
    );
  for (const [label, value] of Object.entries(args)) {
    const control = dialog
      .getByRole("textbox", { name: label, exact: true })
      .or(dialog.getByRole("spinbutton", { name: label, exact: true }));
    assert.equal(await control.count(), 1, `One actual ${command} ${label} input`);
    await control.fill(value);
    assert.equal(
      await control.inputValue(),
      value,
      "Preview must originate in the actual user-entered parameter",
    );
  }
  if (expectedPreview)
    assert.equal(
      await dialog.getByLabel("完整命令预览", { exact: true }).innerText(),
      expectedPreview,
      "Native action preview must preserve the exact requested command and budget",
    );
  const destructive =
    (command === "/goal" && action === "删除目标") ||
    (command === "/loop" && action === "裸 /loop（关闭或切换）");
  if (destructive) {
    const checkbox = dialog.getByRole("checkbox", {
      name: command === "/goal" ? /我确认删除当前目标记录/u : /我确认发送裸 \/loop/u,
    });
    assert.equal(await checkbox.getAttribute("aria-checked"), "false");
    const execute = dialog.getByRole("button", { name: "在当前会话执行", exact: true });
    assert.equal(
      await execute.isEnabled(),
      false,
      "Destructive command needs its own fresh confirmation",
    );
    await checkbox.click();
  }
  await dialog.getByRole("button", { name: "在当前会话执行", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}
async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.name !== ".git")
        .map(async (entry) => {
          const path = join(root, entry.name);
          return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
        }),
    )
  )
    .flat()
    .sort();
}
export async function indexSnapshot(runtime) {
  const agentRoot = join(runtime.configRoot, "agent");
  // docs.db 与 repo/ 是 OMP 的权威索引；agent.db 的模型性能批量落盘不是索引副作用。
  const paths = (await filesUnder(agentRoot)).filter((path) => {
    const owned = relative(agentRoot, path).replaceAll("\\", "/");
    return owned === "docs.db" || (owned.startsWith("repo/") && owned.endsWith(".db"));
  });
  const output = [];
  for (const path of paths) {
    const header = (await readFile(path)).subarray(0, 16).toString();
    if (header !== "SQLite format 3\u0000") continue;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const content = tables.map(({ name }) => {
        const statement = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
        // 真实索引含超出 JS 安全整数范围的 SQLite ID，默认 number 读取会直接抛错；
        // 用有类型的十进制整数参与指纹，不能舍入或与同字面的 TEXT 混淆。
        statement.setReadBigInts(true);
        return {
          name,
          rows: statement
            .all()
            .map((row) =>
              JSON.stringify(row, (_key, value) =>
                typeof value === "bigint" ? { sqliteInteger: value.toString() } : value,
              ),
            )
            .sort(),
        };
      });
      output.push({
        path: relative(runtime.runRoot, path),
        rows: content.reduce((count, table) => count + table.rows.length, 0),
        hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
      });
    } finally {
      db.close();
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
export async function assertToolResult(page, runtime, key, expected, evidence) {
  const data = evidence ?? (await diagnostics(runtime));
  const issued = data.acceptance.issued.filter((item) => item.key === key);
  const done = data.acceptance.completed.filter((item) => item.key === key);
  assert.equal(issued.length, 1, `Exactly one actual ${key} tool intention`);
  assert.equal(done.length, 1, `Exactly one independently returned ${key} result`);
  assert.equal(done[0].id, issued[0].id);
  if (expected instanceof RegExp) assert.match(done[0].output, expected);
  else assert.ok(done[0].output.includes(expected));
  const block = page.locator(`[data-tool-call-id="${issued[0].id}"]`);
  await reveal(page, block);
  assert.equal(await block.getAttribute("data-status"), "completed");
  const toggle = block.getByTestId(`tool-summary-trigger-${issued[0].id}`);
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  if (issued[0].name === "read") {
    // ReadToolCallBlock 只显示紧凑来源摘要；历史正文由 journal/HTTP 证据独立核对。
    assert.ok(
      (await block.innerText()).includes(basename(issued[0].args.path)),
      `Visible read-file summary for ${key}`,
    );
  } else if (expected instanceof RegExp) {
    assert.match(await block.innerText(), expected, `Visible real tool result for ${key}`);
  } else {
    assert.ok((await block.innerText()).includes(expected), `Visible real tool result for ${key}`);
  }
  return issued[0].id;
}
export async function journalEvidence(runtime) {
  const paths = (await filesUnder(join(runtime.configRoot, "agent", "sessions"))).filter((path) =>
    path.endsWith(".jsonl"),
  );
  assert.ok(paths.length > 0, "Real OMP must persist actual session journals");
  return await Promise.all(
    paths.map(async (path) => ({
      path,
      lines: (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    })),
  );
}
