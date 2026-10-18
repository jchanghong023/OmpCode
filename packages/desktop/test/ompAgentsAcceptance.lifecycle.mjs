import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readMockRequests, reveal } from "./ompMockInteractions.assertions.mjs";
import {
  assertAgentCount,
  assertDetails,
  assertFailedChild,
  assertReadonly,
  openAgentPanel,
  openTodoPanel,
} from "./ompAgentsAcceptance.assertions.mjs";
import { assertInteractionPage } from "./ompAgentsAcceptance.interactions.mjs";
import { inspectRecords, recordSnapshot } from "./ompAgentsAcceptance.records.mjs";
import { inspectPanelStopReceipt, recoverPanelStop } from "./ompAgentsAcceptance.panelStop.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const journalPaths = (records) => [
  records.parentPath,
  ...records.children.map(({ path }) => path),
  ...Object.values(records.extras).map(({ path }) => path),
];

export async function captureAgentJournals(records) {
  return Promise.all(
    journalPaths(records).map(async (path, index) => {
      const bytes = await readFile(path);
      const entries = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const source =
        index === 0
          ? records.entries
          : [...records.children, ...Object.values(records.extras)][index - 1].entries;
      assert.deepEqual(
        entries,
        source,
        "Live journal capture must match the inspected exact history",
      );
      if (index > 0) {
        assert.equal(
          digest(bytes),
          [...records.children, ...Object.values(records.extras)][index - 1].sha256,
        );
      }
      assert.equal(bytes.at(-1), 10, "The observed JSONL prefix must end at a complete record");
      return { path, byteLength: bytes.length, sha256: digest(bytes), tailId: entries.at(-1).id };
    }),
  );
}

export async function captureLiveAgentsReceipt({
  runtime,
  records,
  parentId,
  children,
  failed,
  controlled,
  taskIds,
  runId,
}) {
  const modelEvidence = await readMockRequests(runtime);
  for (const [toolId, sources] of [
    ["agents-batch-task", children],
    ["agents-failure-task", [failed]],
    ["agents-control-task", [controlled]],
  ]) {
    assert.deepEqual(
      Object.values(modelEvidence.acceptance.dispatched[toolId]).sort(),
      sources.map((child) => child.rawId).sort(),
      "Model routing IDs must equal the actual dispatch/GUI child set, never injected control facts",
    );
  }
  return {
    runId,
    runRoot: runtime.runRoot,
    launcherPid: runtime.launcherPid,
    parentId,
    children,
    failed,
    controlled,
    journalPhase: "live",
    journalsObservedAt: new Date().toISOString(),
    journals: await captureAgentJournals(records),
    snapshot: recordSnapshot(records),
    sidebar: await taskIds(),
  };
}

export async function finalizeAgentsReceipt(runtime, receiptPath) {
  const saved = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(saved.runRoot, runtime.runRoot);
  assert.equal(saved.launcherPid, runtime.launcherPid);
  assert.equal(saved.journalPhase, "live", "Only a successful live receipt can be finalized");
  const records = await inspectRecords(runtime, saved.parentId, saved.children, {
    failure: saved.failed,
    control: saved.controlled,
  });
  assert.deepEqual(
    journalPaths(records),
    saved.journals.map(({ path }) => path),
  );
  const panelStop = await inspectPanelStopReceipt(runtime, saved.panelStop);
  assert.deepEqual(
    panelStop.journals.map(({ path }) => path),
    saved.panelStop.journals.map(({ path }) => path),
    "Nested Panel Stop must retain the exact live parent/child source set",
  );
  const now = Date.now();
  for (const journal of [...saved.journals, ...saved.panelStop.journals]) {
    const bytes = await readFile(journal.path);
    assert.ok(bytes.length >= journal.byteLength, "Shutdown cannot truncate a journal");
    assert.equal(
      digest(bytes.subarray(0, journal.byteLength)),
      journal.sha256,
      "Shutdown must preserve every observed journal byte, including tools, messages and custom entries",
    );
    if (bytes.length === journal.byteLength) continue;
    const suffix = bytes.subarray(journal.byteLength).toString("utf8");
    assert.equal(bytes.at(-1), 10);
    const lines = suffix.split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, 1, "Shutdown may append at most one normal exit per journal");
    const exit = JSON.parse(lines[0]);
    assert.equal(exit.type, "custom");
    assert.equal(exit.customType, "session_exit");
    assert.equal(exit.data?.reason, "dispose");
    assert.equal(exit.data?.kind, "normal");
    assert.deepEqual(
      exit.data,
      {
        reason: "dispose",
        kind: "normal",
        recordedAt: exit.data.recordedAt,
      },
      "Completed histories cannot acquire pending tool diagnostics at shutdown",
    );
    assert.equal(exit.parentId, journal.tailId, "Exit must extend the exact observed tail");
    assert.equal(typeof exit.id, "string");
    assert.ok(exit.id.length > 0 && exit.id !== journal.tailId);
    const recordedAt = Date.parse(exit.data.recordedAt);
    assert.ok(
      recordedAt >= Date.parse(saved.journalsObservedAt) && recordedAt <= now,
      "Appended exit must belong to the observed live-to-shutdown interval",
    );
    assert.ok(Date.parse(exit.timestamp) >= recordedAt && Date.parse(exit.timestamp) <= now);
  }
  const snapshot = recordSnapshot(records);
  assert.deepEqual(snapshot.parentMessages, saved.snapshot.parentMessages);
  assert.deepEqual(
    snapshot.parentEntries.slice(0, saved.snapshot.parentEntries.length),
    saved.snapshot.parentEntries,
  );
  assert.deepEqual(
    snapshot.children.map(({ name, rawId }) => ({ name, rawId })),
    saved.snapshot.children.map(({ name, rawId }) => ({ name, rawId })),
  );
  const journals = await captureAgentJournals(records);
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        ...saved,
        snapshot,
        journals,
        panelStop,
        journalPhase: "post-shutdown",
      },
      null,
      2,
    ),
  );
}

