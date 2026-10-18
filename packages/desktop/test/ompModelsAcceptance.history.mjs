import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promptOf, textOf } from "./ompModelsAcceptance.fixture.mjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";

const taskRows = (page) => page.locator('li[data-testid^="task-item-"]');
export const taskIds = (page) =>
  taskRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
export async function sendTurn(page, runtime, entry, index) {
  // profile 首次草稿与冷恢复也须等真实目录/控件就绪，不能通过手选修复 retainSelection。
  const effort = page.getByTestId("chat-thought-level-select-trigger");
  await effort.waitFor({ state: "visible" });
  const trigger = page.getByTestId("chat-model-select-trigger");
  if (!entry.retainSelection) {
    await trigger.click();
    await page.getByTestId("chat-model-select-group-omp-provider:zcode-mock").hover();
    await page.getByTestId(`chat-model-select-item-custom:zcode-mock:${entry.model}`).click();
  }
  const names =
    runtime.phase === "profile"
      ? runtime.acceptance.profileModelNames
      : runtime.acceptance.defaultModelNames;
  assert.equal(
    await trigger.getAttribute("aria-label"),
    `zcode-mock/${names[entry.model === "scripted" ? 0 : 1]}`,
  );
  if (entry.afterSwitch) {
    assert.equal(
      await effort.getAttribute("aria-label"),
      entry.afterSwitch === "high" ? "高" : "最高",
      "Manually selecting a Composer model must initialize its highest supported effort",
    );
  }
  if (entry.retainSelection) {
    // 新建 profile 与冷恢复也必须直接读取 Composer 初值；不通过手选模型/档位修复待验收状态。
    // 同进程 HOLD 则继续证明用户单独选择的 High 不被同模型续发重置到 Max。
    assert.equal(
      await effort.getAttribute("aria-label"),
      entry.effort === "max" ? "最高" : "高",
      "Untouched Composer selection must retain the expected initial or conversation-restored effort",
    );
  } else {
    await effort.click();
    await page.getByTestId(`chat-thought-level-select-item-${entry.effort}`).click();
  }
  assert.equal(await effort.getAttribute("aria-label"), entry.effort === "max" ? "最高" : "高");
  await page.getByTestId("v4-composer-input").fill(entry.prompt);
  await page.getByTestId("v4-composer-send").click();
  await page.getByText(entry.reply, { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
  await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  const diagnostics = await readDiagnostics(runtime);
  assert.equal(
    diagnostics.calls.length,
    index + 1,
    "Exactly one HTTP request per explicit user turn",
  );
  const call = diagnostics.calls[index];
  assert.equal(call.model, entry.model);
  assert.equal(call.completed, true);
  assert.equal(call.aborted, false);
  // Anthropic budget/effort 的实际请求字段，不以模型脚本回显证明档位。
  assert.equal(call.thinking?.type, "enabled");
  assert.equal(call.outputConfig?.effort, entry.effort);
  const users = call.messages.filter((message) => message.role === "user");
  assert.equal(promptOf(users.at(-1)?.content), entry.prompt);
}
export async function readDiagnostics(runtime) {
  const response = await fetch(runtime.mock.diagnosticsUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.ok(Array.isArray(data.calls));
  return data;
}
export async function assertNoReplay(runtime) {
  assert.equal(
    (await readDiagnostics(runtime)).calls.length,
    0,
    "Opening or recovering history must not call the model",
  );
}
async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)],
    ),
  );
  return nested.flat();
}
export async function storedConversation(agent, taskId, turns) {
  const id = taskId.replace(/^task-item-/u, "");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu);
  const files = (await filesBelow(join(agent, "sessions"))).filter((file) =>
    file.endsWith(".jsonl"),
  );
  const candidates = [];
  for (const path of files) {
    const rows = (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (rows.some((row) => row.type === "session" && row.id === id))
      candidates.push({ path, rows });
  }
  assert.equal(candidates.length, 1, "One actual OMP session file must own this GUI UUID");
  const { path, rows } = candidates[0];
  // 保存完整消息行（包括身份、顺序和终态），不能只比较文件地址与会话 UUID。
  const records = rows.filter((row) => row.type === "message");
  const messages = records.map((row) => row.message);
  assert.equal(
    messages.length,
    turns.length * 2,
    "Each explicit turn persists exactly one user and one assistant message",
  );
  for (const [index, turn] of turns.entries()) {
    assert.equal(messages[index * 2].role, "user");
    assert.equal(promptOf(messages[index * 2].content), turn.prompt);
    assert.equal(messages[index * 2 + 1].role, "assistant");
    assert.equal(textOf(messages[index * 2 + 1].content), turn.reply);
    assert.equal(
      messages.filter(
        (message) => message.role === "user" && promptOf(message.content) === turn.prompt,
      ).length,
      1,
    );
    assert.equal(
      messages.filter(
        (message) => message.role === "assistant" && textOf(message.content) === turn.reply,
      ).length,
      1,
    );
  }
  return { path, id, records };
}
export async function assertReplies(page, turns) {
  for (const turn of turns) {
    const reply = page.getByText(turn.reply, { exact: true });
    // 虚拟列表可能已卸载旧回复：先真实滚动挂载，再验证可见性，不能只滚动不存在的节点。
    await reveal(page, reply);
    await reply.waitFor({ state: "visible" });
    assert.equal(await reply.count(), 1, "Recovery must not duplicate assistant messages");
  }
}
async function assertTaskTitle(task, title) {
  await task.waitFor({ state: "visible" });
  assert.equal(await task.count(), 1, "One real UUID must identify exactly one task row");
  const original = task.locator('[data-task-title-copy="original"]');
  await original.waitFor({ state: "visible" });
  assert.equal(await original.count(), 1, "Each task must expose exactly one original title");
  assert.equal(await original.innerText(), title);
}

