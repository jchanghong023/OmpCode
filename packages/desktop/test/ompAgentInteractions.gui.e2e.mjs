// 真实公开 GUI → 内嵌 OMP → 交互观察页面；不注入模型结果或会话投影。
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { collectInteractionSourceEvidence } from "./ompAgentInteractionSourceEvidence.mjs";
import { createProjectTask } from "./ompPerformanceHotPaths.guiChecks.mjs";

const manifestPath = process.env.OMP_E2E_RUNTIME_MANIFEST;
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
const marker = process.env.OMP_E2E_RUN_ID;
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(manifestPath && evidenceDir && marker, "Specify isolated runtime, evidence and run ID");
assert.ok(["live", "cold"].includes(phase));
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(runtime.endpoint && runtime.rendererUrl && runtime.electronPid);
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.connectOverCDP(runtime.endpoint);
const page = browser
  .contexts()[0]
  ?.pages()
  .find((candidate) => candidate.url().startsWith(runtime.rendererUrl));
assert.ok(page, "Only connect to the renderer started by the isolated launcher");
page.setDefaultTimeout(30_000);
await page.evaluate(() => {
  const original = MessagePort.prototype.postMessage;
  const telemetry = {
    queries: 0,
    restore: () => {
      MessagePort.prototype.postMessage = original;
    },
  };
  // 只数公开服务方法，既不改请求也不保存参数/正文；验证隐藏页停止查询。
  MessagePort.prototype.postMessage = function (...args) {
    const value = args[0];
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (bytes && new TextDecoder().decode(bytes).includes("listSessionAgentInteractions"))
      telemetry.queries++;
    return Reflect.apply(original, this, args);
  };
  window.__ompInteractionE2eTelemetry = telemetry;
});
const evidence = [];
const screenshot = (name) =>
  page.screenshot({ path: join(evidenceDir, `${phase}-${name}.png`), animations: "disabled" });
