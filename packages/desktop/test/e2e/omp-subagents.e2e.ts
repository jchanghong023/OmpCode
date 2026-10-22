import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_MODEL_SELECT_GROUP, TID_CHAT_MODEL_SELECT_ITEM, TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_BACK_BUTTON, TID_SETTINGS_SECTION_NAV,
  TID_SUBAGENT_ROW, TID_TASK_SETTINGS_BUTTON, TID_V4_COMPOSER_INPUT,
  TID_TOOL_SUMMARY_TRIGGER,
  TID_V4_SESSION_PANE, TID_V4_STOP, TID_V4_ROW,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E, sendV4Prompt, switchV4Mode, switchV4Model,
  selectV4TaskById,
} from "./helpers/v4-conversation.js";
import { OMP_MODEL_ID, OMP_PROVIDER_ID, type ModelRequest } from "./helpers/omp-integration-fixture.js";
import { SA_AGENT, SA_SIBLING, SA_PROOF, SA_RELEASE } from "./helpers/omp-subagents-fixture.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart-runtime.js";
import { useEnglishSubagentSettings } from "./helpers/subagent-refresh-conversation.js";

let requestFloor = 0;
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("Isolated OMP provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Provider ledger: ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
/**
 * Requests that actually execute a turn. Tool-less requests are title/naming
 * helpers, and a cold read may legitimately refresh them; only execution
 * requests must stay unchanged across a restart.
 */
async function executionRequestCount(): Promise<number> {
  return (await requests()).filter((request) => Boolean(request.tools?.length)).length;
}
async function requestContaining(marker: string): Promise<ModelRequest> {
  let found: ModelRequest | undefined;
  await browser.waitUntil(async () => {
    found = (await requests()).slice(requestFloor).find((request) => JSON.stringify(request.messages).includes(marker));
    return Boolean(found);
  }, { timeout: 30000, timeoutMsg: `No real native provider request: ${marker}` });
  return found!;
}
async function screenshot(name: string) {
  await browser.saveScreenshot(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}.png`));
}
/**
 * Polls only the pane identity and stop-control presence. `V4PaneSnapshot`
 * forces `timeline.innerText`, which re-lays out the whole virtualized
 * timeline on every poll and can stall the renderer on long child transcripts.
 * Text assertions keep using `timelineContains`, which reads only the newest
 * rendered rows instead of forcing layout of the entire virtualized timeline.
 */
function paneControlState(): Promise<{ sessionId: string | null; canStop: boolean }> {
  return browser.execute(
    (paneTestId, stopTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      return {
        sessionId: pane?.getAttribute("data-session-id") ?? null,
        canStop: Boolean(pane?.querySelector(`[data-testid="${stopTestId}"]`)),
      };
    },
    testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    TID_V4_STOP,
  );
}
async function sessionId() {
  let bound: string | null = null;
  await browser.waitUntil(async () => {
    const { sessionId: current } = await paneControlState();
    bound = current && current !== "draft" ? current : null;
    return Boolean(bound);
  }, { timeout: 30000, timeoutMsg: "OMP parent did not bind" });
  return bound!;
}
async function draft(model = OMP_MODEL_ID) {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await switchV4Model(OMP_PROVIDER_ID, model, "disabled");
  await switchV4Mode("yolo");
}
async function idle() {
  await browser.waitUntil(async () => !(await paneControlState()).canStop, {
    timeout: 30000,
    timeoutMsg: "Native parent did not settle",
  });
}
/**
 * Text assertions only need the newest rows: markers are emitted last. Reading
 * the whole virtualized timeline via `timeline.innerText` is a 60s-class layout
 * on a ~475-row conversation, so scan just the trailing rows.
 */
async function timelineContains(text: string, timeout = 30000) {
  let latest = "";
  await browser.waitUntil(async () => {
    latest = await browser.execute(
      (paneTestId, rowPrefix) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        if (!pane) return "";
        return Array.from(pane.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`))
          .slice(-40)
          .map((row) => row.innerText)
          .join("\n")
          .replace(/\u00a0/gu, " ");
      },
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
      TID_V4_ROW,
    );
    return latest.includes(text);
  }, { timeout, timeoutMsg: `v4 timeline has no ${text}; newest rows=${latest.slice(-1500)}` });
}
async function expandWorkHistory(paneSelector: string) {
  const histories = await $(paneSelector).$$(`[data-testid^="${TID_CHAT_ASSISTANT_HISTORY_TRIGGER}-"]`);
  for (const history of histories) {
    if ((await history.isDisplayed()) && (await history.getAttribute("aria-expanded")) === "false") {
      await history.scrollIntoView();
      await history.click();
    }
  }
}
const childTabSelector = (child: string) =>
  `[data-side-pane-tab-id^="subagent-session:"][data-side-pane-tab-id$=":${encodeURIComponent(child)}"]`;
/**
 * Closes the child side-pane tab through its real close button so the parent
 * conversation becomes the visible pane again. Timeline text reads return
 * empty while another side-pane tab hides the main pane.
 */
