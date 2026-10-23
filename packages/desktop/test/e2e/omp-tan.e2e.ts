import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_V4_SESSION_PANE, TID_V4_ROW, TID_V4_STOP, testId } from "@zcode/shared/test-ids";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  switchV4Model,
  V4_MAIN_PANE_ID,
} from "./helpers/v4-conversation.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";

const main = () => $(`[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`);
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated local OMP provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Tan provider ledger ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function textContains(text: string) {
  await browser.waitUntil(
    async () => {
      const rows = Array.from(await main().$$(`[data-testid^="${TID_V4_ROW}-"]`));
      for (const row of rows) if ((await row.getText()).includes(text)) return true;
      return false;
    },
    { timeout: 30000, timeoutMsg: `Tan parent transcript missing ${text}` },
  );
}
async function dispatch(work: string) {
  const button = main().$('[data-testid="omp-tan-open"]');
  await button.waitForClickable({ timeout: 30000 });
  await button.click();
  const input = $('[data-testid="omp-tan-work"]');
  await input.waitForDisplayed({ timeout: 15000 });
  await input.setValue(work);
  await $('[data-testid="omp-tan-start"]').click();
  let id: string | null = null;
  await browser.waitUntil(
    async () => {
      const rows = await main().$$('[data-testid="omp-tan-job"]');
      for (const row of rows)
        if ((await row.getText()).includes(work)) {
          id = await row.getAttribute("data-job-id");
          return Boolean(id);
        }
      return false;
    },
    { timeout: 30000, timeoutMsg: `Native Tan job was not accepted: ${work}` },
  );
  return id!;
}
const card = (id: string) => main().$(`[data-testid="omp-tan-job"][data-job-id="${id}"]`);
async function status(id: string, expected: string) {
  await browser.waitUntil(
    async () => (await card(id).getAttribute("data-job-status")) === expected,
    { timeout: 30000, timeoutMsg: `Tan ${id} did not become ${expected}` },
  );
}
async function open(id: string) {
  const action = card(id).$('[data-testid="omp-tan-history"]');
  await action.waitForClickable({ timeout: 30000 });
  await action.click();
  let child: string | undefined;
  await browser.waitUntil(
    async () => {
      child = await browser.execute(() => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="subagent-session:"][data-active]',
        );
        const encoded = tab?.dataset.sidePaneTabId?.split(":").at(-1);
        return encoded ? decodeURIComponent(encoded) : undefined;
      });
      return Boolean(child);
    },
    { timeout: 30000, timeoutMsg: "Tan did not open existing child side pane" },
  );
  return child!;
}
async function close(child: string) {
  const selector = `[data-side-pane-tab-id^="subagent-session:"][data-side-pane-tab-id$=":${encodeURIComponent(child)}"]`;
  const button = $(selector).$("button");
  await button.waitForClickable({ timeout: 15000 });
  await button.click();
  await browser.waitUntil(async () => !(await $(selector).isExisting()), { timeout: 15000 });
}

describe("OMP Tan / real native desktop delegation", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!artifactDir)
      throw new Error("Tan failure diagnostics require the isolated artifact directory");
    let providerRequests: ModelRequest[] | { error: string };
    try {
      providerRequests = await requests();
    } catch (error) {
      providerRequests = { error: error instanceof Error ? error.message : String(error) };
    }
    const pane = await browser.execute(
      (paneTestId) => {
        const element = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        return {
          sessionId: element?.getAttribute("data-session-id") ?? null,
          text: element?.innerText ?? "",
        };
      },
      testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
    );
    await writeFile(
      resolve(artifactDir, "omp-tan-failure.json"),
      JSON.stringify({ providerRequests, pane }, null, 2),
    );
    await browser.saveScreenshot(resolve(artifactDir, "omp-tan-failure.png"));
  });
  it("OMP-TAN01 minimal: busy parent, real UI dispatch/tool, close view and owner result with parked history", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_TAN_CHECKPOINT");
    await textContains("cedar-731");
    await sendV4Prompt("OMP_E2E_TAN_PARENT_STREAM");
    await main().$(`[data-testid="${TID_V4_STOP}"]`).waitForDisplayed({ timeout: 30000 });
    const id = await dispatch("OMP_E2E_TAN_CHILD_CLOSE");
    const child = await open(id);
    expect(child).not.toBe(await main().getAttribute("data-session-id"));
    // 关闭实际 side-pane tab 只退订视图；任务的生命周期属于 native owner。
    await close(child);
    expect(await card(id).getAttribute("data-job-status")).toBe("running");
    await textContains("OMP_E2E_TAN_PARENT_STREAM_DONE");
    await status(id, "completed");
    expect(await card(id).getText()).toContain("OMP_E2E_TAN_CHILD_CLOSE_DONE");
    expect(await readFile(resolve(DEFAULT_WORKSPACE, "omp-tan-child-proof.txt"), "utf8")).toContain(
      "OMP_E2E_TAN_CHILD_CLOSE",
    );
    const nativeRequests = await requests();
    const childRequest = nativeRequests.find(
      (value) =>
        value.tools?.length &&
        JSON.stringify(value.messages.at(-1)?.content).includes("OMP_E2E_TAN_CHILD_CLOSE"),
    );
    expect(JSON.stringify(childRequest?.messages)).toContain("cedar-731");
    const parked = await open(id);
    expect(parked).toBe(child);
    const pane = $(`[data-session-id="${child}"]`);
    await browser.waitUntil(
      async () => (await pane.getText()).includes("OMP_E2E_TAN_CHILD_CLOSE_DONE"),
      { timeout: 30000 },
    );
    expect(await pane.$('[data-testid="omp-tan-open"]').isExisting()).toBe(false);
    await close(child);
  });
});