export async function recoverAgents({ page, runtime, saved, evidenceDir, taskIds, runId }) {
  assert.equal(saved.runId, runId);
  assert.equal(saved.runRoot, runtime.runRoot);
  assert.equal(
    saved.journalPhase,
    "post-shutdown",
    "Cold recovery requires the owned-shutdown receipt",
  );
  assert.notEqual(
    saved.launcherPid,
    runtime.launcherPid,
    "Cold recovery needs a fresh real process",
  );
  const parentId = saved.parentId;
  const children = saved.children;
  const failed = saved.failed;
  const controlled = saved.controlled;
  const receipt = saved;
  assert.equal((await readMockRequests(runtime)).calls.length, 0);
  const parent = page.getByTestId(`task-item-${parentId}`);
  await parent.waitFor({ state: "visible" });
  await parent.click();
  await reveal(page, page.getByText("AGENTS_ALL_COMPLETED", { exact: true }));
  await assertAgentCount(page, 0);
  const todo = await openTodoPanel(page);
  await todo.getByText("AGENTS_PHASE", { exact: true }).first().waitFor({ state: "visible" });
  // 中文原因：冷恢复读取同一条目状态与进度，不期待独立面板不存在的状态文案。
  const restoredTodo = todo.getByRole("listitem");
  assert.equal(await restoredTodo.count(), 1);
  assert.equal(await restoredTodo.getAttribute("data-plan-status"), "completed");
  await todo.getByText(/^1\s*\/\s*1$/u).waitFor({ state: "visible" });
  assert.equal(await todo.getByText("AGENTS_REPLACEMENT", { exact: true }).count(), 0);
  assert.equal(await todo.getByText("AGENTS_PRELUDE_ITEM", { exact: true }).count(), 0);
  const records = await inspectRecords(runtime, parentId, children, {
    failure: failed,
    control: controlled,
  });
  assert.deepEqual(
    recordSnapshot(records),
    saved.snapshot,
    "Cold recovery must preserve final parent messages, automatic deliveries and all real child records",
  );
  assert.deepEqual(
    await captureAgentJournals(records),
    saved.journals,
    "Cold recovery cannot change any parent or child journal bytes",
  );
  assert.deepEqual(
    await taskIds(),
    saved.sidebar,
    "Cold recovery cannot append, duplicate or reorder sidebar tasks",
  );
  await assertDetails(page, children, records, parentId, evidenceDir, "recovery");
  await assertFailedChild(page, failed, parentId);
  await openAgentPanel(page);
  await assertInteractionPage(page, runtime, records, parentId, evidenceDir, "recovery");
  // 中文原因：交互页关闭后仍停留在状态面板/侧栏上下文；已停止代理的公开入口是
  // 「已结束」目录，不是假定当前虚拟化主时间线已挂载该代理的派发卡片。
  const agents = await openAgentPanel(page);
  await agents.getByRole("button", { name: /^(?:已结束|Ended)\s+5$/u }).click();
  const directory = page
    .getByRole("tabpanel")
    .and(page.locator('[data-state="active"]'))
    .filter({ has: page.getByRole("heading", { name: /^(?:子智能体目录|Subagents)$/u }) });
  await directory.waitFor({ state: "visible" });
  const directoryTab = page
    .locator('[data-side-pane-tab-type="subagent-directory"]')
    .and(page.locator(`[data-side-pane-tab-id$=":${encodeURIComponent(parentId)}"]`));
  assert.equal(await directoryTab.count(), 1, "The ended directory must belong to this parent");
  const stopped = directory.getByRole("button").filter({
    has: page.getByText(`AGENTS_CHILD_${controlled.name}`, { exact: true }),
  });
  await stopped.waitFor({ state: "visible" });
  assert.equal(await stopped.count(), 1, "Exactly one persisted controlled assignment must open");
  await stopped.click();
  const route = `omp-subagent:${controlled.rawId}@${parentId}`;
  const pane = page
    .getByRole("tabpanel")
    .and(page.locator('[data-state="active"]'))
    .locator(`[data-subagent-session-id="${route}"]`);
  await pane.waitFor({ state: "visible" });
  await assertReadonly(pane, /已取消|已停止|已中断|Canceled|Cancelled|Stopped/u);
  await reveal(page, pane.getByText("AGENTS_CONTROL_STEER", { exact: true }), pane);
  const heartbeat = records.extras.control.entries
    .map((entry) => entry.message)
    .findLast(
      (message) =>
        message?.role === "toolResult" &&
        /^agents-control-heartbeat-\d+$/u.test(message.toolCallId) &&
        message.isError === false,
    );
  assert.ok(heartbeat, "The controlled journal must retain a successful real heartbeat");
  const persistedHeartbeat = pane.locator(`[data-tool-call-id="${heartbeat.toolCallId}"]`);
  await reveal(page, persistedHeartbeat, pane);
  assert.equal(await persistedHeartbeat.count(), 1, "The persisted heartbeat must render once");
  assert.equal(await persistedHeartbeat.getAttribute("data-status"), "completed");
  assert.deepEqual(
    await captureAgentJournals(records),
    saved.journals,
    "Opening the stopped child through its directory must preserve every persisted journal byte",
  );
  await recoverPanelStop({ page, runtime, saved: saved.panelStop, evidenceDir });
  await parent.click();
  assert.equal(
    (await readMockRequests(runtime)).calls.length,
    0,
    "No cold historical view may re-execute a model",
  );
  return { parentId, children, failed, controlled, receipt };
}
