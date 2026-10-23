import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_PROMPT_SUGGESTION_OPTION,
  TID_V4_COMPOSER_INPUT,
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  testId,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, setInputValueByTestIdDom } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  clickV4Send,
  clickV4SlashOption,
  clickV4Stop,
  getV4CompactMarkers,
  getV4ComposerText,
  getV4GoalProjection,
  getV4Messages,
  getV4PaneSnapshot,
  getV4SlashOptionIds,
  hasV4SlashPanel,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Model,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4SlashOption,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";
import {
  isOmpCompactionSummaryRequest,
  OMP_COMPACT_ARCHIVE_MARKER,
  OMP_COMPACT_SUMMARY,
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";

async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated local OMP provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`OMP request ledger: ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function input(text: string) {
  await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, text, {
    timeout: 15000,
    timeoutMsg: "Native command composer missing",
  });
  expect(await getV4ComposerText()).toBe(text);
}
async function submit(text: string) {
  await input(text);
  await clickV4Send();
}
async function idle() {
  await waitForV4Pane((pane) => !pane.canStop, "OMP command did not finish", 90000);
}
async function draft() {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
}
async function boundSession() {
  const pane = await waitForV4Pane(
    (value) => Boolean(value.sessionId && value.sessionId !== "draft"),
    "OMP session not bound",
  );
  return pane.sessionId!;
}
async function artifact(name: string) {
  const dir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!dir) throw new Error("E2E artifact directory missing");
  await browser.saveScreenshot(resolve(dir, `${name}.png`));
  await writeFile(resolve(dir, `${name}-requests.json`), JSON.stringify(await requests(), null, 2));
}

async function discoverAndCompleteNativeCommands(stage: string) {
  const sessionId = (await getV4PaneSnapshot()).sessionId;
  const messages = await getV4Messages();
  await input("/");
  await waitForV4SlashOption("slash:settings");
  await waitForV4SlashOption("slash:display");
  expect(
    await $(`[data-testid="${testId(TID_PROMPT_SUGGESTION_OPTION, "slash:settings")}"]`).getText(),
  ).toContain("/settings");
  expect(
    await $(`[data-testid="${testId(TID_PROMPT_SUGGESTION_OPTION, "slash:display")}"]`).getText(),
  ).toContain("/display");
  await artifact(`omp-command-list-${stage}`);

  // 原因：完整命令直接提交绕过候选目录，必须从前缀开始验证可见筛选和补全。
  await input("/go");
  await waitForV4SlashOption("slash:goal");
  expect(await getV4SlashOptionIds()).not.toContain("slash:settings");
  await clickV4SlashOption("slash:goal");
  await browser.waitUntil(async () => (await getV4ComposerText())?.trim() === "/goal", {
    timeout: 15000,
    timeoutMsg: `${stage}: selecting /go did not complete /goal`,
  });
  expect(await hasV4SlashPanel()).toBe(false);

  await input("/comp");
  await waitForV4SlashOption("slash:compact");
  const compact = $(`[data-testid="${testId(TID_PROMPT_SUGGESTION_OPTION, "slash:compact")}"]`);
  await browser.waitUntil(async () => (await compact.getAttribute("data-selected")) === "true", {
    timeout: 15000,
    timeoutMsg: `${stage}: /comp did not select the compact candidate`,
  });
  await browser.keys("Tab");
  await browser.waitUntil(async () => (await getV4ComposerText())?.trim() === "/compact", {
    timeout: 15000,
    timeoutMsg: `${stage}: Tab did not complete /compact`,
  });
  expect(await hasV4SlashPanel()).toBe(false);

  await input("/loo");
  await waitForV4SlashOption("slash:loop");
  const loop = $(`[data-testid="${testId(TID_PROMPT_SUGGESTION_OPTION, "slash:loop")}"]`);
  await browser.waitUntil(async () => (await loop.getAttribute("data-selected")) === "true", {
    timeout: 15000,
    timeoutMsg: `${stage}: /loo did not select the loop candidate`,
  });
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await getV4ComposerText())?.trim() === "/loop", {
    timeout: 15000,
    timeoutMsg: `${stage}: Enter submitted instead of completing /loop`,
  });
  expect(await hasV4SlashPanel()).toBe(false);

  const unmatched = "/zzzz_omp_command_not_registered_731";
  await input(unmatched);
  await browser.waitUntil(
    async () =>
      (await hasV4SlashPanel()) &&
      (await getV4SlashOptionIds()).filter((id) => id.startsWith("slash:")).length === 0,
    { timeout: 15000, timeoutMsg: `${stage}: unmatched prefix still lists native commands` },
  );
  await browser.keys("Escape");
  expect(await getV4ComposerText()).toBe(unmatched);
  expect(await hasV4SlashPanel()).toBe(false);
  expect((await getV4PaneSnapshot()).sessionId).toBe(sessionId);
  expect(await getV4Messages()).toEqual(messages);
  expect((await getV4PaneSnapshot()).canStop).toBe(false);
  await artifact(`omp-command-completion-${stage}`);
  await input("");
}

// Ordinary chat, existing compact/model buttons and upstream Agent paths retain
// their existing omp-app-server and legacy suites; this spec only adds commands.
describe("OMP native slash commands / actual Electron input and runtime", () => {
  it("browses, filters and completes native commands in initial drafts, new drafts and restored sessions", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await discoverAndCompleteNativeCommands("initial-draft");
    await submit("/goal show");
    const original = await boundSession();
    await waitForV4TimelineContaining("No goal set.");
    await idle();

    await draft();
    // 原因：task → draft 清空 slashCommands 却保留 model ready，旧水合门禁不会补回目录。
    await discoverAndCompleteNativeCommands("task-to-draft");
    await submit("/goal show");
    expect(await boundSession()).not.toBe(original);
    await waitForV4TimelineContaining("No goal set.");
    await idle();

    await selectV4TaskById(original);
    await browser.refresh();
    await waitForV4Pane(
      (pane) => pane.sessionId === original,
      "Native command discovery restored a different session",
      60000,
    );
    await waitForV4TimelineContaining("No goal set.");
    await discoverAndCompleteNativeCommands("restored-session");
  });

  it("executes goal controls, cancels a confirmation and restores isolated command history", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    // A real held local-model turn makes pause observable, without racing an
    // automatically completed goal or asking a production provider for anything.
    await submit("/goal set OMP_E2E_STOP_COMMAND_GOAL");
    const a = await boundSession();
    await waitForV4TimelineContaining("OMP_E2E_STOP_COMMAND_GOAL_STREAMING");
    await submit("/goal pause");
    await waitForV4TimelineContaining("Goal mode paused.");
    await browser.waitUntil(async () => (await getV4GoalProjection())?.status === "paused", {
      timeout: 30000,
      timeoutMsg: "Native GoalRuntime did not publish paused state",
    });
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
    await idle();
    await submit("/goal show");
    await waitForV4TimelineContaining("Status: paused");
    await idle();
    expect((await getV4PaneSnapshot()).timelineText).toContain(
      "Objective: OMP_E2E_STOP_COMMAND_GOAL",
    );

    const beforeCancel = (await requests()).length;
    await submit("/goal drop");
    // 原生 confirm 是无 toolName 的 userInput，复用 V4UserInputDialog；
    // ElicitationDialog 的 body/footer 只属于 AskUserQuestion 等结构化问答。
    const dialog = $(`[data-testid="${TID_V4_USER_INPUT_DIALOG}"]`);
    await dialog.waitForDisplayed({ timeout: 30000 });
    expect(await dialog.getText()).toContain("Drop goal?");
    const cancel = dialog.$(`[data-testid="${testId(TID_V4_USER_INPUT_OPTION, "no")}"]`);
    await cancel.waitForDisplayed({ timeout: 10000 });
    await cancel.click();
    await browser.waitUntil(async () => !(await dialog.isExisting()), {
      timeout: 30000,
      timeoutMsg: "Existing confirmation cancellation did not settle",
    });
    await idle();
    expect((await getV4GoalProjection())?.status).toBe("paused");
    expect((await requests()).length).toBe(beforeCancel);
    const history = await getV4Messages();
    await artifact("omp-command-goal-paused");

    await draft();
    const beforeErrors = (await requests()).length;
    await submit("/goal show");
    const b = await boundSession();
    expect(b).not.toBe(a);
    await waitForV4TimelineContaining("No goal set.");
    await idle();
    await submit("/goal pause");
    await waitForV4TimelineContaining("No active goal to pause.");
    await idle();
    await submit("/compact snapcompact forbidden-focus");
    await waitForV4TimelineContaining("/compact snapcompact does not take focus instructions");
    await idle();
    await submit("/display");
    await waitForV4TimelineContaining("requires a terminal UI");
    await idle();
    expect((await requests()).length).toBe(beforeErrors);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("OMP_E2E_STOP_COMMAND_GOAL");
    await artifact("omp-command-errors");

    await selectV4TaskById(a);
    await browser.refresh();
    await waitForV4Pane(
      (value) => value.sessionId === a,
      "Command history changed session on restore",
      60000,
    );
    await waitForV4TimelineContaining("Status: paused");
    expect((await getV4GoalProjection())?.status).toBe("paused");
    // Stable row IDs and cardinality prove replay reads history, not dispatches
    // the same slash input a second time after navigation/reconnection.
    expect(await getV4Messages()).toEqual(history);
    expect((await requests()).length).toBe(beforeErrors);
    await artifact("omp-command-history-restored");
  });

  it("preserves quoted multiline compact instructions in the real summary model request and committed context", async function () {
    this.timeout(180000);
    await draft();
    const start = (await requests()).length;
    await sendV4Prompt("OMP_E2E_COMPACT_SEED");
    const sessionId = await boundSession();
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_SEED_DONE");
    await idle();
    await sendV4Prompt("OMP_E2E_COMPACT_TAIL");
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_TAIL_DONE");
    await idle();
    const customInstructions =
      'Preserve "quoted checkpoint"  and   internal spaces\nKeep cedar-731 on the next line.';
    await submit(`/compact ${customInstructions}`);
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await idle();
    const summaries = (await requests()).slice(start).filter(isOmpCompactionSummaryRequest);
    expect(summaries).toHaveLength(1);
    // HTTP content 可以是文本块数组；直接读取原文，不能用 JSON 转义后的字符串验证引号与换行。
    const instruction = summaries[0]!.messages
      .flatMap(({ content }) =>
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content.flatMap((part: unknown) =>
                part &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
            : [],
      )
      .join("\n");
    expect(instruction).toContain(customInstructions);
    expect(instruction).toContain(OMP_COMPACT_ARCHIVE_MARKER);
    const markers = await getV4CompactMarkers();
    expect(
      markers.filter((marker) => marker.origin === "manual" && marker.status === "success"),
    ).toHaveLength(1);
    await sendV4Prompt("OMP_E2E_COMPACT_AFTER");
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_AFTER_DONE");
    await idle();
    const after = (await requests())
      .slice(start)
      .find(
        (request) =>
          !isOmpCompactionSummaryRequest(request) &&
          JSON.stringify(request.messages.at(-1)).includes("OMP_E2E_COMPACT_AFTER"),
      );
    expect(after).toBeDefined();
    const context = JSON.stringify(after!.messages);
    expect(context).toContain(JSON.stringify(OMP_COMPACT_SUMMARY).slice(1, -1));
    expect(context).not.toContain(OMP_COMPACT_ARCHIVE_MARKER);
    await browser.refresh();
    await waitForV4Pane(
      (value) => value.sessionId === sessionId,
      "Compacted command session not restored",
      60000,
    );
    await waitForV4CompactMarker({ origin: "manual", status: "success" });
    expect(await getV4CompactMarkers()).toEqual(markers);
    expect((await requests()).slice(start).filter(isOmpCompactionSummaryRequest)).toHaveLength(1);
    await artifact("omp-command-compact-restored");
  });
});
