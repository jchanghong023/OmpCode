import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  TID_AUTOMATIONS_PAGE_TAB, TID_CHAT_WORKFLOW_RUN_DIGEST,
  TID_WORKFLOW_CARD, TID_WORKFLOW_CARD_RUN, TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG, TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_ARTIFACT_CARD, TID_WORKFLOW_ARTIFACT_PANE,
  TID_WORKFLOW_DETAIL_DESCRIPTION, TID_WORKFLOW_META_SAVE,
  TID_WORKFLOW_CARD_MENU, TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT, TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_ACTION_DELETE, TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOW_DETAIL_TAB, TID_WORKFLOW_RUN_ROW,
} from "@zcode/shared";
import { TID_AUTOMATIONS_OPEN, TID_CONFIRM_DIALOG_CONFIRM, TID_TASK_ITEM, TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER, TID_V4_COMPOSER_INPUT, TID_V4_TIMELINE, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, setInputValueByTestIdDom } from "./helpers/desktop-app.js";
import {
  prepareV4ConversationE2E, switchV4Model, switchV4Mode,
  waitForV4Pane, selectV4TaskById, sendV4Prompt, waitForV4TimelineContaining, getV4PaneSnapshot,
} from "./helpers/v4-conversation.js";
import { OMP_PROVIDER_ID, OMP_MODEL_ID, type ModelRequest } from "./helpers/omp-integration-fixture.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart.js";

const active = '[role="tabpanel"][data-state="active"]';
const NAME = "omp-native-two-actors";
const definitionFile = resolve(DEFAULT_WORKSPACE, ".zcode/workflows", `${NAME}.dwf.ts`);
const proofFile = resolve(DEFAULT_WORKSPACE, "omp-wf-actor-proof.txt");
const globalName = "omp-native-global";
const globalFile = resolve(dirname(DEFAULT_WORKSPACE), ".zcode/workflows", `${globalName}.dwf.ts`);
const movedFile = resolve(DEFAULT_WORKSPACE, ".zcode/workflows", `${globalName}.dwf.ts`);
const lifecycleNames = ["omp-native-resume", "omp-native-hold", "omp-native-fail", "omp-native-late", "omp-native-survivor"];
let completedRunId: string | undefined;
const completedActors: Array<{ sessionId: string; output: string }> = [];
const script = [
  'interface Answer { value: string }',
  'phase("write-proof");',
  'const writer = agent("omp-wf-writer", { model: "omp-e2e/omp-chat", system: "OMP_E2E_WF_WRITER_ROLE" });',
  'const written = await writer.ask<Answer>("OMP_E2E_WF_WRITER: write the proof file and return cedar-731");',
  'phase("review-proof");',
  'const reviewer = agent("omp-wf-reviewer", { model: "omp-e2e/omp-alternate", system: "OMP_E2E_WF_REVIEWER_ROLE" });',
  'const reviewed = await reviewer.ask<Answer>("OMP_E2E_WF_REVIEWER: read the real proof, escalate to the parent model, then ask the user to approve. Writer output: " + written.value);',
  'await artifact.markdown("omp-wf-report", "# OMP actual actor report\\n" + written.value + "\\n" + reviewed.value, { title: "OMP_E2E_WF_REPORT", primary: true });',
  'report({ written, reviewed });',
  'return { written, reviewed };',
  '',
].join("\n");
const source = `/* zcode-workflow\ndescription: OMP_E2E_WF_REAL_ACTORS\nargs:\n  topic:\n    type: string\n    required: true\n*/\n${script}`;

