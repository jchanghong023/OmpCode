// omp agents GUI 验收的子代理详情断言（架构 maxFileLines=400）：会话驱动原语与状态面板/待办断言已拆到
// ompAgentsAcceptance.assertionsShared.mjs 与 ompAgentsAcceptance.assertionsPanels.mjs，此处转出保路径。
import assert from "node:assert/strict";
import { join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";
import { eventually } from "./ompAgentsAcceptance.assertionsShared.mjs";
import { assertCardModel, assertDetailModel } from "./ompAgentsAcceptance.models.mjs";

export * from "./ompAgentsAcceptance.assertionsShared.mjs";
export * from "./ompAgentsAcceptance.assertionsPanels.mjs";

export async function assertReadonly(pane, state) {
  await pane.getByText(state).first().waitFor({ state: "visible" });
  const controls = pane.locator("[data-subagent-control-state]");
  await controls.waitFor({ state: "visible" });
  assert.equal(
    await controls.count(),
    1,
    "A recognized child must retain its explicit control bar",
  );
  await controls
    .getByText(/执行记录只读|Read-only execution record/u)
    .waitFor({ state: "visible" });
  for (const name of [/^(?:发送|Send)$/u, /^(?:停止|Stop)$/u]) {
    const button = controls.getByRole("button", { name });
    assert.equal(
      await button.count(),
      1,
      "Read-only child controls must exist, not silently disappear",
    );
    assert.equal(
      await button.isEnabled(),
      false,
      "Historical/ended child controls cannot be active",
    );
  }
  const input = controls.getByRole("textbox");
  assert.equal(await input.count(), 1, "The read-only message input must remain visible");
  assert.equal(
    await input.isEnabled(),
    false,
    "The historical child message input must be disabled",
  );
  assert.equal(await input.isEditable(), false);
}
export async function identitiesOf(page, count, dispatch) {
  assert.equal(dispatch.toolId, "agents-batch-task");
  assert.equal(dispatch.children.length, count);
  const opens = page.locator('[data-testid^="v4-subagent-open-side-pane-"]');
  await eventually(
    () => opens.count(),
    (size) => size === count,
    "One detail opener for each independent child",
  );
  const parent = await page
    .getByTestId("v4-composer-input")
    .locator("xpath=ancestor::*[@data-session-id][1]")
    .getAttribute("data-session-id");
  assert.ok(
    parent && parent !== "draft",
    "The task cards must belong to the live parent conversation",
  );
  const children = [];
  for (const open of await opens.all()) {
    const route = (await open.getAttribute("data-testid")).slice(
      "v4-subagent-open-side-pane-".length,
    );
    const match = /^omp-subagent:([A-Za-z0-9_-]+)@(.+)$/u.exec(route);
    assert.ok(match, "Each real child has raw ID plus parent route");
    const actual = dispatch.children.filter((child) => child.id === match[1]);
    assert.equal(
      actual.length,
      1,
      "The actual parent task result must own this exact raw child ID",
    );
    const owner = await open
      .locator("xpath=ancestor::*[@data-session-id][1]")
      .getAttribute("data-session-id");
    assert.equal(match[2], owner, "Child detail route must belong to the actual conversation pane");
    assert.equal(
      match[2],
      parent,
      "No opener from another conversation may stand in for this child",
    );
    const card = open.locator("xpath=ancestor::*[@data-tool-call-id][1]");
    assert.equal(
      await card.getAttribute("data-tool-call-id"),
      `omp-subagent:${match[1]}`,
      "The independent card ID identifies the child, not the spawning tool invocation",
    );
    const text = await eventually(
      () => card.innerText(),
      (value) => value.includes(actual[0].assignment),
      "The actual child assignment must reach its own card",
    );
    const assignment = /^AGENTS_CHILD_(a|b|c)$/u.exec(actual[0].assignment);
    assert.ok(assignment);
    assert.ok(text.includes(match[1]), "Card heading must expose original identity");
    children.push({
      name: assignment[1],
      rawId: match[1],
      liveParent: match[2],
      route,
      canonicalParent: dispatch.parentId,
    });
  }
  assert.deepEqual(
    children.map((child) => child.rawId).sort(),
    dispatch.children.map((child) => child.id).sort(),
    "No missing or foreign child may enter the task set",
  );
  assert.deepEqual(children.map((child) => child.name).sort(), ["a", "b", "c"]);
  return children.sort((a, b) => a.name.localeCompare(b.name));
}
export async function identityForTask(page, toolId, name, previousCount, dispatch) {
  assert.equal(dispatch.toolId, toolId);
  assert.equal(dispatch.children.length, 1, "This exact real task must own one child");
  const actual = dispatch.children[0];
  assert.equal(actual.assignment, `AGENTS_CHILD_${name}`);
  const opens = page.locator('[data-testid^="v4-subagent-open-side-pane-"]');
  await eventually(
    () => opens.count(),
    (count) => count === previousCount + 1,
    "Exactly one new independently owned child opener",
  );
  const liveParent = await page
    .getByTestId("v4-composer-input")
    .locator("xpath=ancestor::*[@data-session-id][1]")
    .getAttribute("data-session-id");
  assert.ok(liveParent && liveParent !== "draft");
  const route = `omp-subagent:${actual.id}@${liveParent}`;
  const open = page.getByTestId(`v4-subagent-open-side-pane-${route}`);
  await reveal(page, open);
  assert.equal(await open.count(), 1);
  assert.equal(
    await open.locator("xpath=ancestor::*[@data-session-id][1]").getAttribute("data-session-id"),
    liveParent,
    "Failure/control detail must be attached to its own actual parent conversation",
  );
  const card = open.locator("xpath=ancestor::*[@data-tool-call-id][1]");
  assert.equal(await card.getAttribute("data-tool-call-id"), `omp-subagent:${actual.id}`);
  await eventually(
    () => card.innerText(),
    (text) => text.includes(actual.assignment),
    "The exact task result and assignment must identify the new child card",
  );
  return { name, rawId: actual.id, liveParent, route, canonicalParent: dispatch.parentId };
}
export function childTab(page, child, parentId) {
  const route = `omp-subagent:${child.rawId}@${parentId ?? child.liveParent}`;
  // 中文原因：tab 的可见标题不等于会话身份；复用真实 tab ID 的编码路由后缀。
  return page
    .locator('[data-side-pane-tab-type="subagent-session"]')
    .and(page.locator(`[data-side-pane-tab-id$=":${encodeURIComponent(route)}"]`));
}

/** Browse only the active child Pane, including collapsed history and virtualized turns. */
async function revealInPane(page, pane, target) {
  try {
    await reveal(page, target, pane);
  } catch (error) {
    // Do not dump messages, tool arguments, output or whole DOM on a failed visibility assertion.
    console.error(
      "agents detail visibility diagnostic",
      await pane.evaluate((el) => ({
        child: el.getAttribute("data-subagent-session-id"),
        tools: [...el.querySelectorAll("[data-tool-call-id]")].map((row) => ({
          id: row.getAttribute("data-tool-call-id"),
          status: row.getAttribute("data-status"),
          expanded: row
            .querySelector('[data-testid^="tool-summary-trigger-"]')
            ?.getAttribute("aria-expanded"),
        })),
        collapsedHistory: el.querySelectorAll('[data-history-open="false"]').length,
        scroll: [...el.querySelectorAll('[data-v4-timeline-scroll="true"]')].map((row) => ({
          top: row.scrollTop,
          height: row.clientHeight,
          total: row.scrollHeight,
        })),
      })),
    );
    throw error;
  }
}

export async function openChild(page, child, parentId) {
  const route = `omp-subagent:${child.rawId}@${parentId ?? child.liveParent}`;
  const open = page.getByTestId(`v4-subagent-open-side-pane-${route}`);
  await reveal(page, open);
  await open.click();
  // 切换父任务会保留其他 owner 的详情；只读取目标活动 tab。
  // 最后一个 tab 关闭后重开，展开在下一帧提交；有尺寸但 aria-hidden 的旧布局尚不可访问。
  const pane = page
    .getByRole("tabpanel")
    .and(page.locator('[data-state="active"]'))
    .locator(`[data-subagent-session-id="${route}"]`);
  await pane.waitFor({ state: "visible" });
  return pane;
}
export async function assertDetails(page, children, records, parentId, evidenceDir, phase) {
  assert.equal(children.length, 3);
  for (const child of children) {
    const source = records.children.find((item) => item.rawId === child.rawId);
    assert.equal(
      source?.model,
      child.model,
      "HTTP and persisted assistant model identities must agree",
    );
    await assertCardModel(page, child, parentId);
    const pane = await openChild(page, child, parentId);
    await assertDetailModel(pane, child);
    assert.ok(source && source.toolIds.length >= 4);
    for (const id of source.toolIds) {
      const row = pane.locator(`[data-tool-call-id="${id}"]`);
      await revealInPane(page, pane, row);
      assert.equal(await row.count(), 1, "Repeated child reads must not duplicate tool records");
      assert.equal(await row.getAttribute("data-status"), "completed");
      const toggle = row.getByTestId(`tool-summary-trigger-${id}`);
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        // 中文原因：文件写入行的摘要可视中心是文件名 chip（内层按钮），鼠标点击会打开文件预览并让
        // 子代理 Pane 失活（其对话体整段消失）；摘要展开沿用共享 expandTool 已验证的 focus + Enter。
        await toggle.focus();
        await page.keyboard.press("Enter");
      }
    }
    const ownWrite = pane.locator(`[data-tool-call-id="agents-child-${child.name}-write"]`);
    assert.ok((await ownWrite.innerText()).includes(child.name));
    const reply = pane.locator(`[data-tool-call-id="agents-child-${child.name}-reply"]`);
    await revealInPane(page, pane, reply);
    const replyToggle = reply.getByTestId(`tool-summary-trigger-agents-child-${child.name}-reply`);
    if ((await replyToggle.getAttribute("aria-expanded")) === "false") {
      await replyToggle.focus();
      await page.keyboard.press("Enter");
    }
    const replyText = reply.getByText(`AGENTS_REPLY_${child.name}`, { exact: true });
    await revealInPane(page, pane, replyText);
    // This is the actual message body sent by this child's write(agent://Main), not an
    // assistant final answer, a quoted JSON parameter, or another child's matching text.
    assert.equal(await replyText.textContent(), `AGENTS_REPLY_${child.name}`);
    assert.ok((await replyText.evaluate((el) => el.getClientRects().length)) > 0);
    assert.equal(
      (await pane.innerText()).includes("<irc"),
      false,
      "Execution details must not leak coordination envelopes",
    );
    assert.equal((await pane.innerText()).includes("Wait interrupted by message"), false);
    for (const other of children.filter((candidate) => candidate.rawId !== child.rawId))
      assert.equal(
        await pane.locator(`[data-tool-call-id="agents-child-${other.name}-write"]`).count(),
        0,
      );
    await assertReadonly(pane, /已完成|Completed/u);
    await captureIsolationScreenshot(join(evidenceDir, `agents-${phase}-detail-${child.name}.png`));
    await childTab(page, child, parentId)
      .getByRole("button", { name: /关闭|Close/u })
      .click();
    const reopened = await openChild(page, child, parentId);
    await assertDetailModel(reopened, child);
    const persistedWrite = reopened.locator(
      `[data-tool-call-id="agents-child-${child.name}-write"]`,
    );
    await revealInPane(page, reopened, persistedWrite);
    assert.equal(
      await persistedWrite.count(),
      1,
      "Closing/reopening details must neither lose nor duplicate genuine source tool IDs",
    );
    await assertReadonly(reopened, /已完成|Completed/u);
  }
}

export async function assertFailedChild(page, child, parentId) {
  const pane = await openChild(page, child, parentId);
  // 中文原因：omp 的 yield({error}) 会将子会话持久化为 aborted，并在详情显示“已取消”。
  await assertReadonly(pane, /失败|Failed|已取消|Canceled|Cancelled/u);
  const yielded = pane.locator('[data-tool-call-id="agents-child-failure-yield"]');
  await revealInPane(page, pane, yielded);
  const toggle = yielded.getByTestId("tool-summary-trigger-agents-child-failure-yield");
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    // 中文原因：同 assertDetails，摘要展开走真实控件的 focus + Enter，避免鼠标命中 chip 打开预览。
    await toggle.focus();
    await page.keyboard.press("Enter");
  }
  assert.ok(
    (await pane.innerText()).includes("AGENTS_FAILURE_ACTUAL"),
    "Failed detail must retain the actual error, not a successful substitute",
  );
  await childTab(page, child, parentId)
    .getByRole("button", { name: /关闭|Close/u })
    .click();
  await assertReadonly(
    await openChild(page, child, parentId),
    /失败|Failed|已取消|Canceled|Cancelled/u,
  );
}
