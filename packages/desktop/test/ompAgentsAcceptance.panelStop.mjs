import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { readMockRequests, reveal } from "./ompMockInteractions.assertions.mjs";
import {
  acknowledge,
  assertAgentCount,
  assertReadonly,
  childTab,
  eventually,
  openAgentPanel,
  openChild,
  submit,
} from "./ompAgentsAcceptance.assertions.mjs";
import { jsonlFiles, readEntries } from "./ompAgentsAcceptance.records.mjs";
import {
  assertTaskArguments,
  barrier,
  blocksOf,
  promptOf,
  publicDispatchIds,
  taskArgs,
} from "./ompAgentsAcceptance.protocol.mjs";

const parentPrompt = "AGENTS_PANEL_STOP_PARENT";
const assignment = "AGENTS_CHILD_panelStop";
const toolId = "agents-panel-stop-task";
const stopped = /已取消|已停止|已中断|Canceled|Cancelled|Stopped/u;
const output = (text) => ({ content: [text] });
const originalAssignment = (text) =>
  text === `Complete assignment thoroughly:\n\n${assignment}` ||
  /^Complete assignment thoroughly:\n\n<workpool pool="[A-Za-z0-9_-]+" batch="[A-Za-z0-9_-]+">\n(?:(?!AGENTS_CHILD_)[\s\S])*\n## Item 1\nAGENTS_CHILD_panelStop\n<\/workpool>$/u.test(
    text,
  );

/** Its own task/result/barrier state cannot alter the original five-child/source17 scenario. */
export function createPanelStopModel() {
  const state = { issued: false, held: false, aborted: false, stopDelivered: false, effort: 0 };
  let args;
  let publicResult;
  return {
    snapshot: () => ({ ...state, args, publicResult }),
    async handler(context, options) {
      const prompts = context.messages
        .filter((message) => message.role === "user")
        .map((message) => promptOf(message.content));
      const last = prompts.at(-1) ?? "";
      if (last === `<user>\n${assignment}\n</user>`) {
        assert.equal(state.issued, true);
        return output("<title>Acceptance compact Stop</title>");
      }
      if (
        state.issued &&
        last.startsWith("State:\n<solution_space>") &&
        last.endsWith("Do not execute this state; judge it only.")
      ) {
        assert.equal(state.effort++, 0, "Only the actual panel task effort request is allowed");
        return output("low");
      }
      if (prompts.some(originalAssignment)) {
        assert.equal(state.issued, true, "The child must originate in this real task dispatch");
        assert.equal(state.held, false, "Held compact child may not execute twice");
        assert.equal(options.modelId, "scripted");
        state.held = true;
        try {
          await barrier(new Promise(() => {}), options.signal);
          assert.fail("Only actual cancellation may end the compact Stop child");
        } catch (error) {
          assert.equal(
            options.signal.aborted,
            true,
            "Never convert a model failure into cancellation",
          );
          state.aborted = true;
          throw error;
        }
      }
      if (!prompts.includes(parentPrompt)) return undefined;
      if (!state.issued) {
        assert.equal(options.modelId, "scripted");
        args = taskArgs(context, ["panelStop"]);
        state.issued = true;
        return { content: [{ type: "toolCall", id: toolId, name: "task", arguments: args }] };
      }
      const result = blocksOf(context.messages, "user", "tool_result").filter(
        (part) => part.tool_use_id === toolId,
      );
      assert.equal(result.length, 1, "Parent must receive its exact actual task result");
      assert.equal(result[0].is_error, false);
      if (!publicResult) {
        publicResult = result[0];
        return output("AGENTS_PANEL_STOP_READY");
      }
      assert.equal(state.aborted, true, "No parent stop completion before the real HTTP abort");
      assert.match(last, /abort|cancel|stop/iu);
      assert.equal(state.stopDelivered, false);
      state.stopDelivered = true;
      return output("AGENTS_PANEL_STOPPED");
    },
  };
}

