import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import { readMockRequests, reveal } from "./ompMockInteractions.assertions.mjs";
import {
  acknowledge,
  assertAgentCount,
  assertDetails,
  assertFailedChild,
  childTab,
  assertReadonly,
  control,
  eventually,
  exerciseTodo,
  identitiesOf,
  identityForTask,
  openAgentPanel,
  openChild,
  submit,
} from "./ompAgentsAcceptance.assertions.mjs";
import { assertInteractionPage } from "./ompAgentsAcceptance.interactions.mjs";
import {
  captureAgentJournals,
  captureLiveAgentsReceipt,
  recoverAgents,
} from "./ompAgentsAcceptance.lifecycle.mjs";
import {
  assertDetailModel,
  assertEndedModels,
  assertRunningModel,
  observedChildModels,
} from "./ompAgentsAcceptance.models.mjs";
import { exercisePanelStop } from "./ompAgentsAcceptance.panelStop.mjs";
import {
  inspectRecords,
  jsonlFiles,
  readEntries,
  recordSnapshot,
  taskDispatch,
} from "./ompAgentsAcceptance.records.mjs";

const phase = process.env.OMP_E2E_PHASE;
assert.ok(["live", "recovery"].includes(phase), "Run agents through the real OMP GUI gate phases");
for (const name of [
  "OMP_E2E_RUNTIME_MANIFEST",
  "OMP_E2E_CDP_URL",
  "OMP_E2E_EVIDENCE_DIR",
  "OMP_E2E_RUN_ID",
])
  assert.ok(process.env[name], `Missing ${name}`);
