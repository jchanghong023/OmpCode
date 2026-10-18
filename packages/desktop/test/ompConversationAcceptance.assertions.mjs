import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { C, latestInput, promptOf, textOf } from "./ompConversationAcceptance.fixture.mjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";

export async function poll(read, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
export async function diagnostics(runtime) {
  const response = await fetch(runtime.mock.diagnosticsUrl, { signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(value.baseUrl, runtime.mock.baseUrl);
  assert.ok(Array.isArray(value.calls));
  assert.ok(value.acceptance && Number.isInteger(value.acceptance.cursor));
  for (const call of value.calls) {
    assert.ok(Array.isArray(call.messages) && call.messages.length > 0);
    assert.ok(typeof call.requestId === "string" && call.requestId.length > 0);
    assert.equal(typeof call.aborted, "boolean");
    assert.equal(typeof call.completed, "boolean");
  }
  return value;
}
export async function release(runtime, name) {
  await poll(
    () => diagnostics(runtime),
    (value) => value.acceptance.barriers[name] === "waiting",
    `model barrier ${name}`,
  );
  const response = await fetch(runtime.mock.controlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "release", name }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  await poll(
    () => diagnostics(runtime),
    (value) => value.acceptance.barriers[name] === "released",
    `released model barrier ${name}`,
  );
}
export async function submit(page, prompt, running = false) {
  await page.getByTestId("v4-composer-input").fill(prompt);
  // 编辑器可填写早于异步模型目录/完整 Submission 就绪；只等真实控件，不重填或重提。
  const send = page.getByTestId("v4-composer-send");
  await send.waitFor({ state: "visible" });
  await poll(
    () => send.isEnabled(),
    (enabled) => enabled,
    `Composer must accept ${running ? "running" : "idle"} input`,
  );
  await send.click();
}
export async function timelineOccurrences(page, marker) {
  assert.ok(marker.length > 0, "A timeline sentinel must not be empty");
  const timeline = page.getByTestId("v4-timeline").first();
  await timeline.waitFor({ state: "visible" });
  return (await timeline.innerText()).split(marker).length - 1;
}
export async function reply(page, marker) {
  // 流式多段正文可合并到同一 Markdown 节点；只约束真实时间线文本，不要求哨兵独占 DOM。
  const timeline = page.getByTestId("v4-timeline").first();
  const target = timeline.getByText(marker, { exact: false }).first();
  const confirm = (timeout) =>
    poll(
      () => timelineOccurrences(page, marker),
      (count) => count === 1,
      `${marker} appears exactly once in timeline text`,
      timeout,
    );
  try {
    await reveal(page, target);
    await target.waitFor({ state: "visible", timeout: 15_000 });
    await confirm(20_000);
    return;
  } catch (error) {
    // 隔离 GUI 实测：长会话跑完后旧轮次行会离开时间线窗口，出现后又被贴底滚动顶回，
    // 断言就只剩超时（innerText 完全不含旧哨兵）。实测把时间线滚到顶部能让旧行重新
    // 挂载并稳定命中一次；只作为失败后的一次兜底，不影响正常贴近底部的近期轮次。
    if (!(await timeline.count())) throw error;
    await timeline.evaluate((element) => {
      element.scrollTop = 0;
    });
  }
  await reveal(page, target);
  await target.waitFor({ state: "visible", timeout: 60_000 });
  await confirm(60_000);
}
export async function idle(page) {
  await page.getByTestId("v4-stop").waitFor({ state: "hidden" });
  await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  // 空闲且草稿已清空时发送键本来就禁用；可继续输入才是下一轮的 actionability。
  await poll(
    () => page.getByTestId("v4-composer-input").isEditable(),
    (editable) => editable,
    "Idle composer must accept the next draft",
  );
}
export const taskIds = (page) =>
  page
    .locator('li[data-testid^="task-item-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
export async function sameTask(page, expected) {
  assert.deepEqual(
    await taskIds(page),
    [expected],
    "All scenarios must remain in the same real conversation",
  );
}
export async function setInputMode(page, mode) {
  const label = mode === "guide" ? /^(?:引导|Guide)$/u : /^(?:队列|Queue)$/u;
  const [taskId] = await taskIds(page);
  assert.ok(taskId, "Mode selection must start from an existing real conversation");
  await sameTask(page, taskId);
  // 交互行为由应用设置统一持有，Composer 不提供局部模式开关。
  await page
    .getByRole("button", { name: /^(?:设置|Settings)$/u })
    .last()
    .click();
  const settings = page.getByTestId("settings-page");
  await settings.getByRole("button", { name: /^(?:常规|General)$/u }).click();
  // SettingsRow 的文字标签未关联 aria-label；从真实标签所在行定位无名称 combobox。
  const field = settings.getByText(/^(?:交互行为|Interaction behavior)$/u);
  const trigger = field.locator("../..").getByRole("combobox");
  await trigger.click();
  await page.getByRole("option", { name: label }).click();
  // 以显示文本而非 accessible name 核对选择，再重开确认实际选中项。
  await trigger.filter({ hasText: label }).click();
  await poll(
    () => page.getByRole("option", { name: label }).getAttribute("aria-selected"),
    (selected) => selected === "true",
    "Actual GUI selection must commit the requested input mode",
  );
  await page.keyboard.press("Escape");
  // 设置是完整页面而非 Dialog；关闭下拉后必须通过返回按钮回到原会话。
  await settings.getByTestId("settings-back-button").click();
  await settings.waitFor({ state: "hidden" });
  await page.getByTestId("v4-composer-input").waitFor({ state: "visible" });
  await sameTask(page, taskId);
}
export async function exerciseGuideInputs(page, runtime, screenshot) {
  await setInputMode(page, "guide");
  await submit(page, C.guide);
  await reply(page, "GUIDE_BASE_PREFIX");
  const calls = (await diagnostics(runtime)).calls.length;
  const rows = page
    .getByTestId("v4-timeline")
    .first()
    .locator("[data-row-id]")
    .filter({
      has: page.locator('[data-v4-user-input-bubble="true"]').getByText(C.guideInput, {
        exact: true,
      }),
    });
  const identities = [];
  for (let n = 1; n <= 3; n++) {
    await submit(page, C.guideInput, true);
    const current = await poll(
      () => rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-row-id"))),
      (ids) => ids.length === n,
      `${n} independent guide input rows`,
    );
    assert.ok(
      current.every((id) => id && id.trim()),
      "Guide inputs need real row identities",
    );
    assert.deepEqual(current.slice(0, n - 1), identities, "Guide identities must remain stable");
    identities.push(current.at(-1));
    assert.equal(new Set(identities).size, n, "Equal guide text cannot collapse identities");
  }
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    calls,
    "Guide inputs must wait for the actual OMP consumption boundary",
  );
  await screenshot("three-independent-guide-inputs");
  await release(runtime, "guide-base");
  for (let n = 1; n <= 3; n++) {
    await reply(page, `GUIDE_INPUT_${n}_STARTED`);
    const current = await diagnostics(runtime);
    assert.equal(current.calls.length, calls + n, "One guide consumption means one HTTP request");
    const call = current.calls.at(-1);
    assert.equal(call.completed, false, "Observe guide consumption before releasing its response");
    assert.equal(
      call.messages.filter(
        (message) => message.role === "user" && promptOf(message.content).endsWith(C.guideInput),
      ).length,
      n,
      "Each model boundary must consume exactly one of the independent same-text guide inputs",
    );
    await release(runtime, `guide-input-${n}`);
    await reply(page, `GUIDE_INPUT_${n}_DONE`);
  }
  await reply(page, "GUIDE_INPUT_CONSUMED");
  await idle(page);
  assert.equal((await diagnostics(runtime)).calls.length, calls + 3);
}
// 面板外壳是 div，QueueRow 本体是 li；只取行身份，排除同属性的操作按钮。
export const queueRows = (page) => page.getByTestId("v4-queue").locator("li[data-queue-item-id]");
export async function queued(page, count, expectedIds) {
  const rows = queueRows(page);
  await poll(
    () => rows.count(),
    (actual) => actual === count,
    `exactly ${count} queued inputs`,
  );
  const result = [];
  for (const row of await rows.all()) {
    const id = await row.getAttribute("data-queue-item-id");
    assert.ok(id && id.trim(), "Each waiting item needs its own stable DOM command identity");
    result.push(id);
  }
  assert.equal(new Set(result).size, count, "Equal text cannot collapse queue identities");
  if (expectedIds)
    assert.deepEqual(result, expectedIds, "A single consumption removes only the oldest identity");
  return result;
}
export async function upload(page, paths) {
  // 桌面端平台的附件入口是原生文件对话框：desktopPlatform.canSelectFilePath=true →
  // renderer 走 platform.selectFiles() → main dialog.showOpenDialog，Playwright 既驱动不了
  // 原生对话框，也收不到 filechooser 事件；且真实入口按钮是 testid=chat-attachment-button
  // （aria「添加上下文」）展开菜单里的「附件」项，不存在名为「添加附件」的按钮。
  // 隔离 GUI 实测：把真实字节写入 Composer 的隐藏 file input（产品 web 回退路径
  // handleAttachmentInputChange）后，附件 chip、上传与发送都走真实产品链路（2026-10-18 已验证）。
  await page.getByTestId("v4-composer").locator('input[type="file"]').setInputFiles(paths);
}
export async function stopRequest(page, runtime, prompt, barrierName, forbidden) {
  const before = await diagnostics(runtime);
  const matching = before.calls.filter(
    (call) => promptOf(latestInput(call.messages)?.content) === prompt,
  );
  assert.equal(matching.length, 1);
  assert.equal(matching[0].completed, false, "Stop must target a genuinely streaming HTTP request");
  assert.equal(matching[0].aborted, false);
  await page.getByTestId("v4-stop").click();
  await idle(page);
  await poll(
    () => diagnostics(runtime),
    (value) => {
      const call = value.calls.find((entry) => entry.requestId === matching[0].requestId);
      return call?.aborted === true;
    },
    "actual HTTP request cancellation",
  );
  await release(runtime, barrierName);
  assert.equal(
    await timelineOccurrences(page, forbidden),
    0,
    "Late text must not be appended to an existing response node",
  );
  const after = await diagnostics(runtime);
  assert.equal(
    after.calls.length,
    before.calls.length,
    "Stop/release must not spawn another model request",
  );
  return matching[0].requestId;
}
export function failureOutput(state, id) {
  const results = state.calls.flatMap((call) => {
    const last = call.messages.at(-1);
    return last?.role === "user" && Array.isArray(last.content)
      ? last.content.filter((block) => block.type === "tool_result" && block.tool_use_id === id)
      : [];
  });
  assert.equal(results.length, 1, "Exactly one HTTP follow-up must carry the actual tool failure");
  assert.equal(results[0].is_error, true);
  const output = textOf(results[0].content);
  assert.ok(output.trim(), "An empty tool result cannot prove failure");
  return output;
}
export async function failureTool(page, id, expectedOutput) {
  const block = page.locator(`[data-tool-call-id="${id}"]`);
  await reveal(page, block);
  assert.equal(await block.count(), 1);
  const status = await block.getAttribute("data-status");
  assert.ok(
    ["error", "failed", "completedError"].includes(status),
    `Actual failure must not be rendered successful: ${status}`,
  );
  // Read 失败沿产品状态 tooltip 呈现，不要求为验收增加默认展开正文。
  await block.getByText(/^(?:执行失败|Failed)$/u, { exact: true }).hover();
  const tooltip = page.getByRole("tooltip");
  await tooltip.waitFor({ state: "visible" });
  const normalized = (value) => value.replace(/\s+/gu, " ").trim();
  const firstLine = expectedOutput.split(/\r?\n/u)[0];
  assert.ok(
    normalized(await tooltip.innerText()).includes(normalized(firstLine)),
    "Failure tooltip must show the actual correlated error; full result is checked on wire and disk",
  );
}
async function jsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? jsonlFiles(join(directory, entry.name))
        : entry.name.endsWith(".jsonl")
          ? [join(directory, entry.name)]
          : [],
    ),
  );
  return nested.flat();
}
export async function stored(runtime, taskId, previous) {
  const uuid = taskId.slice("task-item-".length);
  const paths = (await jsonlFiles(join(runtime.configRoot, "agent", "sessions"))).filter((path) =>
    basename(path).endsWith(`_${uuid}.jsonl`),
  );
  assert.equal(paths.length, 1, "Find exactly one real persisted parent conversation");
  const entries = (await readFile(paths[0], "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(entries.find((entry) => entry.type === "session")?.id, uuid);
  const records = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.ok(records.length > 0, "An empty session cannot satisfy recovery");
  if (previous) {
    assert.equal(paths[0], previous.path);
    assert.deepEqual(
      records,
      previous.records,
      "Opening cold history must not rewrite or append conversation facts",
    );
  }
  return { path: paths[0], entries, records };
}
// 拆分超 400 行：assertPersistedHistory 机械迁移至 historyAssertions.mjs，导出面不变。
export { assertPersistedHistory } from "./ompConversationAcceptance.historyAssertions.mjs";