async function closeChildTab(child: string) {
  const tab = $(childTabSelector(child));
  if (!(await tab.isExisting())) return;
  const close = tab.$("button");
  await close.waitForClickable({ timeout: 15000 });
  await close.click();
  await browser.waitUntil(async () => !(await $(childTabSelector(child)).isExisting()), {
    timeout: 15000, timeoutMsg: `Subagent side tab ${child} did not close`,
  });
}
async function openChild(index = 0): Promise<string> {
  const parent = await sessionId();
  const selector = `[data-session-id="${parent}"] [data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`;
  await browser.waitUntil(async () => {
    // Child summaries live inside the normal collapsed work history.
    await expandWorkHistory(`[data-session-id="${parent}"]`);
    // `$$` exposes a chainable collection; materialize it before reading length.
    return Array.from(await $$(selector)).length > index;
  }, {
    timeout: 30000, timeoutMsg: "Native task did not project a child detail action after expanding work history",
  });
  const actions = await $$(selector);
  await actions[index]!.scrollIntoView();
  await actions[index]!.click();
  let selected: string | undefined;
  await browser.waitUntil(async () => {
    selected = await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="subagent-session:"][data-active]');
      // Production IDs contain encoded workspace and root scope before the
      // final encoded child ID; the complete tab suffix is not a session ID.
      const encoded = tab?.dataset.sidePaneTabId?.split(":").at(-1);
      if (!encoded) return undefined;
      const id = decodeURIComponent(encoded);
      const pane = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
      return pane && pane.getBoundingClientRect().width > 0 && pane.getBoundingClientRect().height > 0 && getComputedStyle(pane).visibility !== "hidden" ? id : undefined;
    });
    return Boolean(selected);
  }, { timeout: 30000, timeoutMsg: "Native child detail did not become visible" });
  return selected!;
}
async function childEvidence(child: string, text: string) {
  if (!(await $(childTabSelector(child)).isExisting())) {
    const parent = await sessionId();
    await browser.waitUntil(async () => {
      await expandWorkHistory(`[data-session-id="${parent}"]`);
      return $(`[data-testid="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-${child}"]`).isExisting();
    }, { timeout: 30000, timeoutMsg: `Child summary ${child} is not projected in its parent history` });
    await $(`[data-testid="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-${child}"]`).click();
  }
  await $(childTabSelector(child)).click();
  const pane = $(`[data-session-id="${child}"]`);
  await browser.waitUntil(async () => {
    if ((await pane.getText()).includes(text)) return true;
    const histories = await pane.$$(`[data-testid^="${TID_CHAT_ASSISTANT_HISTORY_TRIGGER}-"]`);
    for (const history of histories) {
      if ((await history.isDisplayed()) && (await history.getAttribute("aria-expanded")) === "false") {
        await history.scrollIntoView();
        await history.click();
      }
    }
    return (await pane.getText()).includes(text);
  }, {
    timeout: 30000, timeoutMsg: `Native child ${child} lacks ${text}`,
  });
  expect(await pane.$(`[data-testid^="${TID_V4_COMPOSER_INPUT}"]`).isExisting()).toBe(false);
}
async function answerChild(parent: string) {
  const body = $('[data-elicitation-dialog-body="true"]');
  await body.waitForDisplayed({ timeout: 30000 });
  expect(await body.getText()).toContain("OMP_E2E_SA_QUESTION");
  expect(await $$('[data-elicitation-dialog-body="true"]')).toHaveLength(1);
  const badge = $('[data-interaction-origin-badge="subagent"]');
  await badge.waitForDisplayed({ timeout: 30000 });
  expect(await badge.getAttribute("title")).not.toBe("");
  const owner = await browser.execute(() => document.querySelector('[data-elicitation-dialog-body="true"]')?.closest('[data-session-id]')?.getAttribute("data-session-id"));
  expect(owner).toBe(parent);
  await body.$('button[role="option"]').click();
  const submit = $('[data-elicitation-dialog-footer="true"] button:last-child');
  if (await submit.isExisting()) await submit.click();
}