const groupedTaskOf = (page, taskId) =>
  page.locator(`[data-grouped-task-key$="%00${taskId.replace(/^task-item-/u, "")}"]`);

export async function organizeTask(page, taskId, marker) {
  const title = `Models default ${marker}`;
  const groupName = `Models group ${marker}`;
  const task = page.getByTestId(taskId);
  await task.click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名任务", exact: true });
  await rename.getByPlaceholder("任务名称", { exact: true }).fill(title);
  await rename.getByRole("button", { name: "确认", exact: true }).click();
  await rename.waitFor({ state: "hidden" });
  await assertTaskTitle(task, title);
  await page.getByRole("tab", { name: "分组", exact: true }).click();
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  const groupInput = page.locator("[data-grouped-group-item-id] input");
  const newGroup = page
    .locator("[data-grouped-group-item-id]")
    .filter({ has: page.locator("input") });
  await groupInput.waitFor({ state: "visible" });
  assert.equal(await groupInput.count(), 1, "Exactly one new group must be in inline naming");
  assert.equal(await newGroup.count(), 1, "The naming input must belong to one real group");
  const groupId = await newGroup.getAttribute("data-grouped-group-item-id");
  assert.ok(groupId, "The created group must expose its real persisted identity");
  await groupInput.fill(groupName);
  await groupInput.press("Enter");
  await groupInput.waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  const groupedTask = groupedTaskOf(page, taskId);
  await groupedTask.click({ button: "right" });
  await page.getByRole("menuitem", { name: "移动到分组", exact: true }).hover();
  await page.getByRole("menuitem", { name: groupName, exact: true }).click();
  const group = page.locator(`[data-grouped-group-item-id="${groupId}"]`);
  await groupedTaskOf(group, taskId).waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "项目", exact: true }).click();
  await task.click({ button: "right" });
  await page.getByRole("menuitem", { name: "置顶任务", exact: true }).click();
  const organization = { title, groupName, groupId };
  await assertOrganization(page, taskId, organization);
  return organization;
}
export async function assertOrganization(page, taskId, organization) {
  const task = page.getByTestId(taskId);
  await assertTaskTitle(task, organization.title);
  // 置顶是全局区的独占展示；先验证其恢复，再临时取消置顶观察原分组，不改分组事实。
  await task.click({ button: "right" });
  await page.getByRole("menuitem", { name: "取消置顶任务", exact: true }).click();
  await page.getByRole("tab", { name: "分组", exact: true }).click();
  const group = page.locator(`[data-grouped-group-item-id="${organization.groupId}"]`);
  await group.getByRole("button", { name: organization.groupName, exact: true }).waitFor({
    state: "visible",
  });
  const groupedTask = groupedTaskOf(group, taskId);
  await assertTaskTitle(groupedTask, organization.title);
  assert.equal(await groupedTask.count(), 1, "The same UUID must retain its original group");
  await page.getByRole("tab", { name: "项目", exact: true }).click();
  await task.click({ button: "right" });
  await page.getByRole("menuitem", { name: "置顶任务", exact: true }).click();
  await task.click({ button: "right" });
  await page.getByRole("menuitem", { name: "取消置顶任务", exact: true }).waitFor({
    state: "visible",
  });
  await page.keyboard.press("Escape");
}