const runtime = JSON.parse(await readFile(process.env.OMP_E2E_RUNTIME_MANIFEST, "utf8"));
assert.equal(runtime.suite, "agents");
assert.ok(runtime.acceptance && runtime.configRoot && runtime.observationsUrl);
assert.deepEqual(runtime.acceptance.files, ["a", "b", "c"]);
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
await mkdir(evidenceDir, { recursive: true });
const receiptPath = join(evidenceDir, `agents-${process.env.OMP_E2E_RUN_ID}.json`);
const browser = await chromium.connectOverCDP(process.env.OMP_E2E_CDP_URL);
let removedRecord;
try {
  const prefix = `${runtime.rendererUrl.replace(/\/+$/u, "")}/`;
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith(prefix));
  assert.ok(page, "Require the isolated renderer owned by this launcher");
  page.setDefaultTimeout(30_000);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  const isolation = await readIsolationEvidence(runtime.isolationEvidence);
  assert.equal(isolation.electronPid, runtime.electronPid);
  assert.equal(isolation.verified, true);
  assert.equal(isolation.mode, "hidden-native-windows");
  assert.ok(isolation.windows.length > 0);
  for (const window of isolation.windows) {
    assert.equal(window.visible, false);
    assert.equal(window.focused, false);
    assert.equal(window.focusable, false);
  }
  const tasks = page.locator('li[data-testid^="task-item-"]');
  const taskIds = () =>
    tasks.evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  const saved = phase === "recovery" ? JSON.parse(await readFile(receiptPath, "utf8")) : null;
  let receipt;
  let children;
  let parentId;
  let failed;
  let controlled;
  if (phase === "live") {
    const before = await taskIds();
    await exerciseTodo(page, evidenceDir);
    const added = (await taskIds()).filter((id) => !before.includes(id));
    assert.equal(added.length, 1, "All todo phases must belong to exactly one real parent session");
    parentId = added[0].slice("task-item-".length);
    assert.match(parentId, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu);
    await openAgentPanel(page);
    await page.getByRole("button", { name: /^(?:Agent 交互|Agent interactions)$/u }).click();
    // 中文原因：侧栏 tab 含独立关闭控件；用真实内容根节点，不猜 tabpanel 的完整可访问名。
    const emptyInteractions = page.getByTestId("omp-agent-interactions");
    await emptyInteractions.waitFor({ state: "visible" });
    await eventually(
      () => emptyInteractions.getAttribute("data-root-session-id"),
      (id) => id === parentId,
      "The empty interaction page must bind to the actual canonical parent",
    );
    // 中文原因：data-root-session-id 来自侧栏 tab 绑定（读请求前就已确定），data-node-count 来自
    // 异步读结果（OmpAgentInteractionsSidePane: state.result?.agents.length ?? 0），首个读回包
    // 未到时会瞬时为 0；必须先等到真实空结果落地，再做严格断言。
    await eventually(
      () => emptyInteractions.getAttribute("data-node-count"),
      (count) => count === "1",
      "The loaded empty source must present the canonical empty node",
    );
    assert.equal(await emptyInteractions.getAttribute("data-message-count"), "0");
    await emptyInteractions
      .getByText(/暂无交互记录|无交互记录|No interactions/u)
      .waitFor({ state: "visible" });
    assert.equal(
      await emptyInteractions.getByRole("listitem").count(),
      0,
      "An empty real source cannot be presented as complete fabricated messages",
    );
    await captureIsolationScreenshot(join(evidenceDir, "agents-live-empty-interactions.png"));
    await page
      .locator('[data-side-pane-tab-type="omp-agent-interactions"]')
      .getByRole("button", { name: /关闭|Close/u })
      .click();
    await submit(page, "AGENTS_PARALLEL");
    const initial = async () => (await readMockRequests(runtime)).acceptance;
    await eventually(
      initial,
      (state) => ["a", "b", "c"].every((name) => state?.children?.[name]?.assignment),
      "Three genuine concurrent framed child requests",
    );
    await assertAgentCount(page, 3);
    await page.getByTestId("v4-composer-background-work-trigger").click();
    const panel = await openAgentPanel(page);
    assert.equal(await panel.locator('[data-work-status="running"]').count(), 3);
    children = await identitiesOf(
      page,
      3,
      await taskDispatch(runtime, parentId, "agents-batch-task"),
    );
    children = observedChildModels(children, await initial());
    for (const child of children) {
      await assertRunningModel(page, panel, child);
      const pane = await openChild(page, child);
      await assertDetailModel(pane, child);
      await pane.getByRole("button", { name: /^(?:停止|Stop)$/u }).waitFor({ state: "visible" });
      assert.equal(await pane.getByRole("button", { name: /^(?:停止|Stop)$/u }).isEnabled(), true);
    }
    await captureIsolationScreenshot(join(evidenceDir, "agents-live-three-running.png"));
    await control(runtime, "start");
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) =>
        ["a", "b", "c"].every(
          (name) =>
            diagnostics.acceptance.children[name]?.ready &&
            diagnostics.calls.some(
              (call) =>
                call.completed === true &&
                call.messages.some(
                  (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("Complete assignment thoroughly:") &&
                    JSON.stringify(message.content).includes(`AGENTS_CHILD_${name}`),
                ),
            ),
        ),
      "All independent initial child responses must finish before broadcasting",
    );
    await control(runtime, "parent");
    await eventually(
      initial,
      (state) => state?.parent?.includes("broadcast"),
      "Real broadcast tool result precedes wait",
    );
    await control(runtime, "a");
    await acknowledge(page, "AGENTS_WAIT_A_RECEIVED");
    await assertAgentCount(page, 2);
    await control(runtime, "b");
    await acknowledge(page, "AGENTS_AUTO_b");
    await assertAgentCount(page, 1);
    await control(runtime, "c");
    await acknowledge(page, "AGENTS_ALL_COMPLETED");
    await assertAgentCount(page, 0);
    assert.equal((await taskIds()).filter((id) => !before.includes(id)).length, 1);
    const records = await inspectRecords(runtime, parentId, children);
    await assertDetails(page, children, records, undefined, evidenceDir, "live");
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) => diagnostics.acceptance.children.b?.peerReceived === true,
      "The genuine directed a → b message must reach b's model input",
    );
    await captureIsolationScreenshot(join(evidenceDir, "agents-live-parent-completed.png"));
    // 独立失败子保留三名成功写入者；失败必须来自真实 yield，而不是停止或非法 Todo。
    await submit(page, "AGENTS_FAILURE_PARENT");
    await acknowledge(page, "AGENTS_FAILURE_READY");
    failed = await identityForTask(
      page,
      "agents-failure-task",
      "failure",
      3,
      await taskDispatch(runtime, parentId, "agents-failure-task"),
    );
    await assertAgentCount(page, 1);
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) => diagnostics.acceptance.children.failure?.assignment === true,
      "Failure scenario must execute a genuine framed child request",
    );
    await control(runtime, "failure");
    await acknowledge(page, "AGENTS_FAILURE_RECEIVED");
    await assertAgentCount(page, 0);
    const failureCalls = (await readMockRequests(runtime)).calls.filter((call) =>
      call.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("Complete assignment thoroughly:") &&
          JSON.stringify(message.content).includes("AGENTS_CHILD_failure"),
      ),
    );
    assert.ok(
      failureCalls.length > 0 && failureCalls.every((call) => call.completed && !call.aborted),
      "Real failed yield is not a canceled or unexecuted HTTP request",
    );
    await assertFailedChild(page, failed);
    // A fifth dedicated child proves real control without modifying successful/failed evidence.
    await submit(page, "AGENTS_CONTROL_PARENT");
    await acknowledge(page, "AGENTS_CONTROL_READY");
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) => diagnostics.acceptance.children.control?.started,
      "Dedicated real child started",
    );
    controlled = await identityForTask(
      page,
      "agents-control-task",
      "control",
      4,
      await taskDispatch(runtime, parentId, "agents-control-task"),
    );
    const pane = await openChild(page, controlled);
    await pane.getByRole("textbox").fill("AGENTS_CONTROL_STEER");
    await pane.getByRole("button", { name: /^(?:发送|Send)$/u }).click();
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) => diagnostics.acceptance.controlSteer === true,
      "Detail send must reach actual child model input",
    );
    const beforeStop = await readMockRequests(runtime);
    const request = beforeStop.calls.find((call) =>
      call.messages.some((message) => JSON.stringify(message).includes("AGENTS_CONTROL_STEER")),
    );
    assert.ok(request && request.requestId && request.aborted === false);
    await pane.getByRole("button", { name: /^(?:停止|Stop)$/u }).click();
    await eventually(
      () => readMockRequests(runtime),
      (diagnostics) =>
        diagnostics.calls.some((call) => call.requestId === request.requestId && call.aborted),
      "Actual stop must cancel the held child HTTP request",
    );
    await control(runtime, "control-steer");
    await assertReadonly(pane, /已取消|已停止|已中断|Canceled|Cancelled|Stopped/u);
    await assertAgentCount(page, 0);
    await acknowledge(page, "AGENTS_CONTROL_STOPPED");
    await captureIsolationScreenshot(join(evidenceDir, "agents-live-control-stopped.png"));
    const files = await jsonlFiles(join(runtime.configRoot, "agent", "sessions"));
    const controlPath = join(records.parentPath.slice(0, -6), `${controlled.rawId}.jsonl`);
    assert.ok(
      files.includes(controlPath),
      "Controlled child must also have a genuine independent source record",
    );
    const actualControl = await readEntries(controlPath);
    assert.ok(
      actualControl.some((entry) => JSON.stringify(entry).includes("AGENTS_CONTROL_STEER")),
    );
    const finalRecords = await inspectRecords(runtime, parentId, children, {
      failure: failed,
      control: controlled,
    });
    await assertEndedModels(page, await openAgentPanel(page), children, parentId);
    receipt = await captureLiveAgentsReceipt({
      runtime,
      records: finalRecords,
      parentId,
      children,
      failed,
      controlled: { ...controlled, path: controlPath },
      taskIds,
      runId: process.env.OMP_E2E_RUN_ID,
    });
    await openAgentPanel(page);
    await assertInteractionPage(page, runtime, finalRecords, parentId, evidenceDir, "live");
    assert.deepEqual(
      recordSnapshot(
        await inspectRecords(runtime, parentId, children, { failure: failed, control: controlled }),
      ),
      receipt.snapshot,
      "Read-only interaction/details must not mutate final parent message/custom delivery sequence or any child source",
    );
    assert.deepEqual(
      await taskIds(),
      receipt.sidebar,
      "Read-only viewing cannot append/reorder sidebar tasks",
    );
    // 中文原因：先关闭原 owner 的详情，避免任务切换后隐藏的旧 tab 继续持有同一详情订阅。
    const detailTabs = page.locator('[data-side-pane-tab-type="subagent-session"]');
    while (await detailTabs.count()) {
      const close = detailTabs.first().getByRole("button", { name: /关闭|Close/u });
      await close.focus();
      await close.press("Enter");
    }
    receipt.panelStop = await exercisePanelStop({ page, runtime, evidenceDir, taskIds });
    await page.getByTestId(`task-item-${parentId}`).click();
    receipt.sidebar = await taskIds();
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  } else {
    ({ parentId, children, failed, controlled, receipt } = await recoverAgents({
      page,
      runtime,
      saved,
      evidenceDir,
      taskIds,
      runId: process.env.OMP_E2E_RUN_ID,
    }));
  }
  // 中文原因：切回持久父会话后，composer 可先变 UUID，已有子代卡仍保留 live 路由。
  // 读取真实卡片路由并限制在同一父身份的两个已证明别名内，不用 composer 身份猜路由。
  const controlOpener = page.locator(
    `[data-testid^="v4-subagent-open-side-pane-omp-subagent:${receipt.controlled.rawId}@"]`,
  );
  await reveal(page, controlOpener);
  assert.equal(await controlOpener.count(), 1);
  const controlRoute = await controlOpener.getAttribute("data-testid");
  const detailParent = controlRoute.slice(controlRoute.lastIndexOf("@") + 1);
  assert.ok([parentId, receipt.controlled.liveParent].includes(detailParent));
  await openChild(page, receipt.controlled, detailParent);
  // Missing-source fault moves only our genuinely stopped control child; all originals restore in finally.
  const backup = join(evidenceDir, `agents-${phase}-missing-${receipt.controlled.rawId}.jsonl`);
  await rename(receipt.controlled.path, backup);
  removedRecord = { original: receipt.controlled.path, backup };
  const activeTab = childTab(page, receipt.controlled, detailParent);
  await activeTab.getByRole("button", { name: /关闭|Close/u }).click();
  const missing = await openChild(page, receipt.controlled, detailParent);
  await missing
    .getByText("记录不可用（不存在或已清理）", { exact: true })
    .waitFor({ state: "visible" });
  await assertReadonly(missing, /记录不可用|记录缺失|状态未确认|Unavailable|Missing|Unconfirmed/u);
  assert.equal(
    await missing.getByText("AGENTS_CONTROL_STARTED", { exact: true }).count(),
    0,
    "Missing real record may not be replaced by a stale successful transcript",
  );
  await captureIsolationScreenshot(join(evidenceDir, `agents-${phase}-missing-record.png`));
  await openAgentPanel(page);
  await page.getByRole("button", { name: /^(?:Agent 交互|Agent interactions)$/u }).click();
  const partial = page.getByTestId("omp-agent-interactions");
  const coverage = partial.getByTestId("omp-agent-interactions-coverage");
  await coverage.getByText(/部分历史记录|Partial history/u).waitFor({ state: "visible" });
  await coverage
    .getByText(/部分源记录无法读取|Some source records could not be read/u)
    .waitFor({ state: "visible" });
  assert.equal(
    await partial.getByText(/完整审计|Complete audit/u).count(),
    0,
    "Missing real source must not be advertised as complete history",
  );
  await page
    .locator('[data-side-pane-tab-type="omp-agent-interactions"]')
    .getByRole("button", { name: /关闭|Close/u })
    .click();
  for (const name of ["a", "b", "c"])
    assert.ok((await readFile(join(runtime.requestedWorkspace, name))).equals(Buffer.from(name)));
  if (phase === "recovery") assert.equal((await readMockRequests(runtime)).calls.length, 0);
  await rename(removedRecord.backup, removedRecord.original);
  removedRecord = undefined;
  const inspected = await inspectRecords(runtime, parentId, children, {
    failure: failed,
    control: controlled,
  });
  assert.deepEqual(await captureAgentJournals(inspected), receipt.journals);
  assert.deepEqual(
    recordSnapshot(inspected),
    receipt.snapshot,
    "All read-only cold/live details, interactions and missing-source views leave final parent and every original child unchanged",
  );
  assert.deepEqual(
    await taskIds(),
    receipt.sidebar,
    "All inspection surfaces leave the final sidebar task list unchanged",
  );
  assert.deepEqual(
    rendererErrors,
    [],
    "New real GUI acceptance must not suppress renderer failures",
  );
  await writeFile(
    join(evidenceDir, `agents-${phase}-requests.json`),
    JSON.stringify(await readMockRequests(runtime), null, 2),
  );
} finally {
  if (removedRecord) await rename(removedRecord.backup, removedRecord.original);
  await browser.close();
}