async function sources(runtime, parentIdentity) {
  const files = await jsonlFiles(join(runtime.configRoot, "agent", "sessions"));
  // 中文原因：侧栏 live 别名不保证回写为 UUID；用唯一原始派发工具 ID 关联权威父会话。
  const parents = [];
  for (const path of files.filter((file) => /_[0-9a-f-]{36}\.jsonl$/iu.test(basename(file)))) {
    const entries = await readEntries(path);
    if (
      entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content?.some((part) => part.type === "toolCall" && part.id === toolId),
      )
    )
      parents.push({ path, entries });
  }
  assert.equal(parents.length, 1, "Compact Stop must have its own genuine parent JSONL");
  const { path: parentPath, entries } = parents[0];
  const parentId = entries.find((entry) => entry.type === "session")?.id;
  assert.match(parentId, /^[0-9a-f-]{36}$/iu);
  if (!parentIdentity.startsWith("omp-session-")) assert.equal(parentId, parentIdentity);
  assert.ok(
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        promptOf(entry.message.content) === parentPrompt,
    ),
  );
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const calls = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "toolCall" && part.name === "task" && part.id === toolId);
  assert.equal(calls.length, 1);
  assertTaskArguments(calls[0], ["panelStop"]);
  const results = messages.filter(
    (message) =>
      message.role === "toolResult" && message.toolName === "task" && message.toolCallId === toolId,
  );
  assert.equal(results.length, 1);
  assert.notEqual(results[0].isError, true);
  const progress = results[0].details?.progress;
  assert.ok(Array.isArray(progress));
  assert.equal(progress.length, 1);
  const matches = progress.filter((child) => child.assignment === assignment);
  assert.equal(matches.length, 1, "Use the entire actual task assignment, never order or title");
  const actual = matches[0];
  assert.equal(actual.agent, "task");
  assert.ok(["running", "pending"].includes(actual.status));
  assert.match(actual.id, /^[A-Za-z0-9_-]+$/u);
  const childPath = join(parentPath.slice(0, -6), `${actual.id}.jsonl`);
  assert.ok(files.includes(childPath), "The real raw ID must own an independently persisted child");
  const childEntries = await readEntries(childPath);
  assert.equal(childEntries.find((entry) => entry.type === "session")?.parentSession, parentPath);
  const assignments = childEntries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      originalAssignment(promptOf(entry.message.content)),
  );
  assert.equal(
    assignments.length,
    1,
    "Require exactly one complete original framed child assignment",
  );
  return { parentId, parentPath, childPath, entries, childEntries, rawId: actual.id };
}

function assertAborted(record) {
  const messages = record.childEntries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  assert.ok(
    messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
    "Native child JSONL assistant.stopReason=aborted, not an accepted stopping ACK, proves cancellation",
  );
  const yields = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "toolCall" && part.name === "yield");
  assert.equal(yields.length, 0, "The held child must not yield a manufactured successful result");
}
const fingerprint = (record) =>
  createHash("sha256")
    .update(JSON.stringify([record.entries, record.childEntries]))
    .digest("hex");

async function panelStopSnapshot(record) {
  const journals = await Promise.all(
    [
      [record.parentPath, record.entries],
      [record.childPath, record.childEntries],
    ].map(async ([path, entries]) => {
      const bytes = await readFile(path);
      assert.equal(bytes.at(-1), 10, "Panel Stop journal must end at a complete record");
      assert.deepEqual(
        bytes
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
        entries,
        "Panel Stop fingerprint and byte baseline must describe the same exact journal",
      );
      return {
        path,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        tailId: entries.at(-1).id,
      };
    }),
  );
  return { snapshot: fingerprint(record), journals };
}

export async function inspectPanelStopReceipt(runtime, saved) {
  const record = await sources(runtime, saved.parentId);
  assert.equal(record.rawId, saved.child.rawId);
  assertAborted(record);
  return { ...saved, ...(await panelStopSnapshot(record)) };
}
const isAssignmentRequest = (call) =>
  call.messages.some(
    (message) => message.role === "user" && originalAssignment(promptOf(message.content)),
  );

