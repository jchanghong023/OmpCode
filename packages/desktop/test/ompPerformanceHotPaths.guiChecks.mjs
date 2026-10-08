import assert from "node:assert/strict";

export function codeResponseTurns(page, timeline, marker, previousTurnIds = []) {
  // 轮次 ID 不受虚拟滚动挂载数量影响；排除发送前的轮次，不能把旧回答当作新完成。
  const selector = previousTurnIds.reduce(
    (value, turnId) => `${value}:not([data-turn-id=${JSON.stringify(turnId)}])`,
    "[data-v4-turn-unit]",
  );
  return timeline.locator(selector).filter({
    has: page
      .locator('[data-row-id][class~="group/assistant-row"]')
      .filter({ hasText: `${marker}_STREAM_BEGIN` }),
  });
}

export async function readCompleteCodeLines(responseTurn) {
  // 完成标记和代码 host 先于 worker 的 Shadow DOM 发布；等待实际末行，不把暂时未渲染当作丢代码。
  await responseTurn
    .locator('[class~="group/assistant-row"] diffs-container')
    .getByText("const line080 = 80;", { exact: true })
    .first()
    .waitFor({ state: "attached" });
  return responseTurn
    .locator('[class~="group/assistant-row"] diffs-container')
    .evaluateAll(
      (nodes) =>
        nodes
          .map((node) =>
            [...(node.shadowRoot?.querySelectorAll("[data-line][data-line-index]") ?? [])].map(
              (line) => line.textContent.replace(/\r?\n$/u, ""),
            ),
          )
          .find((lines) => lines[0] === "const line001 = 1;") ?? [],
    );
}

export async function acceptedHostMigration(page, input, workspacePath, expectedDraft) {
  const taskId = await input.evaluate((element) =>
    element.closest("[data-session-id]").getAttribute("data-session-id"),
  );
  // 默认工作区与项目侧栏不是同一列表读面；沿真实 Host 服务读取权威元信息。
  const meta = await page.evaluate((params) => window.__testActions.getTaskMeta(params), {
    taskId,
    workspacePath,
  });
  assert.ok(meta?.taskIdMigration, "The real Host must persist its temporary-to-UUID relation");
  const migration = meta.taskIdMigration;
  assert.match(migration.fromTaskId, /^omp-session-/u);
  assert.equal(migration.toTaskId, taskId);
  // 不注入 migration、不调用迁移函数；旧 scope 的真实消费者必须已经读到当前 UUID 草稿。
  const restored = await page.evaluate((params) => window.__testActions.readComposerDraft(params), {
    workspacePath: meta.workspacePath,
    workspaceIdentity: meta.workspaceIdentity,
    scopeId: migration.fromTaskId,
  });
  assert.deepEqual(restored, { scopeId: taskId, text: expectedDraft });
  return migration;
}

export async function createProjectTask(page, workspacePath) {
  const observed = await page.waitForFunction((expected) => {
    const normalize = (path) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
    return [...document.querySelectorAll('[data-testid^="workspace-item-"]')]
      .map((node) => node.getAttribute("data-testid"))
      .find((id) => normalize(id.slice("workspace-item-".length)) === normalize(expected));
  }, workspacePath);
  const testId = await observed.jsonValue();
  await observed.dispose();
  const entry = page.getByTestId(testId);
  await entry.hover();
  // 顶部“新建任务”创建无项目任务；必须走指定沙箱项目的真实入口。
  await entry.getByRole("button", { name: /^(新建任务|New task)$/iu }).click();
  await page.getByTestId("composer-workspace-trigger").waitFor({ state: "visible" });
}
