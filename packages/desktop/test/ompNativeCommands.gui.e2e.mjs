/* eslint-disable max-lines -- 一个隔离桌面会话串行覆盖 native 命令与 cold 恢复，保留共享 cursor/证据顺序。 */
// N01–N06：隔离桌面的真实 composer→OMP→模型/交互回路。没有注入会话状态或假模型。
import assert from "node:assert/strict";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { nativeCommandNames } from "../../omp-agent/test/fixtures/nativeCommandFixture.mjs";

assert.equal(process.env.OMP_NATIVE_E2E, "1", "Set OMP_NATIVE_E2E=1 to opt into real GLM calls");
assert.ok(
  process.env.OMP_NATIVE_GUI_META,
  "Set OMP_NATIVE_GUI_META to this isolated launcher's metadata",
);
const meta = JSON.parse(await readFile(resolve(process.env.OMP_NATIVE_GUI_META), "utf8"));
assert.equal(meta.state, "ready", "The isolated launcher must be running");
assert.equal(meta.cdpUrl, "http://127.0.0.1:9257", "Only this task's dedicated CDP is accepted");
assert.equal(meta.workspace, join(meta.root, "workspace"));
assert.equal(meta.configRoot, join(meta.root, "omp"));
assert.ok(meta.applicationName.startsWith("OmpCode Native E2E "));
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR ?? meta.evidence;
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(["live", "capture", "cold"].includes(phase));
const scenarioNames = ["local", "models", "compact", "team", "plan"];
const scenarios = (process.env.OMP_NATIVE_GUI_SCENARIOS ?? "local,models,team,plan").split(",");
assert.ok(scenarios.every((name) => scenarioNames.includes(name)));
await mkdir(evidenceDir, { recursive: true });
const statePath = join(evidenceDir, "native-gui-state.json");
const browser = await chromium.connectOverCDP(meta.cdpUrl);
const page = browser
  .contexts()[0]
  .pages()
  .find((candidate) => candidate.url().startsWith(`${meta.rendererUrl}/`));
assert.ok(page, "Expected this worktree's isolated desktop renderer");
page.setDefaultTimeout(30_000);
// 初次错误定位在全局 default 的只读 READY 任务保留；正确项目任务使用独立 marker。
const marker = `NATIVE_GUI_PROJECT_${basename(meta.root)}`;
const evidence = [];
let current = "startup";
let state = {
  marker,
  workspace: meta.workspace,
  taskTestId: null,
  observations: [],
  passed: [],
  coverage: {},
};
const scenarioErrors = [];
let collectedHistoryRows = [];
const assistantSelector = '[data-row-id][class~="group/assistant-row"]';
const dialogSelector =
  '[data-elicitation-dialog-card="true"], [data-testid="v4-user-input-dialog"]';
const shot = (name) =>
  page.screenshot({ path: join(evidenceDir, `${phase}-${name}.png`), animations: "disabled" });