export async function exercisePanelStop({ page, runtime, evidenceDir, taskIds }) {
  const before = await taskIds();
  await page.getByTestId("task-new-button").click();
  await submit(page, parentPrompt);
  await acknowledge(page, "AGENTS_PANEL_STOP_READY");
  const added = (await taskIds()).filter((id) => !before.includes(id));
  assert.equal(
    added.length,
    1,
    "Compact Stop must not reuse or mutate the original source17 parent",
  );
  await eventually(
    () => readMockRequests(runtime),
    (value) => value.acceptance.panelStop?.held === true,
    "A separately dispatched real child must hold an actual HTTP request",
  );
  const record = await sources(runtime, added[0].slice("task-item-".length));
  const parentId = record.parentId;
  const liveParent = await page
    .getByTestId("v4-composer-input")
    .locator("xpath=ancestor::*[@data-session-id][1]")
    .getAttribute("data-session-id");
  assert.ok(liveParent && liveParent !== "draft");
  const child = {
    name: "panelStop",
    rawId: record.rawId,
    liveParent,
    canonicalParent: parentId,
    route: `omp-subagent:${record.rawId}@${liveParent}`,
  };
  const open = page.getByTestId(`v4-subagent-open-side-pane-${child.route}`);
  await reveal(page, open);
  assert.equal(await open.count(), 1);
  assert.equal(
    await open.locator("xpath=ancestor::*[@data-session-id][1]").getAttribute("data-session-id"),
    liveParent,
  );
  const card = open.locator("xpath=ancestor::*[@data-tool-call-id][1]");
  assert.equal(await card.getAttribute("data-tool-call-id"), `omp-subagent:${record.rawId}`);
  await eventually(
    () => card.innerText(),
    (text) => text.includes(assignment),
    "The exact real child card assignment",
  );
  await assertAgentCount(page, 1);
  const panel = await openAgentPanel(page);
  const row = panel.locator(
    `li[data-child-session-id="${child.route}"][data-work-status="running"]`,
  );
  await row.waitFor({ state: "visible" });
  assert.equal(await row.count(), 1);
  const workId = await row.getAttribute("data-work-id");
  assert.ok(
    workId?.trim(),
    "The genuine compact row must expose its authoritative nonempty work ID",
  );
  const stop = row.getByTestId(`v4-background-work-cancel-${workId}`);
  await stop.waitFor({ state: "visible" });
  assert.equal(await stop.isEnabled(), true);
  const beforeStop = await readMockRequests(runtime);
  publicDispatchIds(
    beforeStop.acceptance.panelStop.publicResult,
    [{ name: "panelStop", rawId: record.rawId }],
    ["panelStop"],
  );
  const requests = beforeStop.calls.filter(isAssignmentRequest);
  assert.equal(requests.length, 1, "Pin the exact held HTTP request before clicking compact Stop");
  const request = requests[0];
  assert.ok(request.requestId && request.aborted === false && request.completed === false);
  await stop.click();
  await eventually(
    () => readMockRequests(runtime),
    (value) =>
      value.calls.some(
        (call) =>
          call.requestId === request.requestId && call.aborted === true && call.completed === false,
      ),
    "The same real held HTTP request must abort via the compact control",
  );
  await acknowledge(page, "AGENTS_PANEL_STOPPED");
  const final = await eventually(
    () => sources(runtime, parentId),
    (value) =>
      value.childEntries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "aborted",
      ),
    "Actual native child aborted record",
  );
  assertAborted(final);
  await assertAgentCount(page, 0);
  assert.equal(await row.count(), 0, "The canceled target must disappear from running status rows");
  const pane = await openChild(page, child);
  await assertReadonly(pane, stopped);
  await childTab(page, child)
    .getByRole("button", { name: /关闭|Close/u })
    .click();
  await assertReadonly(await openChild(page, child), stopped);
  await captureIsolationScreenshot(join(evidenceDir, "agents-live-panel-stop.png"));
  return {
    parentId,
    child,
    workId,
    requestId: request.requestId,
    ...(await panelStopSnapshot(final)),
  };
}

export async function recoverPanelStop({ page, runtime, saved, evidenceDir }) {
  assert.ok(saved?.parentId && saved.child?.rawId && saved.requestId);
  const callsBefore = (await readMockRequests(runtime)).calls.length;
  await page.getByTestId(`task-item-${saved.parentId}`).click();
  await acknowledge(page, "AGENTS_PANEL_STOPPED");
  await assertAgentCount(page, 0);
  const panel = await openAgentPanel(page);
  assert.equal(await panel.locator('[data-work-status="running"]').count(), 0);
  const record = await sources(runtime, saved.parentId);
  assert.equal(record.rawId, saved.child.rawId);
  assertAborted(record);
  assert.equal(
    fingerprint(record),
    saved.snapshot,
    "Cold recovery preserves actual native parent/child records",
  );
  assert.deepEqual(
    (await panelStopSnapshot(record)).journals,
    saved.journals,
    "Cold Panel Stop recovery preserves every validated parent/child journal byte",
  );
  await assertReadonly(await openChild(page, saved.child, saved.parentId), stopped);
  await childTab(page, saved.child, saved.parentId)
    .getByRole("button", { name: /关闭|Close/u })
    .click();
  await assertReadonly(await openChild(page, saved.child, saved.parentId), stopped);
  await captureIsolationScreenshot(join(evidenceDir, "agents-recovery-panel-stop.png"));
  assert.deepEqual(
    await inspectPanelStopReceipt(runtime, saved),
    saved,
    "All cold Panel Stop detail views preserve the same finalized nested receipt",
  );
  assert.equal(
    (await readMockRequests(runtime)).calls.length,
    callsBefore,
    "Cold canceled-child details must remain read-only without executing any model",
  );
}
