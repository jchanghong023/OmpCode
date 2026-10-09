// 主会话、三个子代理详情、Agent 交互页的真实联合验收；只使用专用隔离 fixture。
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createProjectTask } from "./ompPerformanceHotPaths.guiChecks.mjs";
import { snapshot } from "../../../scripts/test-gates-process.mjs";
import { calls, children, terminal } from "./ompExecutionPages.guiHistory.mjs";

const runtimePath = process.env.OMP_E2E_RUNTIME_MANIFEST;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(runtimePath && evidenceDir);
assert.ok(["live", "cold", "saved"].includes(phase));
const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
assert.ok(isAbsolute(runtime.root ?? runtime.runRoot));
assert.equal(dirname(resolve(runtime.root ?? runtime.runRoot)), resolve(tmpdir()));
assert.ok(!["9229", "9230"].includes(new URL(runtime.endpoint).port));
assert.ok(runtime.workspace && runtime.configRoot && runtime.electronPid);
const source = await snapshot();
assert.deepEqual(source, runtime.source, "Rebuild and launch the current source snapshot");
await mkdir(evidenceDir, { recursive: true });
const recordPath = join(runtime.evidence, "execution-pages-session.json");
const prompt =
  "分配3个子代理，让他们分别创建一个文件，名称为 a-c。内容是a-c，分配任务后，给他们发广播，让他们返回hello";
