// omp agents GUI 验收的状态面板与待办断言（自 ompAgentsAcceptance.assertions.mjs 拆出，架构 maxFileLines=400）：
// 设置页开关、状态胶囊分组、待办面板逐相位推进与运行中代理计数都在这里，不碰子代理详情断言。
import assert from "node:assert/strict";
import { join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";
import { acknowledge, eventually, submit } from "./ompAgentsAcceptance.assertionsShared.mjs";

async function setTodoVisibility(page, enabled) {
  await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
  // 设置是整页路由，且会记忆上次分类；不是带关闭按钮的对话框。
  const settings = page.getByTestId("settings-page");
  await settings.waitFor({ state: "visible" });
  await settings.getByTestId("settings-section-nav-general").click();
  const showTodo = settings.getByRole("switch", {
    name: /^(?:显示待办|Show todos)$/u,
  });
  await showTodo.waitFor({ state: "visible" });
  assert.equal(await showTodo.count(), 1, "Exactly one genuine show-todo preference");
  if ((await showTodo.isChecked()) !== enabled) await showTodo.click();
  await eventually(
    () => showTodo.isChecked(),
    (checked) => checked === enabled,
    "The real settings command must commit the requested todo visibility",
  );
  await settings.getByTestId("settings-back-button").click();
  await settings.waitFor({ state: "hidden" });
  await page.getByTestId("v4-composer-input").waitFor({ state: "visible" });
}

async function openStatusSection(page, section) {
  // 中文原因：各分组属于同一状态面板；先真实展开胶囊，再展开对应分组。
  const shell = page.getByTestId("chat-summary-panel");
  await shell.waitFor({ state: "visible" });
  assert.equal(
    await shell.count(),
    1,
    "Exactly one genuine conversation status panel must own the section",
  );
  const expand = shell.getByRole("button", { name: /^(?:展开状态|Expand status)$/u });
  if (await expand.isVisible()) await expand.click();
  const panel = shell.locator(`[data-status-section="${section}"]`);
  await panel.waitFor({ state: "visible" });
  const toggle = panel.locator(`button[data-status-section-trigger="${section}"]`);
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  if (section === "plan") await panel.getByRole("list").waitFor({ state: "visible" });
  else await panel.getByTestId("omp-agent-interactions-open").waitFor({ state: "visible" });
  return panel;
}

export const openTodoPanel = (page) => openStatusSection(page, "plan");
export const openAgentPanel = (page) => openStatusSection(page, "agent");

export async function assertAgentCount(page, count) {
  const shell = page.getByTestId("chat-summary-panel");
  await shell.waitFor({ state: "visible" });
  await eventually(
    () => shell.getAttribute("data-running-agent-count"),
    (value) => value === String(count),
    "The independent status panel must show the exact actual running agent count",
  );
  const badge = page.getByTestId("v4-composer-background-work-trigger");
  // 中文原因：输入区徽标只在有活动时存在；零运行项应卸载，不存在“Agents 0”按钮。
  if (count === 0) {
    await badge.waitFor({ state: "hidden" });
    assert.equal(
      await badge.count(),
      0,
      "No completed/failed/stopped agent may retain a running badge",
    );
  } else {
    await badge.waitFor({ state: "visible" });
    await eventually(
      () => badge.getAttribute("data-background-subagent-count"),
      (value) => value === String(count),
      "The genuine composer badge must match the independent panel count",
    );
  }
}

export async function exerciseTodo(page, evidenceDir) {
  await setTodoVisibility(page, true);
  const panel = page.getByTestId("chat-summary-panel").locator('[data-status-section="plan"]');
  for (const state of [
    "pending",
    "inProgress",
    "completed",
    "replace",
    "invalid",
    "clear",
    "restore",
  ]) {
    await submit(page, `AGENTS_TODO_${state}`);
    await acknowledge(page, `AGENTS_TODO_ACK_${state}`);
    if (state === "clear") {
      // 中文原因：空清单必须清除整个独立面板，不只隐藏旧标题。
      await panel.waitFor({ state: "hidden" });
      assert.equal(
        await panel.getByRole("progressbar").count(),
        0,
        "Cleared todo cannot retain old progress",
      );
      assert.equal(
        await panel.getByRole("listitem").count(),
        0,
        "Cleared todo cannot retain any item",
      );
      assert.equal(await panel.getByText("AGENTS_REPLACEMENT", { exact: true }).count(), 0);
      assert.equal(await panel.getByText("AGENTS_PHASE", { exact: true }).count(), 0);
      continue;
    }
    await openTodoPanel(page);
    const title = ["replace", "invalid"].includes(state) ? "AGENTS_REPLACEMENT" : "AGENTS_PHASE";
    await panel.getByText(title, { exact: true }).first().waitFor({ state: "visible" });
    if (["replace", "invalid"].includes(state)) {
      assert.equal(
        await panel.getByText("AGENTS_PRELUDE_ITEM", { exact: true }).count(),
        0,
        "Replacement must remove every item from the previous phases",
      );
      assert.equal(
        await panel.getByText("AGENTS_PHASE", { exact: true }).count(),
        0,
        "Todo updates replace rather than append",
      );
    }
    // 中文原因：独立面板用条目属性表达状态，不渲染工具详情里的状态文案。
    const expectedStatus = { pending: "pending", inProgress: "inProgress" }[state] ?? "completed";
    const targetItem = panel.getByRole("listitem").filter({
      has: page.getByText(title, { exact: true }),
    });
    await eventually(
      () => targetItem.getAttribute("data-plan-status"),
      (status) => status === expectedStatus,
      `Todo ${state} must project the real target item status`,
    );
    const original = ["pending", "inProgress", "completed"].includes(state);
    const total = original ? 2 : 1;
    const completed = state === "pending" ? 0 : state === "inProgress" ? 1 : total;
    assert.equal(await panel.getByRole("listitem").count(), total);
    if (original) {
      const prelude = panel.getByRole("listitem").filter({
        has: page.getByText("AGENTS_PRELUDE_ITEM", { exact: true }),
      });
      assert.equal(
        await prelude.getAttribute("data-plan-status"),
        state === "pending" ? "inProgress" : "completed",
        "Completing the earlier phase must advance, not reset, the next task",
      );
    }
    const progress = panel.getByRole("progressbar");
    if (await progress.count()) {
      assert.equal(await progress.count(), 1);
      const maximum = Number(await progress.getAttribute("aria-valuemax"));
      const current = Number(await progress.getAttribute("aria-valuenow"));
      assert.ok(Number.isFinite(maximum) && maximum > 0 && Number.isFinite(current));
      assert.equal(
        current / maximum,
        completed / total,
        "Todo progress must match every actual item across phases",
      );
    } else {
      await panel
        .getByText(new RegExp(`^${completed}\\s*/\\s*${total}$`, "u"))
        .waitFor({ state: "visible" });
    }
    if (state === "invalid") {
      const failed = page.locator('[data-tool-call-id="agents-todo-invalid"]');
      await reveal(page, failed);
      assert.equal(
        await failed.getAttribute("data-status"),
        "failed",
        "Invalid real todo must visibly fail and leave replacement intact",
      );
    }
    await captureIsolationScreenshot(join(evidenceDir, `agents-todo-${state}.png`));
  }
  // 中文原因：工具组和显示开关不拥有 plan，折叠/隐藏工具行不能连带隐藏独立面板。
  await reveal(page, page.locator('[data-tool-call-id="agents-todo-restore"]'));
  const history = page.locator(
    'button[data-testid^="chat-assistant-history-trigger-"][data-history-open="true"]',
  );
  assert.ok(
    (await history.count()) > 0,
    "Require a real expanded tool work group before testing collapse",
  );
  // all() 返回按位置重查的 Locator；切换开合会缩短匹配集合，必须始终操作当前首项。
  while ((await history.count()) > 0) await history.first().click();
  await panel.getByText("AGENTS_PHASE", { exact: true }).first().waitFor({ state: "visible" });
  await setTodoVisibility(page, false);
  await openTodoPanel(page);
  const collapsed = page.locator(
    'button[data-testid^="chat-assistant-history-trigger-"][data-history-open="false"]',
  );
  while ((await collapsed.count()) > 0) await collapsed.first().click();
  assert.equal(await page.locator('[data-tool-call-id="agents-todo-restore"]').count(), 0);
  await panel.getByText("AGENTS_PHASE", { exact: true }).first().waitFor({ state: "visible" });
}