const view = page.getByTestId("omp-agent-interactions");
const interactionTabs = page.locator('[data-side-pane-tab-id^="omp-agent-interactions:"]');
const rows = page.getByTestId("omp-agent-interaction-message");
const search = page.getByTestId("omp-agent-interactions-search");
const expectedBodies = [
  `${marker}_MAIN_TO_ALPHA`,
  `${marker}_ALPHA_TO_MAIN`,
  `${marker}_BETA_TO_MAIN`,
  `${marker}_ALPHA_TO_BETA`,
  `${marker}_GAMMA_TO_ALPHA`,
];
async function expandGroups() {
  for (const button of await page
    .getByRole("button")
    .filter({ hasText: /已工作|已处理/u })
    .all()) {
    if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  }
}
async function openInteractions() {
  const expandStatus = page.getByRole("button", { name: "展开状态", exact: true });
  if (await expandStatus.isVisible()) await expandStatus.click();
  const agentSection = page.locator('[data-status-section-trigger="agent"]');
  if ((await agentSection.count()) && (await agentSection.getAttribute("aria-expanded")) !== "true")
    await agentSection.click();
  await expandGroups();
  const open = page.getByTestId("omp-agent-interactions-open").first();
  await open.waitFor({ state: "visible" });
  await open.click();
  await view.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[data-testid="omp-agent-interactions"]')
          ?.getAttribute("data-node-count"),
      ) >= 1,
  );
  assert.equal(await interactionTabs.count(), 1, "Opening repeats must reuse the same tab");
}
async function closeInteractions() {
  await interactionTabs
    .first()
    .getByRole("button", { name: /关闭/u })
    .click();
  await view.waitFor({ state: "detached" });
  assert.equal(await interactionTabs.count(), 0);
}
async function queriesPaused(reason) {
  const before = await page.evaluate(() => window.__ompInteractionE2eTelemetry.queries);
  await page.waitForTimeout(2_500);
  const after = await page.evaluate(() => window.__ompInteractionE2eTelemetry.queries);
  assert.equal(after, before, reason);
  evidence.push({ event: "queries-paused", reason, queryCount: after });
}
async function send(prompt) {
  await page.getByTestId("v4-composer-input").first().fill(prompt);
  await page.getByTestId("v4-composer-send").first().click();
}
async function readRecords() {
  return rows.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-message-id"),
      kind: node.getAttribute("data-kind"),
      from: node.getAttribute("data-from"),
      to: node.getAttribute("data-to"),
      timestamp: node.getAttribute("data-timestamp"),
      timeBasis: node.getAttribute("data-time-basis"),
      body: node.textContent,
    })),
  );
}
try {
  if (phase === "live") {
    // 重试复用同一隔离profile时，先用UI关闭上次显式打开的测试tab。
    while (await interactionTabs.count()) {
      await interactionTabs.first().click();
      await closeInteractions();
    }
    assert.equal(await view.count(), 0, "Interaction content stays absent until explicitly opened");
    // 指定项目启动器只在该项目安装验收 agent；全局“新建任务”会逃逸到默认工作区。
    if (runtime.requestedWorkspace) await createProjectTask(page, runtime.requestedWorkspace);
    else await page.getByRole("button", { name: "新建任务", exact: true }).last().click();
    const model = page.getByTestId("chat-model-select-trigger").first();
    await model.waitFor({ state: "visible" });
    if ((await model.getAttribute("aria-label")) !== "zhipu-coding-plan/GLM-5.3-Flash") {
      await model.click();
      await page.getByTestId("chat-model-select-group-omp-provider:zhipu-coding-plan").hover();
      await page
        .getByTestId("chat-model-select-item-custom:zhipu-coding-plan:glm-5.3-flash")
        .click();
    }
    const thoughtLevel = page.getByTestId("chat-thought-level-select-trigger").first();
    await thoughtLevel.click();
    await page.getByTestId("chat-thought-level-select-item-low").click();
    // draft还没有持久根会话；先用真实无工具首问建立根，再验零子代理空态。
    await send(`请仅回复${marker}_ROOT_READY，不使用任何工具。`);
    await page.getByText(`${marker}_ROOT_READY`, { exact: true }).first().waitFor({
      state: "visible",
      timeout: 90_000,
    });
    await queriesPaused("Before explicit open no independent interaction query is made");
    await openInteractions();
    assert.equal(await rows.count(), 0, "An empty root session must show an empty observation");
    await screenshot("empty-explicit");
    assert.ok(
      await page.evaluate(() => window.__ompInteractionE2eTelemetry.queries > 0),
      "The RPC observer must detect actual interaction queries",
    );
    await closeInteractions();
    await queriesPaused("Closing the empty tab stops polling");
    await send(
      `${marker}：执行只读agent交互GUI验收，不修改文件、不用git、不改设置。通信必须用write工具写agent://真实id（此处为通信，不是文件写入），只用当前IRC Peers/任务返回中的真实ID。` +
        `所有task必须agent=interaction-test、effort=lo（已配置GLM），用一次task启动两个并行子代理，name分别InteractionAlpha、InteractionBeta。` +
        `Alpha任务：向Main发正文仅${marker}_ALPHA_TO_MAIN；向Beta的真实ID发正文仅${marker}_ALPHA_TO_BETA；再用task创建嵌套子代理InteractionGamma，Gamma任务是向父Alpha真实ID发正文仅${marker}_GAMMA_TO_ALPHA，然后回复GAMMA_DONE；等待Gamma完成，Alpha回复ALPHA_DONE。` +
        `Beta任务：通过bash用powershell -NoProfile -Command "Start-Sleep -Seconds 10"等待，再向Main发正文仅${marker}_BETA_TO_MAIN，然后回复BETA_DONE。` +
        `Main在启动后向Alpha实际ID发正文仅${marker}_MAIN_TO_ALPHA，等待全部任务与消息，最后仅回复${marker}_DONE。发送失败要查实际ID重试，不能用普通文本假装发信。`,
    );
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="chat-summary-panel"]')
            ?.getAttribute("data-running-agent-count"),
        ) >= 2,
      undefined,
      { timeout: 90_000 },
    );
    assert.equal(await view.count(), 0, "Running agents must not automatically open the page");
    await openInteractions();
    const openedCount = Number(await view.getAttribute("data-message-count"));
    await screenshot("running-explicit");
    await page.getByText(`${marker}_DONE`, { exact: true }).first().waitFor({
      state: "visible",
      timeout: 600_000,
    });
    await page.waitForFunction(
      (initial) =>
        Number(
          document
            .querySelector('[data-testid="omp-agent-interactions"]')
            ?.getAttribute("data-message-count"),
        ) > initial,
      openedCount,
    );
    evidence.push({
      event: "live-appended",
      before: openedCount,
      after: Number(await view.getAttribute("data-message-count")),
    });
  } else {
    await page.locator('li[data-testid^="task-item-"]').filter({ hasText: marker }).first().click();
    await page.getByText(`${marker}_DONE`, { exact: true }).first().waitFor({ state: "visible" });
    assert.equal(await view.count(), 0, "Cold recovery must not auto-open interaction content");
  }
  await openInteractions();
  await openInteractions();
  assert.equal(await interactionTabs.count(), 1);
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[data-testid="omp-agent-interactions"]')
          ?.getAttribute("data-node-count"),
      ) >= 4,
  );
  // 派发正文也含这些标记，因此只用通信类型的真实记录作为消息验收依据。
  const observations = new Map();
  for (const body of expectedBodies) {
    // 虚拟列表仅挂载可视记录；通过产品搜索逐条定位，不能扫DOM冒充全量历史。
    await search.fill(body);
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll('[data-testid="omp-agent-interaction-message"]')].some(
          (node) =>
            node.getAttribute("data-kind") === "message" && node.textContent?.includes(expected),
        ),
      body,
      { timeout: 45_000 },
    );
    for (const record of await readRecords()) observations.set(record.id, record);
  }
  const records = [...observations.values()];
  const messages = records.filter((record) => record.kind === "message");
  const nodes = await page.locator("[data-agent-id]").evaluateAll((elements) =>
    elements.map((node) => ({
      id: node.getAttribute("data-agent-id"),
      label: node.getAttribute("data-label"),
      parent: node.getAttribute("data-parent-agent-id"),
      caption: node.textContent,
    })),
  );
  const findNode = (name) =>
    nodes.find((node) => node.label?.includes(name) || node.id?.includes(name));
  const main = nodes.find((node) => node.id === "main");
  const alpha = findNode("InteractionAlpha");
  const beta = findNode("InteractionBeta");
  const gamma = findNode("InteractionGamma");
  assert.ok(main && alpha && beta && gamma, "Expected the named agents from the real tasks");
  assert.equal(alpha.parent, main.id);
  assert.equal(beta.parent, main.id);
  assert.equal(gamma.parent, alpha.id, "Gamma must belong to Alpha rather than the root");
  const expectedDirections = [
    [main.id, alpha.id],
    [alpha.id, main.id],
    [beta.id, main.id],
    [alpha.id, beta.id],
    [gamma.id, alpha.id],
  ];
  const native = await collectInteractionSourceEvidence(runtime.runRoot, expectedBodies);
  const latestModels = new Map(native.models.map((item) => [item.file, item]));
  assert.ok(latestModels.size >= 4, "Capture the root and all real subagent model identities");
  for (const model of latestModels.values())
    assert.equal(model.model.toLowerCase(), "zhipu-coding-plan/glm-5.3-flash");
  for (const node of [alpha, beta, gamma]) {
    const terminal = native.terminalAgents.findLast(
      (item) => item.agentId === node.label && item.parentAgentId === node.parent,
    );
    if (terminal) {
      assert.ok(
        ["completed", "success"].includes(terminal.status),
        `The real task ${node.label} failed: ${terminal.status} at ${terminal.path}#${terminal.entryId}`,
      );
      assert.match(node.caption, /已完成|成功/u, `Persisted terminal: ${node.label}`);
    } else {
      if (phase === "cold")
        assert.match(node.caption, /状态未确认/u, "Cold state without terminal must stay unknown");
      else assert.doesNotMatch(node.caption, /已完成|成功/u, "Completion needs terminal evidence");
      evidence.push({ event: "missing-terminal-source", agentId: node.id });
    }
  }
  const selectedMessages = [];
  for (const [index, body] of expectedBodies.entries()) {
    const source = native.source.find((item) => item.body === body);
    assert.ok(source?.sends.length, "Each marker must have a real persisted send receipt");
    const durable = source.durableMessages[0];
    const matching = messages.filter((candidate) => candidate.body.includes(body));
    const record = durable
      ? matching.find((candidate) => candidate.id === `message:${durable.messageId}`)
      : (matching.find((candidate) => candidate.timeBasis === "sent") ?? matching[0]);
    assert.ok(record?.id && record.from && record.to && record.from !== record.to);
    assert.deepEqual(
      [record.from, record.to],
      expectedDirections[index],
      `Wrong agent endpoints for ${body}`,
    );
    assert.ok(Number.isFinite(Number(record.timestamp)) && Number(record.timestamp) > 0);
    assert.ok(["sent", "recorded"].includes(record.timeBasis), "Show the actual timestamp basis");
    if (durable) {
      assert.equal(Number(record.timestamp), durable.timestamp);
      assert.equal(record.timeBasis, "sent");
    } else if (phase === "cold") {
      assert.equal(
        record.timeBasis,
        "recorded",
        "A receipt without msg.ts cannot claim a sent time",
      );
      assert.ok(
        record.id.startsWith("send:"),
        "Use the actual tool-call observation ID when the message ID is absent",
      );
      assert.equal(
        source.sends.every((item) => !item.hasMessageId && !item.hasSentTimestamp),
        true,
      );
      await page.getByTestId("omp-agent-interactions-coverage").waitFor({ state: "visible" });
    }
    selectedMessages.push({ ...record, marker: body });
    await search.fill(body);
    await page
      .locator(`[data-testid="omp-agent-interaction-message"][data-message-id="${record.id}"]`)
      .click();
    const detail = page.getByTestId("omp-agent-interaction-detail");
    await detail.waitFor({ state: "visible" });
    assert.equal(await detail.getAttribute("data-from"), record.from);
    assert.equal(await detail.getAttribute("data-to"), record.to);
    assert.ok(await detail.locator("time").getAttribute("datetime"));
    assert.ok((await detail.innerText()).includes(body));
    const edge = page.locator(`path[data-message-id="${record.id}"][data-selected="true"]`);
    assert.equal(await edge.count(), 1, "Selected communication highlights one directed edge");
    assert.equal(await edge.getAttribute("data-from"), record.from);
    assert.equal(await edge.getAttribute("data-to"), record.to);
  }
  await screenshot("selected-nested");
  await search.fill("");
  await page.getByTestId("omp-agent-interactions-view").evaluate((element) => {
    element.scrollTop = 0;
  });
  await view.screenshot({
    path: join(evidenceDir, `${phase}-interaction-page.png`),
    animations: "disabled",
  });
  evidence.unshift({
    phase,
    rootSessionId: await view.getAttribute("data-root-session-id"),
    nodes,
    messages: selectedMessages,
    native,
  });
  if (phase === "cold") {
    const live = JSON.parse(await readFile(join(evidenceDir, "live-result.json"), "utf8"));
    for (const record of selectedMessages) {
      const prior = live[0].messages.find((item) => item.marker === record.marker);
      assert.ok(prior);
      assert.deepEqual([record.from, record.to], [prior.from, prior.to]);
      const source = native.source.find((item) => item.body === record.marker);
      if (source.durableMessages.length)
        assert.deepEqual(
          [record.id, record.timestamp, record.timeBasis],
          [prior.id, prior.timestamp, prior.timeBasis],
          "Persisted message identity and sent time survive cold recovery",
        );
    }
  }
  const childCard = page.locator('[data-testid^="v4-subagent-open-side-pane-"]').first();
  await childCard.click();
  await view.waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("omp-agent-interactions-mesh").count(), 0);
  assert.equal(await interactionTabs.count(), 1, "Switching leaves the tab shell available");
  await queriesPaused("Switching to an agent detail stops interaction polling");
  await interactionTabs.first().click();
  await view.waitFor({ state: "visible" });
  const sidePaneToggle = page.getByTestId("side-pane-toggle");
  await sidePaneToggle.click();
  await view.waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("omp-agent-interactions-mesh").count(), 0);
  await queriesPaused("Collapsing the side pane stops interaction polling");
  await sidePaneToggle.click();
  await view.waitFor({ state: "visible" });
  await closeInteractions();
  assert.equal(await page.getByTestId("omp-agent-interactions-mesh").count(), 0);
  await queriesPaused("Closing the interaction tab stops polling");
  await screenshot("closed");
  await writeFile(join(evidenceDir, `${phase}-result.json`), JSON.stringify(evidence, null, 2));
  console.log(
    `PASS ${phase}: real IRC messages, nested agents, selection and explicit tab lifecycle`,
  );
} catch (error) {
  await screenshot("failure").catch(() => {});
  await writeFile(
    join(evidenceDir, `${phase}-failure.json`),
    JSON.stringify(
      { message: error.message, records: await readRecords().catch(() => []) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await page.evaluate(() => window.__ompInteractionE2eTelemetry?.restore()).catch(() => {});
  await browser.close();
}