const browser = await chromium.connectOverCDP(runtime.endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find((page) => page.url().startsWith(runtime.rendererUrl));
assert.ok(page, "Use only this fixture's renderer");
page.setDefaultTimeout(30_000);
const evidence = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const shot = (name) =>
  page.screenshot({ path: join(evidenceDir, `${phase}-${name}.png`), animations: "disabled" });
const parent = page.getByTestId("v4-timeline").first();
const noGuidance = (text) =>
  assert.doesNotMatch(
    text,
    /Incoming IRC message from|Sent while waiting\/working|No one replies on your behalf|Resume your work using|<system-notice>|<irc from=|\[Wait interrupted by message\]/u,
  );
const entries = async (path) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function findSessionPaths(directory) {
  const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const parts = await Promise.all(
    files.map((item) =>
      item.isDirectory()
        ? findSessionPaths(join(directory, item.name))
        : item.name.endsWith(".jsonl")
          ? [join(directory, item.name)]
          : [],
    ),
  );
  return parts.flat();
}
async function expand(scope) {
  for (const button of await scope
    .locator('[data-testid^="chat-assistant-history-trigger-"]:visible')
    .all())
    if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
}
async function openInteractions() {
  const expand = page.getByRole("button", { name: "展开状态", exact: true });
  if (await expand.isVisible()) await expand.click();
  const section = page.locator('[data-status-section-trigger="agent"]');
  if ((await section.count()) && (await section.getAttribute("aria-expanded")) !== "true")
    await section.click();
  await page.getByTestId("omp-agent-interactions-open").first().click();
  await page.getByTestId("omp-agent-interactions").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "Agent 交互", exact: true }).click();
}
let session;
try {
  if (phase === "live") {
    const onboarding = page.getByRole("button", { name: "退出引导", exact: true });
    await onboarding
      .or(page.locator('[data-testid^="workspace-item-"]').first())
      .first()
      .waitFor({ state: "visible" });
    if (await onboarding.isVisible()) await onboarding.click();
    const before = new Set(await findSessionPaths(join(runtime.configRoot, "agent/sessions")));
    await createProjectTask(page, runtime.workspace);
    const model = page.getByTestId("chat-model-select-trigger").first();
    if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
      await model.click();
      await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
      await page
        .getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash")
        .click();
    }
    await page.getByTestId("chat-thought-level-select-trigger").first().click();
    await page.getByTestId("chat-thought-level-select-item-low").click();
    await page.getByTestId("v4-composer-input").first().fill(prompt);
    await page.getByTestId("v4-composer-send").first().click();
    console.log("GUI: exact prompt submitted in isolated project");
    const deadline = Date.now() + 300_000;
    let path;
    let runningCaptured = false;
    while (Date.now() < deadline) {
      if (!path) {
        for (const candidate of await findSessionPaths(
          join(runtime.configRoot, "agent/sessions"),
        )) {
          if (before.has(candidate)) continue;
          const record = await entries(candidate);
          if (
            record.some(
              (entry) =>
                entry.message?.role === "user" &&
                JSON.stringify(entry.message.content).includes(prompt),
            )
          ) {
            path = candidate;
            break;
          }
        }
      }
      if (path) {
        const root = await entries(path);
        const ids = children(root);
        if (
          !runningCaptured &&
          ids.length === 3 &&
          (await page.locator('[data-testid^="v4-subagent-open-side-pane-"]').count()) === 3
        ) {
          await shot("main-running");
          runningCaptured = true;
          console.log("GUI: observed three real subagent identities");
        }
        if (ids.length === 3 && terminal(root)) {
          const stem = path.slice(0, -6);
          const done = await Promise.all(
            ids.map(async (id) => terminal(await entries(join(stem, `${id}.jsonl`)))),
          );
          const count = await page
            .getByTestId("chat-summary-panel")
            .getAttribute("data-running-agent-count");
          // 文本 stop 之后核心还可能消费已排队的后台结果；等公开输入区退出运行态。
          if (
            done.every(Boolean) &&
            count === "0" &&
            !(await parent.getByRole("button", { name: "停止生成", exact: true }).isVisible())
          ) {
            session = {
              path,
              ids,
              sessionId: basename(path)
                .replace(/^.*_/u, "")
                .replace(/\.jsonl$/u, ""),
              workspace: runtime.workspace,
            };
            await writeFile(recordPath, JSON.stringify(session, null, 2));
            break;
          }
        }
      }
      await page.waitForTimeout(250);
    }
    assert.ok(session, "Core files and visible running count must both settle");
  } else {
    session = JSON.parse(await readFile(recordPath, "utf8"));
    assert.ok(session?.path);
    await page.getByTestId(`task-item-${session.sessionId}`).click();
  }
  // 持久事实绑定真实文件 UUID；实时详情路由遵循当前页面的会话 owner（可能仍是临时别名）。
  session.sessionId = basename(session.path)
    .replace(/^.*_/u, "")
    .replace(/\.jsonl$/u, "");
  const root = await entries(session.path);
  const viewSessionId = await parent.evaluate((element) =>
    element.closest("[data-session-id]").getAttribute("data-session-id"),
  );
  assert.match(viewSessionId, /^[A-Za-z0-9_-]+$/u);
  assert.ok(terminal(root));
  assert.equal(session.ids.length, 3);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="chat-summary-panel"]')
        ?.getAttribute("data-running-agent-count") === "0",
  );
  await expand(parent);
  noGuidance(await parent.innerText());
  assert.doesNotMatch(await parent.innerText(), /工作中/u);
  for (const call of calls(root).filter((call) => call.name !== "task")) {
    const tool = parent.getByTestId(`tool-summary-trigger-${call.id}`);
    await tool.waitFor({ state: "visible" });
    assert.equal(await tool.locator(".animate-spin").count(), 0);
  }
  const final = root
    .filter((e) => e.message?.role === "assistant" && e.message.stopReason === "stop")
    .at(-1)
    .message.content.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const visibleText = (await parent.innerText()).replace(/\s+/gu, " ");
  const finalLines = final
    .replace(/\*\*|__|`/gu, "")
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gmu, "")
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of finalLines)
    assert.ok(
      visibleText.includes(line.replace(/\s+/gu, " ")),
      `Final response must be visibly rendered: ${line}`,
    );
  await parent
    .getByText(finalLines[0], { exact: false })
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await shot("main-completed");
  evidence.push({
    page: "main",
    running: 0,
    finalPresent: true,
    toolCalls: calls(root).map((call) => ({ id: call.id, name: call.name })),
  });
  const written = new Set();
  for (const id of session.ids) {
    assert.match(id, /^[A-Za-z0-9_-]{1,100}$/u);
    const record = await entries(join(session.path.slice(0, -6), `${id}.jsonl`));
    assert.ok(terminal(record), `Actual persisted execution for ${id} must be terminal`);
    for (const entry of record)
      if (entry.message?.role === "assistant") {
        assert.equal(entry.message.provider, "zhipu-coding-plan");
        assert.equal(entry.message.model, "glm-5.3-flash");
      }
    const address = `omp-subagent:${id}@${viewSessionId}`;
    await parent.getByTestId(`v4-subagent-open-side-pane-${address}`).click();
    const pane = page.locator(`[data-subagent-session-id="${address}"]:visible`);
    await pane.waitFor({ state: "visible" });
    await pane.locator('[data-subagent-control-state="success"]').waitFor({ state: "visible" });
    assert.ok(await pane.getByRole("button", { name: "停止", exact: true }).isDisabled());
    assert.ok(await pane.getByPlaceholder("向该子代理发送消息…").isDisabled());
    const expected = calls(record);
    // 父状态先到、子详情异步到达；新挂载的历史折叠区也必须经公开入口展开。
    const historyDeadline = Date.now() + 30_000;
    let historyVisible = false;
    while (Date.now() < historyDeadline) {
      await expand(pane);
      const visible = await Promise.all(
        expected.map((call) => pane.getByTestId(`tool-summary-trigger-${call.id}`).isVisible()),
      );
      if (visible.every(Boolean)) {
        historyVisible = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    assert.ok(historyVisible, `Every recorded tool in ${id} must be readable`);
    noGuidance(await pane.innerText());
    for (const call of expected) {
      await pane.getByTestId(`tool-summary-trigger-${call.id}`).waitFor({ state: "visible" });
      assert.equal(
        await pane.getByTestId(`tool-summary-trigger-${call.id}`).locator(".animate-spin").count(),
        0,
      );
    }
    const filesystemCalls = expected.filter(
      (call) =>
        call.name === "write" &&
        typeof call.arguments?.path === "string" &&
        !call.arguments.path.includes("://"),
    );
    assert.equal(filesystemCalls.length, 1);
    const file = basename(filesystemCalls[0].arguments.path);
    assert.ok(["a", "b", "c"].includes(file));
    written.add(file);
    assert.equal((await readFile(join(runtime.workspace, file), "utf8")).trimEnd(), file);
    // 用户上滚才解除自动跟随；仅 scrollIntoView 属于程序定位，不能模拟阅读意图。
    const timeline = pane.locator("[data-v4-timeline-scroll]");
    await timeline.hover();
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(250);
    await pane
      .getByTestId(`tool-summary-trigger-${filesystemCalls[0].id}`)
      .scrollIntoViewIfNeeded();
    await pane.screenshot({
      path: join(evidenceDir, `${phase}-child-${file}.png`),
      animations: "disabled",
    });
    evidence.push({
      page: `child-${file}`,
      id,
      address,
      tools: expected.map((call) => ({ id: call.id, name: call.name })),
      state: "success",
      readOnly: true,
    });
    console.log(
      `GUI: ${id} complete tool history, identity, terminal state and read-only controls verified`,
    );
    // Keep the public scroll position while the opened view receives normal repeat reads.
    const before = await pane
      .getByTestId(`tool-summary-trigger-${filesystemCalls[0].id}`)
      .boundingBox();
    await page.waitForTimeout(1800);
    const after = await pane
      .getByTestId(`tool-summary-trigger-${filesystemCalls[0].id}`)
      .boundingBox();
    assert.ok(
      before && after && Math.abs(before.y - after.y) < 3,
      "Repeat observation must preserve the user's reading position",
    );
  }
  assert.deepEqual([...written].sort(), ["a", "b", "c"]);
  await openInteractions();
  const view = page.getByTestId("omp-agent-interactions");
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[data-testid="omp-agent-interactions"]')
          ?.getAttribute("data-node-count"),
      ) === 4,
  );
  const nodes = await view
    .locator("[data-agent-id]")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({ id: n.getAttribute("data-agent-id"), text: n.textContent })),
    );
  for (const id of session.ids)
    assert.match(nodes.find((node) => node.id === id)?.text ?? "", /已完成|成功/u);
  const search = page.getByTestId("omp-agent-interactions-search");
  await search.fill("hello");
  await page.waitForTimeout(500);
  const messages = await view.getByTestId("omp-agent-interaction-message").evaluateAll((nodes) =>
    nodes
      .filter((n) => n.getAttribute("data-kind") === "message")
      .map((n) => ({
        id: n.getAttribute("data-message-id"),
        from: n.getAttribute("data-from"),
        to: n.getAttribute("data-to"),
        text: n.textContent,
      })),
  );
  for (const id of session.ids)
    assert.ok(
      messages.some(
        (message) => message.from === "main" && message.to === id && message.text.includes("hello"),
      ),
      `Broadcast to ${id} must have a visible actual observation`,
    );
  assert.ok(
    messages.every((message) => message.id),
    "Every message must have its actual ID",
  );
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
  const broadcast = messages.find(
    (message) => message.from === "main" && message.to === session.ids[0],
  );
  await view
    .locator(`[data-testid="omp-agent-interaction-message"][data-message-id="${broadcast.id}"]`)
    .click();
  const detail = view.getByTestId("omp-agent-interaction-detail");
  assert.equal(await detail.getAttribute("data-from"), "main");
  assert.equal(await detail.getAttribute("data-to"), session.ids[0]);
  await shot("agent-interactions");
  await search.fill("<task-result");
  const results = view.locator(
    '[data-testid="omp-agent-interaction-message"][data-kind="task_result"]',
  );
  await results.first().waitFor({ state: "visible" });
  await results.first().click();
  const summary = view.getByTestId("omp-agent-interaction-summary");
  await summary.waitFor({ state: "visible" });
  noGuidance(await summary.innerText());
  const original = view.getByText("查看原文", { exact: true }).first();
  await original.click();
  assert.ok(
    await view.locator("details[open]").count(),
    "The original result must remain explicitly readable",
  );
  evidence.push({ page: "agent-interactions", nodes, messages });
  assert.deepEqual(await snapshot(), source, "Do not merge results across source snapshots");
  assert.deepEqual(errors, [], "No renderer page errors");
  await writeFile(
    join(evidenceDir, `${phase}-result.json`),
    JSON.stringify(
      { phase, source, runtimePath, model: runtime.model, prompt, session, evidence, errors },
      null,
      2,
    ),
  );
  console.log(`GUI ${phase}: PASS — main, 3 subagents and agent interactions`);
} finally {
  await browser.close();
}