async function save() {
  state.coverage ??= {};
  for (const name of ["catalog", ...scenarioNames, "loop", "goal"]) {
    if (state.passed.includes(name))
      state.coverage[name] = { ...state.coverage[name], status: "passed" };
    else state.coverage[name] ??= { status: "not-run" };
  }
  await Promise.all([
    writeFile(statePath, JSON.stringify(state, null, 2)),
    writeFile(
      join(evidenceDir, "native-gui-coverage.json"),
      JSON.stringify(
        { taskTestId: state.taskTestId, phase, requested: scenarios, coverage: state.coverage },
        null,
        2,
      ),
    ),
  ]);
}
async function rows(after = 0) {
  // 仅读取真实助手正文；用户提示、工具参数或旧计划正文不能冒充本轮模型结果。
  return page.locator(assistantSelector).evaluateAll(
    (nodes, cursor) =>
      nodes
        .filter((node) => Number(node.getAttribute("data-row-id")) > cursor)
        .map((node) => ({
          rowId: Number(node.getAttribute("data-row-id")),
          text:
            node.querySelector('[data-conversation-selectable="true"]')?.textContent?.trim() ?? "",
        })),
    after,
  );
}
async function cursor() {
  return page
    .locator("[data-row-id]")
    .evaluateAll((nodes) =>
      Math.max(0, ...nodes.map((node) => Number(node.getAttribute("data-row-id")))),
    );
}
async function waitFor(check, label, timeout = 240_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await page.waitForTimeout(150);
  }
  throw new Error(`${label}: ${JSON.stringify((await rows()).slice(-3))}`);
}
async function idle() {
  await waitFor(
    async () =>
      !(await page.locator(dialogSelector).count()) &&
      !(await page.getByTestId("v4-stop").count()) &&
      (await page.getByTestId("v4-composer-send").first().isVisible()),
    "Expected completed/idle composer",
  );
}
async function send(text) {
  await idle();
  const after = await cursor();
  const input = page.getByTestId("v4-composer-input").first();
  await input.fill(text);
  // Slash 弹层只负责补全；Escape 保留原文并让真实 send 按钮接收它。
  await input.press("Escape");
  await page.getByTestId("v4-composer-send").first().click();
  return after;
}
async function output(after, expected, label, timeout) {
  await waitFor(
    async () => (await rows(after)).some((row) => expected.test(row.text)),
    `Missing real output: ${label}`,
    timeout,
  );
  await idle();
  const observed = (await rows(after)).filter((row) => expected.test(row.text));
  assert.ok(observed.length, `Completed output missing: ${label}`);
  state.observations.push(...observed.map((row) => ({ label, ...row })));
  evidence.push({ event: label, after, rows: observed });
  await save();
  return observed;
}
async function command(text, expected, label = text) {
  current = label;
  const after = await send(text);
  return output(after, expected, label);
}
async function dialog() {
  await waitFor(
    async () => await page.locator(dialogSelector).count(),
    "Expected native interaction",
  );
  return page.locator(dialogSelector).last();
}
async function answer(value) {
  const card = await dialog();
  const previous = await card.innerText();
  if (value === null) {
    await card.getByRole("button", { name: /^(忽略|取消|Dismiss|Cancel)$/iu }).click();
  } else if (typeof value === "boolean") {
    await card
      .getByRole("button", { name: value ? /^(确认|Confirm)$/iu : /^(拒绝|Deny)$/iu })
      .click();
  } else if (value instanceof RegExp) {
    const option = card.getByRole("option", { name: value }).first();
    if (await option.count()) await option.click();
    else await card.getByRole("button", { name: value }).first().click();
  } else {
    const field = card.locator('textarea, input[type="text"]').first();
    await field.fill(value);
    await card.getByRole("button", { name: /^(提交|Submit)$/iu }).click();
  }
  await waitFor(
    async () =>
      !(await page.locator(dialogSelector).count()) ||
      (await page.locator(dialogSelector).last().innerText()) !== previous,
    "Native dialog did not advance",
    30_000,
  );
}
async function interact(text, steps, expected, label = text) {
  current = label;
  const after = await send(text);
  for (const step of steps) await answer(step);
  if (expected) await output(after, expected, label);
  else {
    await idle();
    evidence.push({ event: label, result: "interaction completed" });
  }
  return after;
}
async function thought(expected) {
  await waitFor(
    async () =>
      (await page.getByTestId("v4-model-config").getAttribute("data-thought")) === expected,
    `Expected native model thought ${expected}`,
  );
}
async function acceptLowThought(scope) {
  await idle();
  const before = await page.getByTestId("v4-model-config").getAttribute("data-thought");
  if (before !== "low") {
    // Composer 首次提交会按产品规则选最高档；CLI --thinking low 不能替代用户的真实档位选择。
    await page.getByTestId("chat-thought-level-select-trigger").click();
    await page.getByTestId("chat-thought-level-select-item-low").click();
  }
  await thought("low");
  // 用原生本地命令承认下一次 submission 的 low 意图，不增加模型轮，也不注入配置/store。
  // 原生 formatAdvisorStatus 也可返回具名 running/paused；不能把合法状态误判成 low 未受理。
  await command(
    "/advisor status",
    /^Advisor (?:is (?:enabled|disabled)\b|"[^"]+" is (?:running|paused)\.)/iu,
    `low-thought-accepted:${scope}`,
  );
  await thought("low");
  evidence.push({ event: "thought-baseline", scope, before, accepted: "low" });
}
async function taskIdentity() {
  // 工作区侧栏可能没有 selected 样式；使用本隔离任务的唯一标题和真实 task identity。
  const task = page.locator('li[data-testid^="task-item-"]').filter({ hasText: marker });
  await task.first().waitFor({ state: "visible" });
  assert.equal(await task.count(), 1, "Expected exactly one task containing this fixture marker");
  await page.getByRole("heading").filter({ hasText: marker }).first().waitFor({ state: "visible" });
  return task.getAttribute("data-testid");
}
const normalizePath = (path) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
async function fixtureWorkspaceEntry() {
  const testId = await waitFor(
    async () =>
      page.locator('[data-testid^="workspace-item-"]').evaluateAll((nodes, expected) => {
        const normalize = (path) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
        return nodes
          .map((node) => node.getAttribute("data-testid"))
          .find((id) => normalize(id.slice("workspace-item-".length)) === normalize(expected));
      }, meta.workspace),
    "Expected --open-workspace to expose the exact isolated project",
    60_000,
  );
  return page.getByTestId(testId);
}
async function createFixtureTask() {
  current = "fixture-project-selection";
  const entry = await fixtureWorkspaceEntry();
  await entry.hover();
  await entry.getByRole("button", { name: /^(新建任务|New task)$/iu }).click();
  const composerProject = page.getByTestId("composer-workspace-trigger");
  await composerProject.waitFor({ state: "visible" });
  assert.match(
    await composerProject.innerText(),
    /workspace/iu,
    "Draft must be bound to the fixture project",
  );
  evidence.push({
    event: "fixture-project-draft",
    workspace: meta.workspace,
    workspaceTestId: await entry.getAttribute("data-testid"),
  });
  await shot("fixture-project-draft");
}
async function verifyFixtureTaskWorkspace() {
  current = "fixture-project-context";
  assert.ok(
    state.taskTestId?.startsWith("task-item-"),
    "Identify the real GUI task before checking its OMP journal",
  );
  const uuid = state.taskTestId.slice("task-item-".length);
  assert.match(uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu);
  // 原生 session header 是 GUI 提交实际进入 OMP 的目标事实；只读当前沙箱中这个稳定 UUID 的 journal。
  const journalRoot = join(meta.configRoot, "agent", "sessions");
  const journals = await waitFor(
    async () => {
      const files = await readdir(journalRoot, { recursive: true }).catch(() => []);
      const matched = files.filter((file) => basename(file).endsWith(`_${uuid}.jsonl`));
      return matched.length ? matched : false;
    },
    "Expected the GUI task's native OMP journal",
    30_000,
  );
  assert.equal(journals.length, 1, "Stable GUI task UUID must identify exactly one native journal");
  const journal = join(journalRoot, journals[0]);
  const file = await open(journal, "r");
  let header;
  try {
    const prefix = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    header = prefix
      .toString("utf8", 0, bytesRead)
      .split(/\r?\n/u)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.type === "session");
  } finally {
    await file.close();
  }
  assert.equal(header?.id, uuid, "Native OMP header must belong to the same visible GUI task");
  assert.equal(typeof header.cwd, "string");
  const actual = header.cwd;
  assert.equal(
    normalizePath(actual),
    normalizePath(meta.workspace),
    "Task must execute in the exact fixture project, never global default",
  );
  evidence.push({
    event: "fixture-project-context",
    taskTestId: state.taskTestId,
    journal,
    header: { type: header.type, id: header.id, cwd: actual },
    result: "passed",
  });
  state.workspace = actual;
  // tooltip 是装饰；已经可见时记录图像，不再用它的 hover/延迟可见性作为重复验收门禁。
  const context = page.locator("[data-workspace-context-path]");
  if (await context.isVisible().catch(() => false)) await shot("fixture-project-context");
  else await shot("fixture-project-journal");
  await save();
}
async function readyShell() {
  current = "startup-onboarding";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // 首启职业引导在应用外层遮住 composer。通过真实退出按钮记录 dismissed，避免向 store/设置注入测试状态。
    const exit = page.getByRole("button", { name: /^(退出引导|Exit onboarding)$/iu }).first();
    if (await exit.isVisible().catch(() => false)) {
      await shot("onboarding");
      await exit.click();
      evidence.push({ event: "onboarding", action: "exit" });
      await page.waitForTimeout(150);
      continue;
    }
    const skip = page.getByRole("button", { name: /^(跳过|Skip)$/iu }).first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      evidence.push({ event: "onboarding", action: "skip" });
      await page.waitForTimeout(150);
      continue;
    }
    if (
      (await page
        .getByTestId("v4-composer-input")
        .first()
        .isVisible()
        .catch(() => false)) ||
      (await page
        .getByRole("button", { name: /^(新建任务|New task)$/iu })
        .last()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.waitForTimeout(150);
  }
  throw new Error("Isolated desktop did not finish onboarding/startup");
}
async function catalog() {
  current = "catalog";
  const input = page.getByTestId("v4-composer-input").first();
  for (const name of nativeCommandNames) {
    await input.fill(`/${name}`);
    const panel = page.getByTestId("prompt-suggestion-panel");
    await panel.waitFor({ state: "visible" });
    const escaped = `/${name}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    await panel
      .getByRole("option", { name: new RegExp(`^${escaped}(?:\\s|$)`, "u") })
      .first()
      .waitFor({ state: "visible" });
    await input.press("Escape");
  }
  await input.fill("");
  await shot("catalog");
  state.passed.push("catalog");
}
async function local() {
  await acceptLowThought("local");
  await command("/team", /用法.*\/team/u, "team-usage");
  for (const [text, expected] of [
    ["/advisor status", /advisor.*disabled/iu],
    ["/advisor dump", /Advisor is not active|no advisor|no history/iu],
    ["/advisor dump raw", /Advisor is not active|no advisor|no history/iu],
    ["/advisor on", /advisor.*enabled/iu],
    ["/advisor off", /advisor.*disabled/iu],
    ["/advisor configure", /only available.*interactive TUI/iu],
    ["/loop 2", /loop.*enabled/iu],
    ["/loop", /loop.*disabled/iu],
  ])
    await command(text, expected);
  await command("/plan", /plan mode enabled/iu, "plan-enter");
  await thought("high");
  await command("/plan", /plan mode paused/iu, "plan-pause");
  await thought("low");
  await command("/plan", /plan mode disabled/iu, "plan-exit");
  await interact("/wiki", [null], undefined, "wiki-cancel");
  await interact(
    "/wiki",
    [/New document index/u, meta.workspace, "native-manual"],
    /Created document index native-manual/iu,
    "wiki-create",
  );
  await interact(
    "/wiki",
    [/New document index/u, meta.workspace, "native-manual"],
    /already exists/iu,
    "wiki-duplicate-failure",
  );
  await interact(
    "/wiki",
    [/Search document indexes/u, "NATIVE_WIKI_NEEDLE", /\[native-manual\] README\.md/u],
    /NATIVE_WIKI_NEEDLE/u,
    "wiki-search",
  );
  await interact(
    "/wiki",
    [/Delete document index/u, /native-manual/u, false],
    undefined,
    "wiki-delete-denied",
  );
  await interact(
    "/wiki",
    [/Delete document index/u, /native-manual/u, true],
    /Deleted|Removed/iu,
    "wiki-delete",
  );
  await shot("wiki-completed");
  await interact("/repo", [null], undefined, "repo-cancel");
  await interact("/repo", [/Build repository index/u, false], undefined, "repo-build-denied");
  await interact(
    "/repo",
    [/Build repository index/u, true],
    /Build repository index complete/iu,
    "repo-build",
  );
  await writeFile(
    join(meta.workspace, "sample.ts"),
    "export function nativeUpdatedAnswer() { return 43; }\n",
  );
  await interact(
    "/repo",
    [/Update repository index/u],
    /Update repository index complete/iu,
    "repo-update",
  );
  await interact(
    "/repo",
    [/Rebuild repository index/u, true],
    /Rebuild repository index complete/iu,
    "repo-rebuild",
  );
  await interact("/repo", [/Delete repository index/u, false], undefined, "repo-delete-denied");
  await interact(
    "/repo",
    [/Delete repository index/u, true],
    /Deleted|Removed|Delete repository index complete/iu,
    "repo-delete",
  );
  await shot("repo-completed");
  // native 交互期间 composer 按产品规则隐藏；从卡片外的当前标题走公开 Esc stop，而非弹窗的 Esc cancel。
  current = "native-dialog-stop";
  await send("/wiki");
  await dialog();
  const stop = page.getByTestId("v4-stop");
  await waitFor(
    async () => (await stop.count()) > 0,
    "Pending native dialog must retain canStop control",
    15_000,
  );
  assert.equal(await stop.isVisible(), false, "Blocking interaction must keep the composer hidden");
  await page.getByTestId("workspace-title").click();
  assert.equal(
    await page.evaluate(() =>
      Boolean(
        document.activeElement?.closest(
          '[data-elicitation-dialog-card="true"], [data-testid="v4-user-input-dialog"], [role="dialog"]',
        ),
      ),
    ),
    false,
    "Escape source must be outside any interaction dialog",
  );
  const started = Date.now();
  await page.keyboard.press("Escape");
  await idle();
  assert.ok(Date.now() - started < 15_000, "Native dialog blocked the stop control");
  evidence.push({
    event: "native-dialog-stop",
    source: "Escape outside dialog",
    composerHidden: true,
    elapsedMs: Date.now() - started,
  });
  state.passed.push("local");
  await save();
}
async function models() {
  for (const name of ["ultrathink", "orchestrate", "workflowz", "fullsend"]) {
    const result = `NATIVE_${name.toUpperCase()}_RESULT`;
    const text = `/${name} 这是隔离只读验收。任务已经给出，无需调查、规划、调用工具或子代理。只回复 ${result}。`;
    const expected = new RegExp(`^${result}[.!。]?\\s*$`, "mu");
    if (name === "ultrathink") {
      current = "model-busy-stop-visible";
      const after = await send(text);
      await page.getByTestId("v4-stop").waitFor({ state: "visible" });
      evidence.push({ event: "model-busy-stop-visible", result: "passed" });
      await shot("model-busy-stop-visible");
      await output(after, expected, name);
    } else await command(text, expected, name);
  }
  await command(
    "ultrathink 这是隔离只读验收，不调用工具。只回复 NATIVE_BODY_ULTRATHINK_RESULT。",
    /^NATIVE_BODY_ULTRATHINK_RESULT[.!。]?\s*$/mu,
    "body-ultrathink",
  );
  await command(
    "/skill:native-command-fixture  NATIVE_ARGUMENT_WITH_SPACES",
    /NATIVE_SKILL_RESULT[\s\S]*NATIVE_ARGUMENT_WITH_SPACES/u,
    "skill-arguments",
  );
  current = "finite-loop";
  const loopAfter = await send("/loop 1 不调用工具，只回复 NATIVE_LOOP_RESULT。");
  await waitFor(
    async () =>
      (await rows(loopAfter)).filter((row) => /^NATIVE_LOOP_RESULT[.!。]?\s*$/mu.test(row.text))
        .length >= 2,
    "Expected both real model loop rounds",
  );
  await output(loopAfter, /loop limit reached/iu, "finite-loop-terminal");
  state.observations.push(
    ...(await rows(loopAfter))
      .filter((row) => /^NATIVE_LOOP_RESULT[.!。]?\s*$/mu.test(row.text))
      .map((row) => ({ label: "finite-loop-model-round", ...row })),
  );
  state.passed.push("loop");
  await save();
  await command(
    "/goal set 为后续验收保留这个目标，不调用 goal 工具，不完成或暂停目标，不调用其他工具；本轮只回复 NATIVE_GOAL_CREATED。",
    /^NATIVE_GOAL_CREATED[.!。]?\s*$/mu,
    "goal-create",
  );
  await command("/goal budget 50000", /Goal budget set to 50000/iu, "goal-budget");
  await command("/goal show", /Objective:[\s\S]*50000/u, "goal-show");
  await command("/goal pause", /Goal mode paused/iu, "goal-pause");
  await command("/goal resume", /Goal mode resumed/iu, "goal-resume");
  await interact("/goal drop", [false], undefined, "goal-drop-denied");
  await command("/goal show", /Objective:/u, "goal-after-denial");
  await interact("/goal drop", [true], /Goal dropped/iu, "goal-drop");
  await command("/goal show", /No goal set/iu, "goal-empty");
  state.passed.push("goal");
  await save();
  await compact();
  await shot("model-lifecycle");
  state.passed.push("models");
  await save();
}
async function compact() {
  current = "compact";
  const after = await send(
    "/compact soft Preserve NATIVE_SKILL_RESULT and NATIVE_GOAL_CREATED exactly in the summary.",
  );
  // 当前 native rpc-ui 的成功终态是 command_output，不发旧 ZCode manual compact marker。
  await waitFor(
    async () => {
      const nativeRows = await rows(after);
      const failed = nativeRows.find((row) => /Compaction failed:/iu.test(row.text));
      assert.ok(!failed, `Native compact failed: ${failed?.text ?? ""}`);
      return nativeRows.some((row) => /Compaction complete\.(?:\s*Tokens:)?/iu.test(row.text));
    },
    "Expected successful native soft compaction",
    240_000,
  );
  await output(after, /Compaction complete\.(?:\s*Tokens:)?/iu, "compact-native-terminal");
  await shot("compact-completed");
  state.passed.push("compact");
  await save();
}
async function team() {
  current = "team-discussion";
  const source = await readFile(join(meta.workspace, "sample.ts"), "utf8");
  const functionName = /export function (\w+)\(/u.exec(source)?.[1];
  assert.ok(functionName, "Expected the isolated fixture's existing function");
  // 各阶段经原生 yield schema 提交；三句上限不能要求删掉必填字段，真实 schema 失败仍不算通过。
  const after = await send(
    `/team 这是极小范围的只读方案验收：保持 sample.ts 中现有导出函数 ${functionName} 名字、实现与行为原样不动，不增加或修改任何文件。只比较“保留现状”这一个方案，所有讨论和审查阶段都只读，不扩展命名或重构需求。方案正文简短，但各阶段必须通过原生 yield 提交该阶段 schema 要求的完整结构化结果，不省略必填字段。没有事实差异或需求理解差异时使用空数组，不编造差异；若有真实差异，完整填写各项必填字段（事实差异包括 topic、contradiction、proposalsInvolved、sourceToCheck）。最终给出原生选择方案报告。`,
  );
  const started = Date.now();
  const observed = await waitFor(
    async () => {
      const nativeRows = await rows(after);
      const failed = nativeRows.find((row) =>
        /team-incomplete|团队讨论未完成|team discussion incomplete/iu.test(row.text),
      );
      assert.ok(!failed, `Native team failed: ${failed?.text ?? ""}`);
      const final = nativeRows.filter((row) => /选择方案请直接回复/u.test(row.text));
      if (!final.length) return false;
      return !(await page.locator(dialogSelector).count()) &&
        !(await page.getByTestId("v4-stop").count())
        ? final
        : false;
    },
    "Expected the final native team selection report",
    600_000,
  );
  state.observations.push(...observed.map((row) => ({ label: "team-final-report", ...row })));
  evidence.push({
    event: "team-final-report",
    after,
    rows: observed,
    elapsedMs: Date.now() - started,
  });
  await shot("team-final-report");
  state.passed.push("team");
  await save();
}
async function plan() {
  await acceptLowThought("plan");
  for (const approved of [false, true]) {
    const result = approved ? "NATIVE_PLAN_APPROVED_RESULT" : "NATIVE_PLAN_DECLINED_RESULT";
    const slug = approved ? "native-approved" : "native-declined";
    const visible = `NATIVE_VISIBLE_PLAN_${approved ? "APPROVED" : "DECLINED"}`;
    current = approved ? "plan-approval" : "plan-rejection";
    const after = await send(
      `/plan 请创建一个极短的计划：计划正文包含 ${visible}，批准后不调用任何工具，只回复 ${result}。先用 write 写 local://${slug}-plan.md，再用 write 把纯文本标题 ${slug} 写入 xd://propose 提交该计划，等待用户批准，批准前不能直接回复该结果标记。`,
    );
    const card = await dialog();
    assert.match(await card.innerText(), /execute|plan|approve|计划|批准/iu);
    await thought("high");
    // 真正审批出现以后核对非用户正文；计划里面的结果标记从不计入批准后的执行断言。
    const body = await page.locator('[data-v4-timeline-scroll="true"]').innerText();
    const nonUser = await page.locator('[data-v4-timeline-scroll="true"]').evaluate((element) => {
      const copy = element.cloneNode(true);
      for (const node of copy.querySelectorAll(
        '[data-v4-user-input-bubble="true"], [data-v4-composer-dock="true"]',
      ))
        node.remove();
      return copy.textContent ?? "";
    });
    assert.ok(nonUser.includes(visible), "Plan body must be visible before approval");
    assert.ok(body.includes(visible));
    await shot(current);
    const approvalCursor = await cursor();
    await answer(approved);
    if (approved) {
      await output(
        approvalCursor,
        new RegExp(`^${result}[.!。]?\\s*$`, "mu"),
        "plan-approved-model-result",
      );
      await thought("low");
    } else {
      await idle();
      assert.ok(
        !(await rows(approvalCursor)).some((row) => row.text.includes(result)),
        "Declined plan must not execute its model continuation",
      );
      await interact("/plan", [true], /plan mode paused/iu, "declined-plan-pause");
      await command("/plan", /plan mode disabled/iu, "declined-plan-exit");
      await thought("low");
    }
    evidence.push({ event: current, approved, after, approvalCursor, planVisible: visible });
  }
  state.passed.push("plan");
  await save();
}
async function openHistoryTask() {
  state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.marker, marker, "History acceptance must reopen the same isolated fixture");
  assert.ok(state.taskTestId, "Run live acceptance before collecting its history");
  await page.getByTestId(state.taskTestId).click();
  await page.getByTestId("v4-composer-input").first().waitFor({ state: "visible" });
  await verifyFixtureTaskWorkspace();
  await idle();
}
async function collectFullAssistantHistory() {
  const scroll = page.locator('[data-v4-timeline-scroll="true"]');
  const recovered = new Map();
  let unchanged = 0;
  let previous = "";
  let complete = false;
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(250);
  // 历史由真实 timeline 的分页/虚拟列表加载；不能直接读取后端数据库替代 GUI 冷恢复。
  // rowId 仅在本次采集的进程代次内去重，不与跨 RESUME 的 observations 混合。
  for (let attempt = 0; attempt < 160; attempt++) {
    for (const row of await rows()) recovered.set(row.rowId, row.text);
    const metrics = await scroll.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      viewport: element.clientHeight,
      loadingOlder: element.getAttribute("data-loading-older") === "true",
    }));
    const signature = `${metrics.top}:${metrics.height}:${recovered.size}:${metrics.loadingOlder}`;
    unchanged = signature === previous ? unchanged + 1 : 0;
    previous = signature;
    if (metrics.top <= 1 && !metrics.loadingOlder && unchanged >= 4) {
      complete = true;
      break;
    }
    await scroll.evaluate((element) => {
      element.scrollTop = Math.max(
        0,
        element.scrollTop - Math.max(160, element.clientHeight * 0.65),
      );
    });
    await page.waitForTimeout(250);
  }
  assert.ok(complete, "Full GUI history did not reach a stable oldest page");
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await idle();
  collectedHistoryRows = [...recovered]
    .sort(([left], [right]) => left - right)
    .map(([rowId, text]) => ({ rowId, text }));
  await writeFile(
    join(evidenceDir, `${phase}-history-rows.json`),
    JSON.stringify(
      {
        taskTestId: state.taskTestId,
        rowCount: collectedHistoryRows.length,
        rows: collectedHistoryRows,
      },
      null,
      2,
    ),
  );
  return collectedHistoryRows.map((row) => row.text);
}
function observeCompletedTeam(fullLiveHistory) {
  const reportHeading =
    /^(?:##\s*)?\/team 多模型讨论(?:结果（team-result）|未完成（team-incomplete）)/u;
  const reports = fullLiveHistory.flatMap((text, index) =>
    reportHeading.test(text) ? [{ text, index }] : [],
  );
  const latest = reports.at(-1);
  assert.ok(latest, "Full GUI history must contain a native team terminal report");
  assert.match(latest.text, /^(?:##\s*)?\/team 多模型讨论结果（team-result）/u);
  assert.ok(
    latest.text.includes("选择方案请直接回复"),
    "Latest native team report must offer selection",
  );
  assert.doesNotMatch(latest.text, /team-incomplete/u);
  const previousReportIndex = reports.at(-2)?.index ?? -1;
  const progress = fullLiveHistory.slice(previousReportIndex + 1, latest.index);
  let previousPhaseIndex = -1;
  const phases = [
    "阶段一：独立调查",
    "阶段二：对齐与比较",
    "阶段三：交叉审查",
    "阶段四：修订与复核",
    "阶段五：汇总方案",
  ].map((phaseLabel) => {
    const index = progress.findIndex(
      (text, position) => position > previousPhaseIndex && text.startsWith(phaseLabel),
    );
    assert.ok(
      index >= 0,
      `Latest native team report is missing ordered GUI progress: ${phaseLabel}`,
    );
    previousPhaseIndex = index;
    return {
      phase: phaseLabel,
      historyIndex: previousReportIndex + 1 + index,
      text: progress[index],
    };
  });
  const priorCoverage = state.coverage?.team;
  const previousFailure =
    priorCoverage?.status === "failed" ? { ...priorCoverage } : priorCoverage?.previousFailure;
  const observation = {
    source: "GUI full assistant timeline",
    taskTestId: state.taskTestId,
    reportHistoryIndex: latest.index,
    report: latest.text,
    phases,
  };
  // 原等待超时仍保留；只有实际 GUI 的最新成功报告及五阶段事实才可新增迟到观察通过。
  state.coverage ??= {};
  state.coverage.team = {
    status: "passed",
    validation: "late-gui-observation",
    ...(previousFailure ? { previousFailure } : {}),
    observation,
  };
  if (!state.passed.includes("team")) state.passed.push("team");
  evidence.push({
    event: "team-late-observation",
    ...observation,
    previousFailure,
    result: "passed",
  });
}
async function capture() {
  current = "capture-live-history";
  await openHistoryTask();
  const fullLiveHistory = await collectFullAssistantHistory();
  assert.ok(fullLiveHistory.length, "Completed live history must contain assistant rows");
  if (process.env.OMP_NATIVE_GUI_OBSERVE_TEAM === "1") observeCompletedTeam(fullLiveHistory);
  for (const name of ["catalog", ...scenarioNames, "loop", "goal"])
    assert.ok(state.passed.includes(name), `Complete live ${name} acceptance before capture`);
  state.fullLiveHistory = fullLiveHistory;
  state.fullLiveHistoryCapture = { taskTestId: state.taskTestId, rowCount: fullLiveHistory.length };
  await save();
  await shot("full-live-history");
  evidence.push({
    event: current,
    taskTestId: state.taskTestId,
    checkedRows: fullLiveHistory.length,
  });
  console.log(`Captured ${fullLiveHistory.length} real GUI assistant rows for ${state.taskTestId}`);
}
async function cold() {
  current = "cold-history";
  await openHistoryTask();
  assert.ok(
    Array.isArray(state.fullLiveHistory) &&
      state.fullLiveHistory.length > 0 &&
      state.fullLiveHistory.every((text) => typeof text === "string"),
    "Run phase=capture after all live scenarios before cold acceptance",
  );
  assert.equal(state.fullLiveHistoryCapture?.taskTestId, state.taskTestId);
  assert.equal(state.fullLiveHistoryCapture?.rowCount, state.fullLiveHistory.length);
  const actual = await collectFullAssistantHistory();
  // 先保存双方原始内容与实际 DOM rowId；真实冷投影缺失不能被采集诊断或失败重试覆盖基线。
  await writeFile(
    join(evidenceDir, "cold-history-comparison.json"),
    JSON.stringify(
      {
        taskTestId: state.taskTestId,
        capture: state.fullLiveHistoryCapture,
        baseline: state.fullLiveHistory,
        actualRows: collectedHistoryRows,
        actual,
      },
      null,
      2,
    ),
  );
  // 冷恢复可重建 rowId；完整基线保留所有内容、顺序及重复次数，不能只比已观测子集。
  const normalize = (text) => text.replace(/\s+/gu, " ").trim();
  assert.deepEqual(
    actual.map(normalize),
    state.fullLiveHistory.map(normalize),
    "Cold GUI history changed content, order or duplicate counts from the full live capture",
  );
  await shot("same-task-history");
  evidence.push({
    event: "cold-history",
    taskTestId: state.taskTestId,
    checkedRows: state.fullLiveHistory.length,
    result: "passed",
  });
}
try {
  if (phase === "capture") await capture();
  else if (phase === "cold") await cold();
  else {
    await readyShell();
    if (process.env.OMP_NATIVE_GUI_RESUME === "1") {
      // OMP 计划可合法更新标题；恢复按已保存 UUID 与真实 journal cwd 确认，不依赖旧标题。
      await openHistoryTask();
      if (!state.passed.includes("catalog")) await catalog();
    } else {
      await createFixtureTask();
      const model = page.getByTestId("chat-model-select-trigger");
      await model.waitFor({ state: "visible" });
      if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
        await model.click();
        await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
        await page
          .getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash")
          .click();
      }
      await command(
        `${marker}：隔离 GUI 验收，不调用工具，只回复 NATIVE_GUI_READY。`,
        /^NATIVE_GUI_READY[.!。]?\s*$/mu,
        "fixture-ready",
      );
      state.taskTestId = await taskIdentity();
      assert.ok(state.taskTestId, "Expected selected real task identity");
      await verifyFixtureTaskWorkspace();
      await save();
      await catalog();
    }
    // 新的 live 执行会改变历史；必须在结束后重新 capture 才能建立 cold 基线。
    delete state.fullLiveHistory;
    delete state.fullLiveHistoryCapture;
    for (const name of scenarios) {
      state.passed = state.passed.filter((entry) => entry !== name);
      state.coverage ??= {};
      state.coverage[name] = { status: "running" };
      await save();
      try {
        await { local, models, compact, team, plan }[name]();
        state.coverage[name] = { status: "passed" };
      } catch (error) {
        state.coverage[name] = { status: "failed", message: String(error) };
        await save();
        if (name !== "team") throw error;
        scenarioErrors.push({ scenario: name, message: String(error) });
        await shot("team-failed");
        evidence.push({ event: "team-failed", message: String(error), result: "failed" });
        // 失败保持失败；仅通过本隔离实例的真实 stop 控件结束该轮，让后续独立场景仍可验收。
        const stop = page.getByTestId("v4-stop").first();
        if (await stop.isVisible().catch(() => false)) await stop.click();
        await idle();
      }
      await save();
    }
    await idle();
    await shot("completed");
    evidence.push({
      event: "live-completed",
      taskTestId: state.taskTestId,
      passed: state.passed,
      coverage: state.coverage,
      result: scenarioErrors.length ? "failed" : "passed",
    });
    await save();
    if (scenarioErrors.length)
      throw new Error(`Native GUI scenarios failed: ${JSON.stringify(scenarioErrors)}`);
  }
  await writeFile(
    join(evidenceDir, `${phase}-native-gui-result.json`),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `PASS native GUI ${phase}: ${phase === "cold" ? "same-task retained history" : phase === "capture" ? "same-task full live history captured" : state.passed.join(", ")}; ${evidenceDir}`,
  );
} catch (error) {
  await save();
  await shot("failure").catch(() => {});
  await writeFile(
    join(evidenceDir, `${phase}-native-gui-failure.json`),
    JSON.stringify({ current, message: String(error), evidence, state }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