describe("OMP native subagent core / real app-server GUI", () => {
  beforeEach(async () => { requestFloor = (await requests()).length; });
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const name = this.currentTest.title.replace(/[^a-z0-9-]/giu, "-").slice(0, 100);
      await writeFile(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}-provider-requests.json`), JSON.stringify(await requests(), null, 2));
      await screenshot(`${name}-failed`);
    }
  });
  it("OMP-SA02 OMP-SA03: native task child tools, parent question, isolated concurrent session and cold read-only history", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_SA_PARENT_BASIC");
    const parent = await sessionId();
    await childRequest("OMP_E2E_SA_CHILD_BASIC");
    const child = await openChild();
    expect(child).not.toBe(parent);
    await childEvidence(child, SA_PROOF);
    await closeChildTab(child);
    await screenshot("omp-sa02-live-child");
    await draft("omp-alternate");
    await sendV4Prompt("OMP_E2E_SA_OTHER");
    const other = await sessionId();
    expect(other).not.toBe(parent);
    await timelineContains("OMP_E2E_SA_OTHER_DONE");
    await idle();
    await selectV4TaskById(parent);
    await answerChild(parent);
    await timelineContains("OMP_E2E_SA_PARENT_DONE", 60000);
    await idle();
    expect(await readFile(resolve(DEFAULT_WORKSPACE, SA_PROOF), "utf8")).toBe("OMP_E2E_SA_NATIVE_CHILD_FILE");
    expect(await waitForToolResult("OMP_E2E_SA_ANSWER")).toContain("OMP_E2E_SA_ANSWER");
    expect((await requestContaining("OMP_E2E_SA_OTHER")).model).toBe("omp-alternate");
    const otherRequests = (await requests()).filter((request) => JSON.stringify(request.messages).includes("OMP_E2E_SA_OTHER"));
    expect(otherRequests.every((request) => !JSON.stringify(request.messages).includes("OMP_E2E_SA_ANSWER"))).toBe(true);
    expect(await openChild()).toBe(child);
    await childEvidence(child, "OMP_E2E_SA_CHILD_DONE");
    await closeChildTab(child);
    const before = await executionRequestCount();
    // A real Electron/Host/OMP owner exit, not renderer business-state injection.
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(other);
    await selectV4TaskById(parent);
    expect(await openChild()).toBe(child);
    await childEvidence(child, "OMP_E2E_SA_CHILD_DONE");
    expect(await executionRequestCount()).toBe(before);
    await screenshot("omp-sa03-cold-child-history");
  });

  it("OMP-SA01: GUI child configuration create, cancel, edit, readback, actual model/tool isolation and delete", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await useEnglishSubagentSettings();
    await openSettings();
    await $('button[aria-label="New"]').click();
    await fillProfile("omp-e2e-cancelled", "omp-chat", "low", "OMP_E2E_SA_CANCELLED_CONFIG");
    await $(PROFILE_FORM).$("button=Cancel").click();
    expect(await tid(testId(TID_SUBAGENT_ROW, "omp-e2e-cancelled")).isExisting()).toBe(false);
    await tid(TID_SETTINGS_BACK_BUTTON).click();
    await openSettings();
    expect(await tid(testId(TID_SUBAGENT_ROW, "omp-e2e-cancelled")).isExisting()).toBe(false);
    await $('button[aria-label="New"]').click();
    await fillProfile(`${SA_AGENT}-draft`, OMP_MODEL_ID, "low", "OMP_E2E_SA_CONFIG_DRAFT");
    await saveProfile(`${SA_AGENT}-draft`);
    await tid(testId(TID_SUBAGENT_ROW, `${SA_AGENT}-draft`)).click();
    await fillProfile(SA_AGENT, "omp-alternate", "high", "OMP_E2E_SA_CONFIG_SAVED");
    await saveProfile(SA_AGENT);
    expect(await tid(testId(TID_SUBAGENT_ROW, `${SA_AGENT}-draft`)).isExisting()).toBe(false);
    await tid(testId(TID_SUBAGENT_ROW, SA_AGENT)).click();
    const fields = await $(PROFILE_FORM).$$('input[type="text"]');
    expect(await fields[0]!.getValue()).toBe(SA_AGENT);
    expect(await $(PROFILE_FORM).$("textarea").getValue()).toBe("OMP_E2E_SA_CONFIG_SAVED");
    expect(await $(PROFILE_FORM).$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).getAttribute("data-model-current-value")).toBe(encodeCustomModelValue(OMP_PROVIDER_ID, "omp-alternate"));
    expect(await $(PROFILE_FORM).$(`[data-testid="${TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}"]`).getText()).toContain("High");
    await $(PROFILE_FORM).$("button=Cancel").click();
    await $('button[aria-label="New"]').click();
    await fillProfile(SA_SIBLING, OMP_MODEL_ID, "low", "OMP_E2E_SA_SIBLING_CONFIG");
    await saveProfile(SA_SIBLING);
    await screenshot("omp-sa01-config-readback");
    await tid(TID_SETTINGS_BACK_BUTTON).click();
    await draft();
    await sendV4Prompt("OMP_E2E_SA_PARENT_CONFIG_SIBLING");
    const parent = await sessionId();
    const configured = await childRequest("OMP_E2E_SA_CHILD_CONFIG");
    expect(configured.model).toBe("omp-alternate");
    expect((configured as ModelRequest & { reasoning_effort?: string }).reasoning_effort).toBe("high");
    expect(JSON.stringify(configured.messages.filter((message) => ["system", "developer"].includes(message.role)))).toContain("OMP_E2E_SA_CONFIG_SAVED");
    const names = (configured.tools as Array<{ function?: { name?: string }; name?: string }>).map((entry) => entry.function?.name ?? entry.name);
    expect(names).toEqual(expect.arrayContaining(["read", "write"]));
    expect(names).not.toContain("bash");
    const sibling = await childRequest("OMP_E2E_SA_CHILD_SIBLING");
    expect(sibling.model).toBe(OMP_MODEL_ID);
    expect((sibling as ModelRequest & { reasoning_effort?: string }).reasoning_effort).toBe("low");
    expect(JSON.stringify(sibling.messages)).not.toContain("OMP_E2E_SA_CONFIG_SAVED");
    await draft();
    await sendV4Prompt("OMP_E2E_SA_OTHER_CONFIG");
    const other = await sessionId();
    await timelineContains("OMP_E2E_SA_OTHER_DONE");
    await idle();
    await selectV4TaskById(parent);
    await timelineContains("OMP_E2E_SA_PARENT_DONE");
    await idle();
    const parentRequests = (await requests()).filter((request) => request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("OMP_E2E_SA_PARENT_CONFIG")));
    expect(parentRequests.every((request) => request.model === OMP_MODEL_ID)).toBe(true);
    await selectV4TaskById(other);
    await openSettings();
    for (const name of [SA_AGENT, SA_SIBLING]) {
      await tid(testId(TID_SUBAGENT_ROW, name)).$('button[title="Delete"]').click();
      await tid(TID_CONFIRM_DIALOG_CONFIRM).click();
      await browser.waitUntil(async () => !(await tid(testId(TID_SUBAGENT_ROW, name)).isExisting()), { timeout: 15000, timeoutMsg: `GUI did not delete ${name}` });
    }
    await tid(TID_SETTINGS_BACK_BUTTON).click();
    await openSettings();
    expect(await tid(testId(TID_SUBAGENT_ROW, SA_AGENT)).isExisting()).toBe(false);
    await tid(TID_SETTINGS_BACK_BUTTON).click();
  });

  it("OMP-SA04: native parent message delivery, child reply, missing recipient failure and cold receipt association", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await draft();
    await expect(readFile(resolve(DEFAULT_WORKSPACE, SA_RELEASE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await sendV4Prompt("OMP_E2E_SA_PARENT_HOLD_MESSAGE");
    const parent = await sessionId();
    const held = await childRequest("OMP_E2E_SA_CHILD_HOLD");
    expect(held.model).toBe(OMP_MODEL_ID);
    const child = await openChild();
    await childEvidence(child, "OMP_E2E_SA_GATE_RUNNING");
    await idle();
    await sendV4Prompt("OMP_E2E_SA_MESSAGE");
    await timelineContains("OMP_E2E_SA_MESSAGE_RECEIPT");
    await draft("omp-alternate");
    // The second root releases only a workspace file, never targets the child.
    // Thus the real child reply is emitted while another session is selected.
    await sendV4Prompt("OMP_E2E_SA_OTHER_MESSAGE_RELEASE");
    const other = await sessionId();
    await timelineContains("OMP_E2E_SA_OTHER_DONE");
    await idle();
    await childRequest("OMP_E2E_SA_MESSAGE_PAYLOAD");
    expect(await waitForNativeGateResult()).toContain("OMP_E2E_SA_GATE_RELEASED");
    await selectV4TaskById(parent);
    await timelineContains("OMP_E2E_SA_PARENT_CONSUMED_RECEIPT");
    await idle();
    expect(await openChild()).toBe(child);
    await childMessageEvidence(child, "OMP_E2E_SA_CHILD_RECEIPT");
    await closeChildTab(child);
    const consumed = (await requests()).filter((request) => request.messages.some((message) => message.role !== "assistant" && JSON.stringify(message.content).includes("OMP_E2E_SA_CHILD_RECEIPT")));
    expect(consumed.length).toBeGreaterThan(0);
    expect(consumed.every((request) => !JSON.stringify(request.messages).includes("OMP_E2E_SA_OTHER_MESSAGE"))).toBe(true);
    for (const request of consumed.filter((entry) => JSON.stringify(entry.messages).includes("OMP_E2E_SA_PARENT_HOLD"))) {
      expect(request.messages.filter((message) => message.role !== "assistant" && JSON.stringify(message.content).includes("OMP_E2E_SA_CHILD_RECEIPT")).length).toBeLessThanOrEqual(1);
    }
    await sendV4Prompt("OMP_E2E_SA_MISSING");
    await timelineContains("OMP_E2E_SA_MISSING_RECEIPT");
    await timelineContains("OmpMissingChild");
    await idle();
    const failed = await waitForToolResult("OmpMissingChild");
    expect(failed).toMatch(/failed|unknown|not running/iu);
    const before = await executionRequestCount();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(other);
    await selectV4TaskById(parent);
    expect(await openChild()).toBe(child);
    await childMessageEvidence(child, "OMP_E2E_SA_CHILD_RECEIPT");
    // Native tool-call parameters are finalized at the released/cold session
    // boundary, not necessarily while the live child turn is still projected.
    const originalReceipts = await messageReceipts(parent, child);
    expect(await messageReceipts(parent, child)).toEqual(originalReceipts);
    // Cold reads may refresh tool-less title/naming requests; no execution
    // request, side effect, or message identity may change.
    expect(await executionRequestCount()).toBe(before);
    await screenshot("omp-sa04-message-receipts");
  });

  it("OMP-SA05: targeted native cancel and revival retain identity and checkpoint while sibling and another session complete", async function () {
    this.timeout(150000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await draft();
    await sendV4Prompt("OMP_E2E_SA_PARENT_HOLD_WITH_SIBLING");
    const parent = await sessionId();
    await childRequest("OMP_E2E_SA_CHILD_HOLD");
    const child = await openChild();
    await childEvidence(child, "OMP_E2E_SA_CHILD_HOLD_RUNNING");
    await closeChildTab(child);
    await childRequest("OMP_E2E_SA_CHILD_SIBLING_HOLD");
    const sibling = await openChild(1);
    expect(sibling).not.toBe(child);
    await childEvidence(sibling, "OMP_E2E_SA_SIBLING_RUNNING");
    await closeChildTab(sibling);
    await idle();
    await sendV4Prompt("OMP_E2E_SA_CANCEL");
    await timelineContains("OMP_E2E_SA_CANCEL_RECEIPT");
    await timelineContains("Cancelled");
    await idle();
    // The cancel releases the live child and its pane switches to the cold
    // projection. Do not keep clicking that released pane's history here:
    // assert the real terminal facts (journal + written checkpoint) instead,
    // and re-open the detail only after native revival makes it live again.
    const cancelledJournal = await nativeJournal(child, (entries) => entries.some((entry) => entry.message?.stopReason === "aborted"));
    expect(cancelledJournal.entries.some((entry) => entry.message?.stopReason === "aborted")).toBe(true);
    expect(await readFile(resolve(DEFAULT_WORKSPACE, "omp-e2e-sa-hold.txt"), "utf8")).toBe("OMP_E2E_SA_CHECKPOINT");
    await childEvidence(sibling, "OMP_E2E_SA_SIBLING_RUNNING");
    await closeChildTab(sibling);
    await sendV4Prompt("OMP_E2E_SA_RELEASE_SIBLING");
    await timelineContains("OMP_E2E_SA_RELEASE_SIBLING_RECEIPT");
    await childEvidence(sibling, "OMP_E2E_SA_SIBLING_DONE");
    await closeChildTab(sibling);
    await idle();
    await draft("omp-alternate");
    await sendV4Prompt("OMP_E2E_SA_OTHER_CANCEL");
    await timelineContains("OMP_E2E_SA_OTHER_DONE");
    await idle();
    await selectV4TaskById(parent);
    await sendV4Prompt("OMP_E2E_SA_RESUME");
    await timelineContains("OMP_E2E_SA_RESUME_RECEIPT");
    expect(await openChild()).toBe(child);
    await childEvidence(child, "OMP_E2E_SA_RESUMED_WITH_CONTEXT");
    await closeChildTab(child);
    const resumed = await childRequest("OMP_E2E_SA_RESUME_PAYLOAD");
    expect(JSON.stringify(resumed.messages)).toContain("OMP_E2E_SA_CHECKPOINT");
    const history = JSON.stringify(resumed.messages);
    expect(history.match(/omp-e2e-sa-hold.txt/gu)?.length).toBeGreaterThan(0);
    expect(resumed.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes("omp-e2e-sa-hold.txt"))).toHaveLength(1);
    expect(await readFile(resolve(DEFAULT_WORKSPACE, "omp-e2e-sa-hold.txt"), "utf8")).toBe("OMP_E2E_SA_CHECKPOINT");
    const spawnCalls = resumed.messages.filter((message) => message.role === "assistant" && JSON.stringify(message).includes('\"task\"'));
    expect(spawnCalls).toHaveLength(0);
    // The parent turn holds the revived child; it settles only after that child
    // returns its final text and the real task completion reaches the parent.
    await timelineContains("OMP_E2E_SA_RESUMED_WITH_CONTEXT");
    await idle();
    await screenshot("omp-sa05-cancel-revive");
  });

  it("OMP-SA06: deterministic child HTTP failure and native tool error remain terminal after owner exit without blocking another session", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await draft();
    await sendV4Prompt("OMP_E2E_SA_PARENT_ERROR");
    const failedParent = await sessionId();
    await childRequest("OMP_E2E_SA_CHILD_ERROR");
    await timelineContains("OMP_E2E_SA_RATE_LIMIT", 60000);
    await idle();
    const failedChild = await openChild();
    await childEvidence(failedChild, "OMP_E2E_SA_RATE_LIMIT");
    // A non-retryable child failure must spawn exactly one real actor. Retries
    // would appear as additional initial child requests for this assignment.
    const failureSpawns = (await requests()).slice(requestFloor).filter((request) =>
      Boolean(request.tools?.length) &&
      !request.messages.some((message) => message.role === "assistant") &&
      request.messages.some((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("OMP_E2E_SA_CHILD_ERROR")));
    expect(failureSpawns).toHaveLength(1);
    await draft();
    await sendV4Prompt("OMP_E2E_SA_PARENT_TOOL_ERROR");
    const toolParent = await sessionId();
    await childRequest("OMP_E2E_SA_CHILD_TOOL_ERROR");
    const toolChild = await openChild();
    await childEvidence(toolChild, "omp-e2e-sa-intentionally-missing.txt");
    await childEvidence(toolChild, "OMP_E2E_SA_TOOL_FAILURE_RECORDED");
    expect(await waitForToolResult("omp-e2e-sa-intentionally-missing.txt")).toMatch(/ENOENT|no such file|not found|does not exist|cannot find/iu);
    await closeChildTab(toolChild);
    await draft();
    await sendV4Prompt("OMP_E2E_SA_PARENT_HOLD");
    const ownerParent = await sessionId();
    await childRequest("OMP_E2E_SA_CHILD_HOLD");
    const orphan = await openChild();
    await childEvidence(orphan, "OMP_E2E_SA_CHILD_HOLD_RUNNING");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await selectV4TaskById(ownerParent);
    expect(await openChild()).toBe(orphan);
    await browser.waitUntil(async () => {
      const pane = $(`[data-session-id="${orphan}"]`);
      return /interrupted|cancelled|aborted|stopped|中断|取消|已停止/iu.test(await pane.getText());
    }, { timeout: 30000, timeoutMsg: "Child lost its native owner but still projects running" });
    const count = await executionRequestCount();
    await browser.refresh();
    await selectV4TaskById(failedParent);
    expect(await openChild()).toBe(failedChild);
    await childEvidence(failedChild, "OMP_E2E_SA_RATE_LIMIT");
    await selectV4TaskById(toolParent);
    expect(await openChild()).toBe(toolChild);
    await childEvidence(toolChild, "OMP_E2E_SA_TOOL_FAILURE_RECORDED");
    await closeChildTab(toolChild);
    expect(await executionRequestCount()).toBe(count);
    await draft("omp-alternate");
    await sendV4Prompt("OMP_E2E_SA_OTHER_AFTER_OWNER_EXIT");
    await timelineContains("OMP_E2E_SA_OTHER_DONE");
    await idle();
    await screenshot("omp-sa06-owner-terminal");
  });
});

const tid = (id: string) => $(`[data-testid="${id}"]`);
const PROFILE_FORM = `form:has(input[type="text"]):has([data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"])`;
async function openSettings() {
  await tid(TID_TASK_SETTINGS_BUTTON).click();
  await tid(testId(TID_SETTINGS_SECTION_NAV, "subagents")).click();
  await $('button[aria-label="New"]').waitForDisplayed({ timeout: 15000 });
}
async function fillProfile(name: string, model: string, effort: string, prompt: string) {
  const form = $(PROFILE_FORM);
  await form.waitForDisplayed({ timeout: 15000 });
  const inputs = await form.$$('input[type="text"]');
  await inputs[0]!.setValue(name);
  await inputs[1]!.setValue(`Native child ${name}`);
  await form.$("textarea").setValue(prompt);
  await form.$(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`).click();
  const item = testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(OMP_PROVIDER_ID, model));
  if (!(await tid(item).isExisting())) {
    await tid(testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${OMP_PROVIDER_ID}`)).click();
  }
  await tid(item).waitForDisplayed({ timeout: 15000 });
  await tid(item).click();
  await form.$(`[data-testid="${TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER}"]`).click();
  await tid(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, effort)).click();
  if (!(await form.$('[role="checkbox"]').isExisting())) {
    const combos = await form.$$('[role="combobox"]');
    for (const combo of combos) {
      if ((await combo.getText()).includes("Default all permissions")) await combo.click();
    }
    await $('[role="option"]=Custom allowed tools').click();
  }
  const checks = await form.$$('[role="checkbox"]');
  const allowed = ["read", "write"];
  const displayed: string[] = [];
  for (const checkbox of checks) displayed.push((await checkbox.getText()).trim().toLowerCase());
  expect(displayed).toEqual(expect.arrayContaining(allowed));
  for (const checkbox of checks) {
    const selected = (await checkbox.getAttribute("aria-checked")) === "true";
    if (selected !== allowed.includes((await checkbox.getText()).trim().toLowerCase())) await checkbox.click();
  }
}
async function saveProfile(name: string) {
  await $(PROFILE_FORM).$('button[type="submit"]').click();
  await browser.waitUntil(async () => !(await $(PROFILE_FORM).isExisting()), { timeout: 15000, timeoutMsg: `Native GUI profile ${name} did not save` });
  await tid(testId(TID_SUBAGENT_ROW, name)).waitForDisplayed({ timeout: 15000 });
}
async function childRequest(marker: string): Promise<ModelRequest> {
  let found: ModelRequest | undefined;
  await browser.waitUntil(async () => {
    found = (await requests()).slice(requestFloor).find((request) => {
      if (!request.tools?.length) return false;
      const users = request.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
      return users.some((value) => value.includes(marker)) && !users.some((value) => value.includes("OMP_E2E_SA_PARENT"));
    });
    return Boolean(found);
  }, { timeout: 30000, timeoutMsg: `No actual child provider request ${marker}` });
  return found!;
}
async function waitForToolResult(marker: string): Promise<string> {
  let result: string | undefined;
  await browser.waitUntil(async () => {
    result = (await requests()).slice(requestFloor).flatMap((request) => request.messages)
      .filter((message) => message.role === "tool")
      .map((message) => JSON.stringify(message.content))
      .find((content) => content.includes(marker));
    return Boolean(result);
  }, { timeout: 30000, timeoutMsg: `Missing actual native tool result ${marker}` });
  return result!;
}

interface NativeEntry {
  type: string;
  id?: string;
  parentSession?: string;
  customType?: string;
  message?: {
    role: string;
    toolName?: string;
    toolCallId?: string;
    stopReason?: string;
    content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown>; partialArgs?: string }>;
    details?: { message?: { from?: string; to?: string; receipts?: Array<{ id?: string; ts?: number; to?: string; outcome?: string }> } };
  };
}
async function nativeJournal(
  id: string,
  ready?: (entries: NativeEntry[]) => boolean | { callFound: boolean; resultFound: boolean },
): Promise<{ path: string; entries: NativeEntry[] }> {
  const root = process.env.PI_CODING_AGENT_DIR;
  if (!root) throw new Error("Isolated native session root missing");
  const diagnostic = {
    journalPath: null as string | null,
    entries: 0,
    callFound: false,
    resultFound: false,
    lastReadError: null as string | null,
    toolResults: [] as Array<{ index: number; toolName: string | null; hasMessageDetails: boolean; from: string | null; to: string | null }>,
  };
  async function find(directory: string): Promise<{ path: string; entries: NativeEntry[] } | undefined> {
    try {
      // Keep the typed Dirent overload; directories can disappear during
      // native journal rotation without invalidating other readable files.
      const current = await readdir(directory, { withFileTypes: true });
      for (const file of current) {
        const path = resolve(directory, file.name);
        if (file.isDirectory()) {
          const nested = await find(path);
          if (nested) return nested;
        } else if (file.isFile() && file.name.endsWith(".jsonl")) {
          try {
            const source = await readFile(path, "utf8");
            const entries: NativeEntry[] = [];
            const lines = source.split("\n");
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index]!;
              if (!line.trim()) continue;
              try {
                entries.push(JSON.parse(line) as NativeEntry);
              } catch (error) {
                diagnostic.lastReadError = `${path}:${index + 1}: ${String(error)}`;
              }
            }
            if (entries.some((entry) => entry.type === "session" && entry.id === id)) return { path, entries };
          } catch (error) {
            diagnostic.lastReadError = `${path}: ${String(error)}`;
          }
        }
      }
    } catch (error) {
      diagnostic.lastReadError = `${directory}: ${String(error)}`;
    }
    return undefined;
  }
  let found: { path: string; entries: NativeEntry[] } | undefined;
  if (ready) {
    const timeoutMsg = `Native journal ${id} did not persist the expected execution facts`;
    try {
      await browser.waitUntil(async () => {
        // Every observation re-opens native files; only complete, parseable
        // records from this observation can satisfy the persistence boundary.
        found = await find(resolve(root, "sessions"));
        diagnostic.entries = found?.entries.length ?? 0;
        diagnostic.toolResults = (found?.entries ?? []).flatMap((entry, index) => entry.message?.role === "toolResult" ? [{
          index,
          toolName: entry.message.toolName ?? null,
          hasMessageDetails: Boolean(entry.message.details?.message),
          from: entry.message.details?.message?.from ?? null,
          to: entry.message.details?.message?.to ?? null,
        }] : []);
        diagnostic.callFound = false;
        diagnostic.resultFound = false;
        if (!found) return false;
        diagnostic.journalPath = found.path;
        const state = ready(found.entries);
        if (typeof state === "boolean") {
          diagnostic.resultFound = state;
          return state;
        }
        diagnostic.callFound = state.callFound;
        diagnostic.resultFound = state.resultFound;
        return state.callFound && state.resultFound;
      }, { timeout: 30000, timeoutMsg });
    } catch (error) {
      throw new Error(`${timeoutMsg}; diagnostics=${JSON.stringify(diagnostic)}`, { cause: error });
    }
  } else {
    found = await find(resolve(root, "sessions"));
  }
  if (!found) throw new Error(`No real native journal for GUI session ${id}`);
  return found;
}
async function messageReceipts(parent: string, child: string): Promise<{ sent: string; reply: string }> {
  function deliveryResults(entries: NativeEntry[], sender: string, target: string) {
    return entries.filter((entry) => entry.message?.role === "toolResult" &&
      entry.message.details?.message?.from === sender &&
      entry.message.details.message.to === target &&
      entry.message.details.message.receipts?.some((receipt) => receipt.to === target));
  }
  // Live assistant parameters are placeholders until the native owner finalizes
  // them. Delivery toolResults already persist their structured sender/receipt.
  let parentJournal = await nativeJournal(parent, (entries) => deliveryResults(entries, "Main", "SaHold").length > 0);
  let childJournal = await nativeJournal(child, (entries) => deliveryResults(entries, "SaHold", "Main").length > 0);
  const header = childJournal.entries.find((entry) => entry.type === "session");
  expect(resolve(header!.parentSession!)).toBe(resolve(parentJournal.path));
  function receipt(entries: NativeEntry[], sender: string, target: string) {
    const results = deliveryResults(entries, sender, target);
    expect(results).toHaveLength(1);
    expect(results[0]!.message!.toolCallId).toBeTruthy();
    const receipts = results[0]!.message!.details!.message!.receipts!.filter((entry) => entry.to === target);
    expect(receipts).toHaveLength(1);
    const sent = receipts[0]!;
    expect(sent.outcome).not.toBe("failed");
    expect(sent.id).toBeTruthy();
    expect(sent.ts).toBeGreaterThan(0);
    return sent.id!;
  }
  const sent = receipt(parentJournal.entries, "Main", "SaHold");
  const reply = receipt(childJournal.entries, "SaHold", "Main");
  expect(sent).not.toBe(reply);
  const incoming = (entries: NativeEntry[], payload: string, receiptId?: string) => entries.filter((entry) => {
    // Parent inbox records persist IRC identity. Busy-child parent steering
    // persists a user record without that ID; never count assistant echoes.
    const received = receiptId
      ? (entry.type === "custom_message" && entry.customType === "irc:incoming") || entry.message?.role === "user"
      : entry.message?.role === "user";
    const text = JSON.stringify(entry);
    return received && text.includes(payload) && (!receiptId || text.includes(receiptId));
  });
  childJournal = await nativeJournal(child, (entries) => incoming(entries, "OMP_E2E_SA_MESSAGE_PAYLOAD").length > 0);
  parentJournal = await nativeJournal(parent, (entries) => incoming(entries, "OMP_E2E_SA_CHILD_RECEIPT", reply).length > 0);
  expect(incoming(childJournal.entries, "OMP_E2E_SA_MESSAGE_PAYLOAD")).toHaveLength(1);
  expect(incoming(parentJournal.entries, "OMP_E2E_SA_CHILD_RECEIPT", reply)).toHaveLength(1);
  await writeFile(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-sa04-native-message-identities.json"), JSON.stringify({ parent, child, sent, reply }, null, 2));
  return { sent, reply };
}

async function waitForNativeGateResult(): Promise<string> {
  let completed: string | undefined;
  await browser.waitUntil(async () => {
    for (const request of (await requests()).slice(requestFloor)) {
      if (!request.tools?.length) continue;
      type WireMessage = ModelRequest["messages"][number] & {
        tool_call_id?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      const messages = request.messages as WireMessage[];
      const call = messages.flatMap((message) => message.tool_calls ?? []).find((entry) =>
        entry.function.name === "bash" && entry.function.arguments.includes(SA_RELEASE));
      if (!call) continue;
      const gateResult = messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
      const output = JSON.stringify(gateResult?.content ?? "");
      if (output.includes("OMP_E2E_SA_GATE_RELEASED")) {
        completed = output;
        break;
      }
      const job = /Backgrounded as job ([a-zA-Z0-9_-]+)/u.exec(output)?.[1];
      if (!job) continue;
      const event = messages.find((message) => {
        const text = JSON.stringify(message.content ?? "");
        return text.includes("OMP_E2E_SA_GATE_RELEASED") &&
          ((message.role === "user" && text.includes(`Background job ${job} has completed`)) ||
            (message.role === "tool" && text.includes(job)));
      });
      if (event) {
        completed = JSON.stringify(event.content);
        break;
      }
    }
    return Boolean(completed);
  }, { timeout: 30000, timeoutMsg: "Real native gate process did not deliver its correlated completion" });
  return completed!;
}

async function childMessageEvidence(child: string, payload: string) {
  await childEvidence(child, "OMP_E2E_SA_CHILD_MESSAGE_DONE");
  const pane = $(`[data-session-id="${child}"]`);
  const histories = await pane.$$(`[data-testid^="${TID_CHAT_ASSISTANT_HISTORY_TRIGGER}-"]`);
  for (const history of histories) {
    if ((await history.isDisplayed()) && (await history.getAttribute("aria-expanded")) === "false") {
      await history.scrollIntoView();
      await history.click();
    }
  }
  let callId: string | undefined;
  for (const request of (await requests()).slice(requestFloor)) {
    if (!request.tools?.length) continue;
    for (const message of request.messages as Array<ModelRequest["messages"][number] & {
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>) {
      for (const call of message.tool_calls ?? []) {
        if (call.function.name !== "write") continue;
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        if (args.path === "agent://Main" && args.content === payload) callId = call.id;
      }
    }
  }
  if (!callId) throw new Error(`Missing real native outgoing message call ${payload}`);
  const block = pane.$(`[data-tool-call-id="${callId}"]`);
  await block.waitForDisplayed({ timeout: 30000 });
  // Only the identified native agent:// communication tool uses this disclosure.
  // Do not click file-write summaries: their embedded preview opens another tab.
  const trigger = block.$(`[data-testid^="${TID_TOOL_SUMMARY_TRIGGER}-"]`);
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await trigger.scrollIntoView();
    const id = await trigger.getAttribute("data-testid");
    if (id === null) throw new Error("Native message disclosure has no test id");
    await browser.execute((testIdValue) => {
      document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(testIdValue)}"]`)?.focus();
    }, id);
    await browser.keys("Enter");
  }
  await browser.waitUntil(async () => {
    const visible = await block.getText();
    return visible.includes(payload) && visible.includes("receipts");
  }, { timeout: 30000, timeoutMsg: "Native outgoing message Input/Result did not expose its actual payload and receipt" });
  expect(await pane.$(`[data-testid^="${TID_V4_COMPOSER_INPUT}"]`).isExisting()).toBe(false);
}