async function click(id: string) {
  const control = $(`[data-testid=${JSON.stringify(id)}]`);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.click();
}
async function requests(): Promise<ModelRequest[]> {
  const origin = process.env.OMP_E2E_PROVIDER_URL;
  if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("Isolated local OMP provider required");
  const response = await fetch(`${origin}/__requests`);
  if (!response.ok) throw new Error(`OMP ledger returned ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function openHub() {
  await click(TID_AUTOMATIONS_OPEN);
  const tab = $(`[data-testid=${JSON.stringify(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))}]`);
  if (!(await tab.isDisplayed().catch(() => false))) {
    // A saved definition detail keeps the sidebar entry selected; its own
    // definition/history tabs are not the hub's top-level workflow tab.
    const breadcrumb = $('[data-testid="settings-breadcrumb-section"]');
    if (!(await breadcrumb.isExisting())) throw new Error("Workflow detail has no real breadcrumb back to the hub");
    await breadcrumb.click();
  }
  await click(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"));
  await $(`[data-testid=${JSON.stringify(testId(TID_WORKFLOW_CARD, NAME))}]`).waitForDisplayed({ timeout: 30000 });
}
async function readRunPaneFacts(runId: string) {
  return browser.execute((wanted) => {
    const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-workflow-run-id]")).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          runId: element.dataset.workflowRunId ?? null,
          status: element.dataset.workflowRunStatus ?? null,
          displayed: element.checkVisibility(),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      },
    );
    return {
      wanted,
      panes,
      statusControls: document.querySelectorAll('[data-testid^="workflow-run-status"]').length,
    };
  }, runId);
}
async function openRunFromParentSearch(runId: string) {
  await click("sidebar-search-open");
  const dialog = $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 30000, timeoutMsg: "Sidebar task search did not open" });
  const input = dialog.$("input");
  await input.waitForDisplayed({ timeout: 30000, timeoutMsg: "Sidebar task search has no input" });
  await input.click();
  await input.setValue(NAME);
  await browser.waitUntil(async () => (await dialog.getText()).includes(NAME), {
    timeout: 30000,
    timeoutMsg: `Task search returned no row for ${NAME}`,
  });
  let taskRow: WebdriverIO.Element | undefined;
  for (const option of await dialog.$$('[role="option"]')) {
    if ((await option.getText()).includes(NAME)) {
      taskRow = option;
      break;
    }
  }
  if (taskRow === undefined) {
    const dialogText = await dialog.getText();
    const bodyText = await browser.execute(() => document.body.innerText);
    throw new Error(`Task search result missing for ${NAME}: ${JSON.stringify({ dialogText, bodyText })}`);
  }
  await taskRow.click();
  await waitForV4Pane((pane) => Boolean(pane.sessionId && pane.sessionId !== "draft"), "Task search did not open its parent conversation", 30000);
  const directoryTrigger = $('[data-testid="workflow-run-directory-trigger"]');
  if (await directoryTrigger.isDisplayed().catch(() => false)) {
    await directoryTrigger.click();
    const runRow = $(`${active} [data-run-id=${JSON.stringify(runId)}]`);
    await runRow.waitForDisplayed({ timeout: 30000, timeoutMsg: `Ended-workflow directory has no run ${runId}` });
    await runRow.click();
  } else {
    const digest = $(`[data-testid^=${JSON.stringify(testId(TID_CHAT_WORKFLOW_RUN_DIGEST, ""))}][data-workflow-run-id=${JSON.stringify(runId)}]`);
    if (await digest.isExisting()) await digest.scrollIntoView({ block: "center", inline: "nearest" });
    await digest.waitForDisplayed({ timeout: 30000, timeoutMsg: `Parent conversation has no inline run card for ${runId}` });
    const openDetails = digest.$('[data-testid="workflow-card-open-details"]');
    await openDetails.waitForDisplayed({ timeout: 30000, timeoutMsg: `Inline run card has no details control for ${runId}` });
    await openDetails.click();
  }
  await $(`${active} [data-testid="workflow-run-status"]`).waitForDisplayed({ timeout: 30000 });
}
async function saveFromVisibleRun(runId: string) {
  let save: WebdriverIO.Element | undefined;
  await browser.waitUntil(async () => {
    for (const candidate of await $$('[data-testid="workflow-save-open"]')) {
      if (await candidate.isDisplayed().catch(() => false)) {
        save = candidate;
        return true;
      }
    }
    return false;
  }, {
    timeout: 30000,
    interval: 200,
    timeoutMsg: `Visible save control stayed absent for run ${runId}`,
  });
  if (save === undefined) {
    const facts = await readRunPaneFacts(runId);
    throw new Error(`Visible save control missing for ${runId}: ${JSON.stringify(facts)}`);
  }
  const ids = [
    ...new Set(
      await browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-workflow-run-id]"))
          .filter((element) => element.checkVisibility())
          .map((element) => element.dataset.workflowRunId ?? null)),
    ),
  ];
  if (ids.length !== 1 || ids[0] !== runId) {
    const facts = await readRunPaneFacts(runId);
    throw new Error(`Visible run panes are not exclusively ${runId}: ${JSON.stringify({ ids, facts })}`);
  }
  await save.click();
}
async function digest(): Promise<{ id: string; runId: string; status: string | null; text: string } | null> {
  return browser.execute((prefix) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (element) => element.dataset.testid?.startsWith(prefix) && element.checkVisibility());
    return card ? { id: card.dataset.testid!, runId: card.getAttribute("data-workflow-run-id") ?? "", status: card.getAttribute("data-workflow-run-status"), text: card.innerText } : null;
  }, testId(TID_CHAT_WORKFLOW_RUN_DIGEST, ""));
}
async function waitRun(status: string) {
  await browser.waitUntil(async () => (await digest())?.status === status, {
    timeout: 60000, timeoutMsg: `Real OMP workflow never reached ${status}; accepted is not completion`,
  });
  const result = await digest();
  if (!result) throw new Error("Workflow digest disappeared");
  return result;
}
async function screenshot(name: string) {
  const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!directory) throw new Error("Missing case artifact directory");
  await browser.saveScreenshot(resolve(directory, `${name}.png`));
}

async function sideClick(id: string) {
  const control = $(`${active} [data-testid=${JSON.stringify(id)}]`);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.click();
}

async function launch(name: string) {
  const requestBoundary = (await requests()).length;
  const previousParent = (await getV4PaneSnapshot()).sessionId;
  await openHub();
  await click(testId(TID_WORKFLOW_CARD_RUN, name));
  const parent = await waitForV4Pane((pane) => Boolean(pane.sessionId && pane.sessionId !== previousParent && pane.sessionId !== "draft"), "Workflow parent not bound");
  const run = await waitRun("running");
  await browser.waitUntil(async () => (await requests()).slice(requestBoundary).some((request) =>
    JSON.stringify(request.messages).includes("OMP_E2E_WF_")), {
    timeout: 30000, timeoutMsg: "Workflow was accepted but no actual actor reached the provider",
  });
  return { parent: parent.sessionId!, run };
}

async function reopenHistory(name: string, runId: string) {
  await openHub();
  await click(testId(TID_WORKFLOW_CARD, name));
  const tabs = await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_DETAIL_TAB)}]`).$$('[role="tab"]');
  if (!tabs[1]) throw new Error("Workflow definition has no history tab");
  await tabs[1].click();
  const row = $(`[data-testid=${JSON.stringify(testId(TID_WORKFLOW_RUN_ROW, runId))}]`);
  await row.waitForDisplayed({ timeout: 30000 });
  const open = row.$('button*=查看实例');
  await open.waitForClickable();
  await open.click();
}
describe("OMP-WF01..05 actual app-server / saved workflow GUI", () => {
  before(async () => {
    await mkdir(dirname(definitionFile), { recursive: true });
    // Only source is seeded; actor output, run state and journal are never fixtures.
    await writeFile(definitionFile, source, "utf8");
    await mkdir(dirname(globalFile), { recursive: true });
    await writeFile(globalFile, "/* zcode-workflow\ndescription: OMP_E2E_WF_GLOBAL\n*/\nreturn { scope: 'global' };\n", "utf8");
    for (const name of lifecycleNames) {
      const marker = name.endsWith("hold") ? "OMP_E2E_WF_HOLD"
        : name.endsWith("fail") ? "OMP_E2E_WF_FAIL"
          : name.endsWith("late") ? "OMP_E2E_WF_STREAM_LATE" : "OMP_E2E_WF_SURVIVOR";
      const body = name.endsWith("resume")
        ? 'phase("checkpoint");\nconst checkpoint = await agent("checkpoint").ask("OMP_E2E_WF_WRITER: commit the proof once");\nphase("resume-point");\nconst result = await agent("resumable").ask("OMP_E2E_WF_RESUME: continue after owner restart. " + checkpoint);\nawait artifact.markdown("resumed-report", result);\nreturn result;\n'
        : `return await agent("${name}").ask("${marker}");\n`;
      await writeFile(resolve(dirname(definitionFile), `${name}.dwf.ts`), `/* zcode-workflow\ndescription: ${name}\n*/\n${body}`, "utf8");
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
  });
  afterEach(async function () {
    const title = this.currentTest?.title ?? "unknown";
    const basename = title.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100);
    const directory = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!directory) throw new Error("Missing workflow evidence directory");
    const evidence = {
      title, state: this.currentTest?.state, requests: await requests(),
      digest: await digest(),
      dom: await browser.execute(() => document.body.innerText),
    };
    await writeFile(resolve(directory, `${basename}.json`), JSON.stringify(evidence, null, 2));
    await screenshot(basename);
  });

  it("OMP-WF01 OMP-WF02 OMP-WF03 rejects missing arguments then runs two native actors, parent question and real artifact", async function () {
    this.timeout(180000);
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_RUN, NAME));
    await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_LAUNCH_DIALOG)}]`).waitForDisplayed();
    const before = await requests();
    const tasksBefore = (await $$(`[data-testid^=${JSON.stringify(testId(TID_TASK_ITEM, ""))}]`)).length;
    await click(TID_WORKFLOW_LAUNCH_SUBMIT);
    expect(await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_LAUNCH_DIALOG)}]`).isDisplayed()).toBe(true);
    expect((await requests()).length).toBe(before.length);
    expect((await $$(`[data-testid^=${JSON.stringify(testId(TID_TASK_ITEM, ""))}]`)).length).toBe(tasksBefore);
    await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, "topic"), "cedar-731");
    await click(TID_WORKFLOW_LAUNCH_SUBMIT);
    const question = $('[data-elicitation-dialog-body="true"]');
    await browser.waitUntil(async () => {
      const run = await digest();
      if (run?.status === "errored" || run?.status === "stopped") {
        throw new Error(`Workflow ended before its real parent question: ${JSON.stringify(run)}`);
      }
      return question.isDisplayed();
    }, { timeout: 60000, timeoutMsg: "Native reviewer never opened the real parent user question" });
    expect(await question.getText()).toContain("OMP_E2E_WF_REVIEW_APPROVE?");
    expect(await readFile(proofFile, "utf8")).toBe("OMP_E2E_WF_ACTOR_SIDE_EFFECT\n");
    await screenshot("OMP-WF02-parent-question");
    await question.$('button[role="option"]').click();
    const submit = $('[data-elicitation-dialog-footer="true"] button:last-child');
    if (await submit.isExisting()) await submit.click();
    const completed = await waitRun("completed");
    completedRunId = completed.runId;
    const session = await waitForV4Pane((pane) => Boolean(pane.sessionId && pane.sessionId !== "draft"), "Workflow did not bind a real OMP session");
    expect(completed.text).toContain(NAME);
    await click("workflow-card-open-details");
    const pane = $('[role="tabpanel"][data-state="active"]');
    await pane.waitForDisplayed();
    expect(await pane.getText()).toContain("write-proof");
    expect(await pane.getText()).toContain("review-proof");
    const ledger = await requests();
    expect(ledger.some((request) => request.model === "omp-chat" && JSON.stringify(request.messages).includes("OMP_E2E_WF_WRITER"))).toBe(true);
    expect(ledger.some((request) => request.model === "omp-alternate" && JSON.stringify(request.messages).includes("OMP_E2E_WF_REVIEWER"))).toBe(true);
    expect(ledger.some((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_APPROVED"))).toBe(true);
    expect(ledger.some((request) => request.messages.some((message) => message.role === "tool" &&
      JSON.stringify(message).includes("OMP_E2E_WF_PARENT_ANSWER:cedar-731")))).toBe(true);
    await screenshot("OMP-WF02-completed-run");
    for (const toggle of await $$(`${active} [data-testid="workflow-run-phase-toggle"][aria-expanded="false"]`)) {
      await toggle.click();
    }
    const actorOpeners = await $$(`${active} [data-testid="workflow-run-agent-open"]`);
    expect(actorOpeners.length).toBeGreaterThanOrEqual(2);
    await actorOpeners[0]!.click();
    const actorTimeline = $(`${active} [data-testid=${JSON.stringify(TID_V4_TIMELINE)}]`);
    await actorTimeline.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(async () => (await actorTimeline.getText()).includes("OMP_E2E_WF_WRITER_OUTPUT:cedar-731"), {
      timeout: 30000, timeoutMsg: "Writer actor pane mounted but its real persisted output did not load",
    });
    const writerId = await browser.execute((scope, timelineId) =>
      document.querySelector(`${scope} [data-testid="${timelineId}"]`)
        ?.closest("[data-session-id]")?.getAttribute("data-session-id") ?? null,
    active, TID_V4_TIMELINE);
    if (!writerId || writerId === session.sessionId) throw new Error("Writer detail did not expose its own real actor identity");
    completedActors.push({ sessionId: writerId, output: "OMP_E2E_WF_WRITER_OUTPUT:cedar-731" });
    expect(await actorTimeline.getText()).toContain("OMP_E2E_WF_WRITER_OUTPUT:cedar-731");
    expect(await $(`${active} [data-testid=${JSON.stringify(TID_V4_COMPOSER_INPUT)}]`).isExisting()).toBe(false);
    await screenshot("OMP-WF02-readonly-writer");
    await click("workflow-card-open-details");
    const reviewerOpener = (await $$(`${active} [data-testid="workflow-run-agent-open"]`))[1];
    if (!reviewerOpener) throw new Error("Reviewer actor navigation missing");
    await reviewerOpener.click();
    const reviewerTimeline = $(`${active} [data-testid=${JSON.stringify(TID_V4_TIMELINE)}]`);
    await reviewerTimeline.waitForDisplayed({ timeout: 30000 });
    await browser.waitUntil(async () => (await reviewerTimeline.getText()).includes("OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731"), {
      timeout: 30000, timeoutMsg: "Reviewer actor pane mounted but its real persisted output did not load",
    });
    const reviewerId = await browser.execute((scope, timelineId) =>
      document.querySelector(`${scope} [data-testid="${timelineId}"]`)
        ?.closest("[data-session-id]")?.getAttribute("data-session-id") ?? null,
    active, TID_V4_TIMELINE);
    if (!reviewerId || reviewerId === writerId || reviewerId === session.sessionId) throw new Error("Reviewer detail reused another session's identity");
    completedActors.push({ sessionId: reviewerId, output: "OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731" });
    for (const actor of completedActors) {
      expect(await $(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, actor.sessionId))}]`).isExisting()).toBe(false);
    }
    expect(await reviewerTimeline.getText()).toContain("OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731");
    expect(await $(`${active} [data-testid=${JSON.stringify(TID_V4_COMPOSER_INPUT)}]`).isExisting()).toBe(false);
    await screenshot("OMP-WF02-readonly-reviewer");
    await click("workflow-card-open-details");
    await sideClick(TID_WORKFLOW_ARTIFACT_CARD);
    await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_ARTIFACT_PANE)}]`).waitForDisplayed();
    const artifact = $('[data-artifact-body="markdown"]');
    await artifact.waitForDisplayed();
    expect(await artifact.getText()).toContain("OMP_E2E_WF_WRITER_OUTPUT:cedar-731");
    expect(await artifact.getText()).toContain("OMP_E2E_WF_REVIEWER_OUTPUT:approved-cedar-731");
    await screenshot("OMP-WF03-real-artifact");
    if (!session.sessionId) throw new Error("Missing workflow parent identity");
    await writeFile(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-wf-run-evidence.json"), JSON.stringify({ sessionId: session.sessionId, actorSessions: completedActors, digest: completed, definitionFile, source, ledger }, null, 2));
  });

  it("OMP-WF04 completed run and artifact survive real owner restart without new actor work", async function () {
    this.timeout(120000);
    const current = await waitForV4Pane((pane) => Boolean(pane.sessionId), "Workflow session missing");
    const completed = await waitRun("completed");
    const actorRequests = (await requests()).filter((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_WRITER") || JSON.stringify(request.messages).includes("OMP_E2E_WF_REVIEWER")).length;
    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(current.sessionId!);
    expect((await waitRun("completed")).id).toBe(completed.id);
    await click("workflow-card-open-details");
    expect(completedActors).toHaveLength(2);
    for (let index = 0; index < completedActors.length; index++) {
      for (const toggle of await $$(`${active} [data-testid="workflow-run-phase-toggle"][aria-expanded="false"]`)) {
        await toggle.click();
      }
      const opener = (await $$(`${active} [data-testid="workflow-run-agent-open"]`))[index];
      if (!opener) throw new Error(`Cold workflow history lost actor ${index}`);
      await opener.click();
      const timeline = $(`${active} [data-testid=${JSON.stringify(TID_V4_TIMELINE)}]`);
      await timeline.waitForDisplayed({ timeout: 30000 });
      await browser.waitUntil(async () => (await timeline.getText()).includes(completedActors[index]!.output), {
        timeout: 30000, timeoutMsg: `Cold actor ${index} pane mounted but its persisted output did not load`,
      });
      expect(await timeline.getText()).toContain(completedActors[index]!.output);
      const actorId = await browser.execute((scope, timelineId) =>
        document.querySelector(`${scope} [data-testid="${timelineId}"]`)
          ?.closest("[data-session-id]")?.getAttribute("data-session-id") ?? null,
      active, TID_V4_TIMELINE);
      expect(actorId).toBe(completedActors[index]!.sessionId);
      expect(await $(`${active} [data-testid=${JSON.stringify(TID_V4_COMPOSER_INPUT)}]`).isExisting()).toBe(false);
      expect(await $(`[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, actorId!))}]`).isExisting()).toBe(false);
      await screenshot(`OMP-WF04-cold-readonly-actor-${index}`);
      await click("workflow-card-open-details");
    }
    await sideClick(TID_WORKFLOW_ARTIFACT_CARD);
    expect(await $('[data-artifact-body="markdown"]').getText()).toContain("approved-cedar-731");
    expect((await requests()).filter((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_WRITER") || JSON.stringify(request.messages).includes("OMP_E2E_WF_REVIEWER")).length).toBe(actorRequests);
    expect(await readFile(proofFile, "utf8")).toBe("OMP_E2E_WF_ACTOR_SIDE_EFFECT\n");
    await screenshot("OMP-WF04-cold-history");
  });

  it("OMP-WF04 stopped run resumes the same journal after owner restart without repeating the committed writer", async function () {
    this.timeout(180000);
    const launched = await launch("omp-native-resume");
    await browser.waitUntil(async () => (await requests()).some((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_RESUME:")), {
      timeout: 60000, timeoutMsg: "Checkpoint did not advance to the actual held actor request",
    });
    // The floating running-work pill overlaps the card's top-right details icon.
    // This session has one run: its normal composer badge opens that run directly.
    await click(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
    await sideClick("workflow-run-cancel");
    await waitRun("stopped");
    const writesBefore = (await requests()).filter((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_WRITER:")).length;
    const runId = launched.run.runId;
    await screenshot("OMP-WF04-stopped-checkpoint");
    await restartIntoWorkspacePreservingProfile();
    await reopenHistory("omp-native-resume", runId);
    await sideClick("workflow-run-resume");
    const completed = await waitRun("completed");
    expect(completed.id).toBe(launched.run.id);
    expect((await requests()).filter((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_WRITER:")).length).toBe(writesBefore);
    expect(await readFile(proofFile, "utf8")).toBe("OMP_E2E_WF_ACTOR_SIDE_EFFECT\n");
    await sideClick(TID_WORKFLOW_ARTIFACT_CARD);
    expect(await $(`${active} [data-artifact-body="markdown"]`).getText()).toContain("OMP_E2E_WF_RESUMED_OUTPUT:cedar-731");
    await screenshot("OMP-WF04-resumed-same-journal");
  });

  it("OMP-WF05 concurrent failure and GUI cancellation isolate owners, persist history and never revive a stopped run", async function () {
    this.timeout(180000);
    const held = await launch("omp-native-hold");
    await browser.waitUntil(async () => (await requests()).some((request) => JSON.stringify(request.messages).includes("OMP_E2E_WF_HOLD")), {
      timeout: 30000, timeoutMsg: "Held actor never reached the local HTTP provider",
    });
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_RUN, "omp-native-survivor"));
    const survivor = await waitForV4Pane((pane) => Boolean(pane.sessionId && pane.sessionId !== held.parent && pane.sessionId !== "draft"), "Healthy run did not create its own parent");
    const survivorRun = await waitRun("completed");
    await reopenHistory("omp-native-survivor", survivorRun.runId);
    expect(await $(`${active} [data-testid="workflow-run-result"]`).getText()).toContain("OMP_E2E_WF_PARENT_NOTIFICATION_DONE");
    await selectV4TaskById(held.parent);
    await waitRun("running");
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_RUN, "omp-native-fail"));
    const failedParent = await waitForV4Pane((pane) => Boolean(pane.sessionId && pane.sessionId !== held.parent && pane.sessionId !== survivor.sessionId && pane.sessionId !== "draft"), "Failure run reused an existing parent");
    const failedRun = await waitRun("errored");
    await reopenHistory("omp-native-fail", failedRun.runId);
    const error = $(`${active} [data-testid="workflow-run-error"]`);
    await error.waitForDisplayed();
    expect(await error.getText()).toContain("OMP_E2E_WF_PROVIDER_FAILURE");
    await screenshot("OMP-WF05-provider-failure");
    await selectV4TaskById(held.parent);
    expect((await waitRun("running")).id).toBe(held.run.id);
    await click(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
    await sideClick("workflow-run-cancel");
    await waitRun("stopped");
    await screenshot("OMP-WF05-cancelled-owner");
    await selectV4TaskById(failedParent.sessionId!);
    await waitRun("errored");
    await selectV4TaskById(survivor.sessionId!);
    await waitRun("completed");
    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(held.parent);
    expect((await waitRun("stopped")).id).toBe(held.run.id);
    await selectV4TaskById(failedParent.sessionId!);
    await waitRun("errored");
    await screenshot("OMP-WF05-restarted-terminal-history");
  });

  it("OMP-WF05 cancellation wins a real delayed provider completion without reviving the terminal run", async function () {
    this.timeout(120000);
    const late = await launch("omp-native-late");
    await click(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
    await sideClick("workflow-run-cancel");
    await waitRun("stopped");
    const observedUntil = Date.now() + 2500;
    await browser.waitUntil(async () => {
      const current = await digest();
      expect(current?.id).toBe(late.run.id);
      expect(current?.status).toBe("stopped");
      return Date.now() >= observedUntil;
    }, { timeout: 5000, interval: 100, timeoutMsg: "Cancelled run revived when delayed completion became deliverable" });
    await screenshot("OMP-WF05-late-completion-cancelled");
  });

  it("OMP-WF05 active owner EOF settles its run rather than leaving an immortal running row", async function () {
    this.timeout(120000);
    const held = await launch("omp-native-hold");
    await click(TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER);
    await screenshot("OMP-WF05-before-owner-EOF");
    await restartIntoWorkspacePreservingProfile();
    await selectV4TaskById(held.parent);
    await browser.waitUntil(async () => {
      const current = await digest();
      return current?.id === held.run.id && ["stopped", "errored"].includes(current.status ?? "");
    }, { timeout: 30000, timeoutMsg: "Lost OMP owner left a run permanently running or silently completed" });
    await reopenHistory("omp-native-hold", held.run.runId);
    await $(`${active} [data-testid="workflow-run-status"]`).waitForDisplayed({ timeout: 30000 });
    const reason = await $(`${active}`).getText();
    expect(reason).toMatch(/owner|interrupt|中断|停止|进程/i);
    await screenshot("OMP-WF05-owner-EOF-settled");
  });

  it("OMP-WF01 OMP-WF03 manages real definitions through GUI, moves global files and saves an executed run", async function () {
    this.timeout(180000);
    await openHub();
    await click(testId(TID_WORKFLOW_CARD, NAME));
    await setInputValueByTestIdDom(TID_WORKFLOW_DETAIL_DESCRIPTION, "OMP_E2E_WF_METADATA_EDITED");
    await click(TID_WORKFLOW_META_SAVE);
    await browser.waitUntil(async () => (await readFile(definitionFile, "utf8")).includes("OMP_E2E_WF_METADATA_EDITED"), { timeout: 15000 });
    expect((await readFile(definitionFile, "utf8")).endsWith(`*/\n${script}`)).toBe(true);
    await openHub();
    await click(testId(TID_WORKFLOW_CARD, NAME));
    expect(await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_DETAIL_DESCRIPTION)}]`).getValue()).toBe("OMP_E2E_WF_METADATA_EDITED");
    await openHub();
    const globalBefore = await readFile(globalFile, "utf8");
    await click(testId(TID_WORKFLOW_CARD_MENU, globalName));
    await click(testId(TID_WORKFLOW_ACTION_MOVE, globalName));
    await click(TID_WORKFLOW_MOVE_DIALOG_SUBMIT);
    await browser.waitUntil(async () => {
      try { return (await readFile(movedFile, "utf8")) === globalBefore; } catch { return false; }
    }, { timeout: 15000 });
    await expect(readFile(globalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await click(testId(TID_WORKFLOW_CARD, globalName));
    await click(TID_WORKFLOW_DETAIL_MENU);
    await click(testId(TID_WORKFLOW_ACTION_DELETE, globalName));
    await click(TID_CONFIRM_DIALOG_CONFIRM);
    await browser.waitUntil(async () => {
      try { await readFile(movedFile, "utf8"); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }, { timeout: 15000 });
    const create = $(`[data-testid^=${JSON.stringify(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, ""))}]`);
    await create.waitForDisplayed();
    await create.click();
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_WF_CREATE create the project workflow omp-native-created with native write.");
    await waitForV4TimelineContaining("OMP_E2E_WF_CREATED_GUI_DONE");
    const createdFile = resolve(dirname(definitionFile), "omp-native-created.dwf.ts");
    expect(await readFile(createdFile, "utf8")).toContain("OMP_E2E_WF_CREATED_GUI");
    await openHub();
    await click(testId(TID_WORKFLOW_CARD, "omp-native-created"));
    expect(await $(`[data-testid=${JSON.stringify(TID_WORKFLOW_DETAIL_DESCRIPTION)}]`).getValue()).toBe("OMP_E2E_WF_CREATED_GUI");
    await screenshot("OMP-WF01-created-reopened-definition");
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_RUN, "omp-native-created"));
    await waitRun("completed");
    if (!completedRunId) throw new Error("Original real two-actor run was not completed");
    await reopenHistory(NAME, completedRunId);
    // The run is already "saved" while its definition exists; the product's save
    // control is the run's own Save verb once that definition is gone. Keep the
    // real run side tab open and delete through the hub card menu so the same
    // actual run can be saved without a task-list round trip.
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_MENU, NAME));
    await click(testId(TID_WORKFLOW_ACTION_DELETE, NAME));
    await click(TID_CONFIRM_DIALOG_CONFIRM);
    await openRunFromParentSearch(completedRunId);
    await saveFromVisibleRun(completedRunId);
    await setInputValueByTestIdDom("workflow-save-name", NAME);
    await click("workflow-save-submit");
    await browser.waitUntil(async () => {
      try { return (await readFile(definitionFile, "utf8")).endsWith(`*/\n${script}`); } catch { return false; }
    }, { timeout: 15000 });
    await sideClick("workflow-saved-chip");
    await openHub();
    await click(testId(TID_WORKFLOW_CARD_RUN, NAME));
    const launchDialog = $(`[data-testid=${JSON.stringify(TID_WORKFLOW_LAUNCH_DIALOG)}]`);
    await browser.waitUntil(
      async () => (await launchDialog.isDisplayed().catch(() => false)) || Boolean(await digest()),
      { timeout: 30000, timeoutMsg: "Saved workflow run neither opened launch args nor started" },
    );
    if (await launchDialog.isDisplayed().catch(() => false)) {
      const topic = $(`[data-testid=${JSON.stringify(testId(TID_WORKFLOW_LAUNCH_ARG, "topic"))}]`);
      if (await topic.isDisplayed().catch(() => false)) {
        await setInputValueByTestIdDom(testId(TID_WORKFLOW_LAUNCH_ARG, "topic"), "rerun-cedar-731");
      }
      await click(TID_WORKFLOW_LAUNCH_SUBMIT);
    }
    const question = $('[data-elicitation-dialog-body="true"]');
    await question.waitForDisplayed({ timeout: 60000 });
    expect(await question.getText()).toContain("OMP_E2E_WF_REVIEW_APPROVE?");
    await question.$('button[role="option"]').click();
    const submit = $('[data-elicitation-dialog-footer="true"] button:last-child');
    if (await submit.isExisting()) await submit.click();
    await waitRun("completed");
    await screenshot("OMP-WF03-save-run-and-rerun");
  });
});
