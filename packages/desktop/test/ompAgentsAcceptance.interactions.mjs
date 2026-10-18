import assert from "node:assert/strict";
import { join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { readMockRequests } from "./ompMockInteractions.assertions.mjs";
import { childTab, eventually } from "./ompAgentsAcceptance.assertions.mjs";
import { sourceEvents } from "./ompAgentsAcceptance.sources.mjs";
import { assertInteractionQueryRetry } from "./ompAgentsAcceptance.queryRetry.mjs";

async function queryCount(runtime) {
  assert.ok(
    runtime.observationsUrl,
    "Require real IPC read-only observation, never a zero/no-op query assertion",
  );
  const response = await fetch(runtime.observationsUrl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Number.isInteger(body.agentInteractionQueries));
  return body.agentInteractionQueries;
}
export async function assertInteractionPage(page, runtime, records, parentId, evidenceDir, phase) {
  const modelBefore = (await readMockRequests(runtime)).calls.length;
  const open = page.getByRole("button", { name: /^(?:Agent 交互|Agent interactions)$/u });
  // 中文原因：真实侧栏 tab 有独立关闭控件和拖拽角色；内容节点才拥有交互页状态。
  const tab = page.locator('[data-side-pane-tab-type="omp-agent-interactions"]');
  const panel = page.getByTestId("omp-agent-interactions");
  assert.equal(
    await tab.count(),
    0,
    "Interaction content is opt-in, not embedded in the main timeline",
  );
  const baseline = await queryCount(runtime);
  await page.waitForTimeout(1_200);
  assert.equal(await queryCount(runtime), baseline, "Unopened interaction page must not query");
  await open.click();
  await panel.waitFor({ state: "visible" });
  await eventually(
    () => panel.getAttribute("data-root-session-id"),
    (id) => id === parentId,
    "Interaction inspection must bind to the actual canonical parent",
  );
  const openedCount = await eventually(
    () => queryCount(runtime),
    (count) => count > baseline,
    "Opening must issue a genuine public interaction query",
  );
  const refreshStart = Date.now();
  await eventually(
    () => queryCount(runtime),
    (count) => count > openedCount,
    "Active interaction tab must actually refresh authoritative records",
    30_000,
  );
  const refreshWindow = Math.max(6_000, (Date.now() - refreshStart) * 2);
  await open.click();
  assert.equal(await tab.count(), 1, "Repeated opens activate exactly the same tab");
  const list = panel.getByRole("list", { name: /选择一条交互|Select an interaction/u });
  const rows = list.getByRole("listitem");
  const events = sourceEvents(records, parentId);
  await eventually(
    async () => Number(await panel.getAttribute("data-message-count")),
    (count) => count >= events.length,
    "All independently sourced dispatch, communication, intervention and result events must load",
  );
  await list.waitFor({ state: "visible" });
  const before = await rows.allTextContents();
  const loadedCount = await panel.getAttribute("data-message-count");
  let originalDisclosures = 0;
  const search = panel.getByTestId("omp-agent-interactions-search");
  for (const event of events) {
    // 中文原因：历史列表虚拟化；用真实搜索将每条独立来源记录带入可见视口，而非要求全部 DOM 常驻。
    await search.fill(event.token);
    const user = event.kind === "intervention";
    const senderId = user
      ? "user:operator"
      : event.sender === records.parentAgentId
        ? "main"
        : event.sender;
    const receiverId = event.receiver === records.parentAgentId ? "main" : event.receiver;
    const row = rows
      .filter({
        has: page.locator(`button[data-from="${senderId}"][data-to="${receiverId}"]`),
      })
      .filter({ hasText: event.token });
    await eventually(
      () => row.count(),
      (count) => count === 1,
      "The genuine search must reveal the independently correlated event",
    );
    assert.equal(
      await row.count(),
      1,
      `Exactly one real ${event.kind} ${event.sender} → ${event.receiver}; never fabricate broadcasts or duplicate events`,
    );
    await row.getByRole("button").click();
    const detail = panel.getByTestId("omp-agent-interaction-detail");
    const summary = await detail.innerText();
    assert.equal(await detail.getAttribute("data-from"), senderId);
    assert.equal(await detail.getAttribute("data-to"), receiverId);
    if (receiverId === "main") assert.match(summary, /主智能体|Main agent/u);
    else assert.ok(summary.includes(event.receiver));
    if (user) {
      assert.match(summary, /用户干预|User intervention/u);
      assert.doesNotMatch(
        summary,
        /Main Agent|父\s*(?:Agent|智能体)/iu,
        "User intervention cannot be presented as parent-agent communication",
      );
      assert.equal(
        summary
          .split(/\r?\n/u)
          .some((line) => /(?:^|[:：])\s*(?:已读|已处理|Read|Processed|Handled)\s*$/iu.test(line)),
        false,
        "User delivery and canceled model input do not prove affirmative read/processed receipts",
      );
      assert.equal(
        summary.includes(records.parentAgentId),
        false,
        "User intervention cannot attribute sender identity to Main",
      );
    } else if (senderId === "main") assert.match(summary, /主智能体|Main agent/u);
    else assert.ok(summary.includes(event.sender));
    assert.ok(
      !summary.includes("<task-result"),
      `Default task result view is deterministic summary, not XML (${event.token}): ${summary}`,
    );
    assert.equal(summary.includes("[Wait interrupted"), false);
    const rawButton = detail.getByTestId("omp-agent-interaction-raw-toggle");
    const disclosureCount = await rawButton.count();
    assert.ok(
      disclosureCount === 0 || disclosureCount === 1,
      "At most one genuine original disclosure",
    );
    const hasDisclosure = disclosureCount === 1;
    // 中文原因：短纯文本已直接显示原文；仅结构化、截断或附带投递元数据才有 details。
    if (hasDisclosure) {
      assert.equal(
        await detail.getByTestId("omp-agent-interaction-raw").getAttribute("open"),
        null,
      );
      await rawButton.click();
      originalDisclosures++;
    }
    const raw = detail.getByTestId(
      hasDisclosure ? "omp-agent-interaction-original-body" : "omp-agent-interaction-summary",
    );
    await raw.waitFor({ state: "visible" });
    const original = await raw.innerText();
    assert.ok(
      original.includes(event.token),
      `Original must retain the actual ${event.token} source content`,
    );
    assert.equal(
      await detail.getAttribute("data-source-id"),
      event.sourceId,
      "Detail source identity must equal the independently correlated raw OMP entry ID",
    );
    assert.equal(
      await detail.getByTestId("omp-agent-interaction-source-id").innerText(),
      event.sourceId,
    );
    if (event.messageId)
      assert.equal(await detail.getAttribute("data-message-id"), `message:${event.messageId}`);
    assert.ok(
      (await detail.innerText()).includes(event.sourceId),
      `Detail must link its true tool/source record ${event.sourceId}`,
    );
    const selectedEdge = panel
      .getByTestId("omp-agent-interaction-edge")
      .and(panel.locator(`[data-from="${senderId}"][data-to="${receiverId}"]`));
    assert.equal(await selectedEdge.count(), 1);
    assert.equal(
      await selectedEdge.getAttribute("data-selected"),
      "true",
      "Selecting a record highlights its actual directed edge",
    );
    const time = detail.locator("time[datetime]");
    if (event.timeBasis === "unknown") {
      assert.match(summary, /时间未知|Unknown time/u, "Only a source without time may be unknown");
      assert.equal(
        await time.count(),
        0,
        "Unknown source time must not be replaced by recovery now",
      );
    } else {
      assert.match(
        summary,
        event.timeBasis === "sent" ? /发送时间|Sent time/u : /记录时间|Record time/u,
        "The displayed time basis must follow actual receipt or record provenance",
      );
      assert.equal(await detail.getAttribute("data-time-basis"), event.timeBasis);
      assert.doesNotMatch(summary, /时间未知|Unknown time/u);
      assert.equal(
        await time.count(),
        1,
        "One machine-readable displayed instant must identify the event time",
      );
      assert.equal(
        Date.parse(await time.getAttribute("datetime")),
        event.timestamp,
        "UI instant must equal its independent persisted source exactly",
      );
    }
    if (hasDisclosure) {
      await rawButton.click();
      assert.equal(await raw.isVisible(), false);
    }
    await search.fill("");
  }
  assert.ok(
    originalDisclosures > 0,
    "Structured real results must exercise genuine original disclosure",
  );
  assert.equal(await panel.getAttribute("data-message-count"), loadedCount);
  await eventually(
    () => rows.allTextContents(),
    (texts) => JSON.stringify(texts) === JSON.stringify(before),
    "Clearing genuine searches must restore the unchanged virtual history window",
  );
  assert.deepEqual(
    await rows.allTextContents(),
    before,
    "Selecting/opening original must never append or merge real events",
  );
  for (const child of records.children) {
    const node = panel
      .getByTestId("omp-agent-interaction-node")
      .and(panel.locator(`[data-agent-id="${child.rawId}"]`));
    assert.equal(await node.count(), 1);
    assert.match(await node.innerText(), /已完成|Completed/u);
  }
  for (const child of Object.values(records.extras)) {
    const node = panel
      .getByTestId("omp-agent-interaction-node")
      .and(panel.locator(`[data-agent-id="${child.rawId}"]`));
    assert.equal(await node.count(), 1);
    // 中文原因：yield({error}) 与用户 Stop 的真实 OMP 终态均为 aborted/cancelled；
    // records 已分别核对错误原因与中断记录，交互节点不能编造 Failed 状态。
    assert.match(
      await node.innerText(),
      /已停止|已中断|已取消|已中止|Canceled|Cancelled|Stopped|Aborted/u,
    );
    assert.doesNotMatch(await node.innerText(), /进行中|Running/u);
  }
  await captureIsolationScreenshot(join(evidenceDir, `agents-${phase}-interactions.png`));
  const inactiveWindow = async (reason) => {
    await panel.waitFor({ state: "hidden" });
    // 查询计数记录“发出”而非完成；隐藏后立即取基线，不能吞掉头一秒的新查询。
    const inactive = await queryCount(runtime);
    await page.waitForTimeout(refreshWindow);
    assert.equal(
      await queryCount(runtime),
      inactive,
      `${reason} must stop new real public interaction queries`,
    );
  };
  const reactivate = async (action) => {
    const inactive = await queryCount(runtime);
    await action();
    await panel.waitFor({ state: "visible" });
    await eventually(
      () => queryCount(runtime),
      (count) => count > inactive,
      "Reactivation must really query authoritative source records",
    );
    await eventually(
      () => rows.allTextContents(),
      (texts) => JSON.stringify(texts) === JSON.stringify(before),
      "Reopened page must finish loading the complete unchanged authoritative event collection",
    );
    assert.deepEqual(
      await rows.allTextContents(),
      before,
      "Reopening neither duplicates nor loses real events",
    );
    assert.equal(
      await panel.getAttribute("data-message-count"),
      loadedCount,
      "Reactivation must preserve the full loaded event collection, not just virtual rows",
    );
  };
  await childTab(page, records.children[0], phase === "recovery" ? parentId : undefined).click();
  await inactiveWindow("Switching to child detail");
  await reactivate(() => tab.click());
  await page.getByRole("button", { name: /^(?:收起侧边面板|Collapse side pane)$/u }).click();
  await inactiveWindow("Collapsing the sidebar");
  await reactivate(() =>
    page.getByRole("button", { name: /^(?:展开侧边面板|Expand side pane)$/u }).click(),
  );
  await tab.getByRole("button", { name: /关闭|Close/u }).click();
  await inactiveWindow("Closing the interaction tab");
  await reactivate(() => open.click());
  await assertInteractionQueryRetry(page, runtime, records, parentId, evidenceDir, phase);
  assert.equal(
    (await readMockRequests(runtime)).calls.length,
    modelBefore,
    "Pure interaction inspection must never execute model turns",
  );
  await tab.getByRole("button", { name: /关闭|Close/u }).click();
  await inactiveWindow("Final interaction tab closure");
}
