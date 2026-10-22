import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { DEFAULT_WORKSPACE } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  switchV4Model,
} from "./helpers/v4-conversation.js";
import {
  OMP_MODEL_ID,
  OMP_PROVIDER_ID,
  type ModelRequest,
} from "./helpers/omp-integration-fixture.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart-runtime.js";

const tid = (id: string) => $(`[data-testid="${id}"]`);
async function click(id: string) {
  const control = tid(id);
  await control.waitForDisplayed({ timeout: 30000 });
  await control.scrollIntoView();
  await control.waitForClickable({ timeout: 15000 });
  await control.click();
}
async function screenshot(name: string) {
  await browser.saveScreenshot(resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, `${name}.png`));
}
async function requests(): Promise<ModelRequest[]> {
  const url = process.env.OMP_E2E_PROVIDER_URL;
  if (!url || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Isolated scripted native Team provider required");
  const response = await fetch(`${url}/__requests`);
  if (!response.ok) throw new Error(`Provider ledger ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}

describe("OMP native Team / independent GUI", () => {
  it("saves ordered duplicate slots, executes native yields, shows real relationships/details, cancels and reopens history", async () => {
    await prepareV4ConversationE2E();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await switchV4Mode("yolo");
    await sendV4Prompt("OMP_E2E_TEAM_PARENT_READY");
    await click("omp-team-sidebar-open");
    await tid("omp-team-page").waitForDisplayed({ timeout: 30000 });
    await click("omp-team-configure");
    await tid("omp-team-panel").waitForDisplayed({ timeout: 30000 });
    await click("omp-team-default");
    await tid("omp-team-model-search").setValue(`${OMP_PROVIDER_ID}/${OMP_MODEL_ID}`);
    const add = tid("omp-team-model-catalog").$("button");
    await add.waitForClickable({ timeout: 30000 });
    await add.click();
    await click("omp-team-copy-0");
    await tid("omp-team-member-1").waitForDisplayed({ timeout: 15000 });
    await click("omp-team-save");
    await tid("omp-team-receipt").waitForDisplayed({ timeout: 30000 });
    await screenshot("omp-team-config-saved");
    const profile = process.env.PI_CODING_AGENT_DIR;
    if (!profile) throw new Error("Isolated OMP profile missing");
    const config = parseDocument(await readFile(resolve(profile, "config.yml"), "utf8")).toJS() as {
      team?: { members?: string[] };
    };
    expect(config.team?.members).toHaveLength(2);
    expect(config.team?.members?.[0]).toBe(config.team?.members?.[1]);
    await click("omp-config-cancel");
    const floor = (await requests()).length;
    await tid("omp-team-task").setValue("OMP_E2E_TEAM_COMPLETE: investigate read-only options");
    await click("omp-team-start");
    await browser.waitUntil(
      async () => Array.from(await $$('[data-testid="omp-team-node"]')).length >= 2,
      { timeout: 60000, timeoutMsg: "Native Team never projected real Agent invocations" },
    );
    await screenshot("omp-team-native-stage");
    await browser.waitUntil(
      async () => (await tid("omp-team-run").getAttribute("data-status")) === "completed",
      { timeout: 120000, timeoutMsg: "Native structured Team did not complete" },
    );
    const nodes = await $$('[data-testid="omp-team-node"]');
    const ids = await Promise.all(
      Array.from(nodes).map((node) => node.getAttribute("data-node-id")),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(Array.from(await $$('[data-testid="omp-team-edge"]')).length).toBeGreaterThan(0);
    await nodes[0]!.click();
    await tid("omp-team-node-detail").waitForDisplayed({ timeout: 15000 });
    expect(await tid("omp-team-node-detail").getText()).toContain("OMP_E2E_TEAM");
    await screenshot("omp-team-relations-and-details");
    const nativeRequests = (await requests()).slice(floor);
    expect(
      nativeRequests.some((request) => JSON.stringify(request.tools).includes("noViableProposal")),
    ).toBe(true);
    expect(
      nativeRequests.some((request) => JSON.stringify(request.tools).includes("reportMarkdown")),
    ).toBe(true);
    await tid("omp-team-task").setValue("OMP_E2E_TEAM_CANCEL: hold the real native proposer");
    await click("omp-team-start");
    await browser.waitUntil(
      async () =>
        Array.from(await $$('[data-testid="omp-team-run"][data-status="running"]')).length > 0,
      { timeout: 30000, timeoutMsg: "Cancellable native Team did not start" },
    );
    const live = $('[data-testid="omp-team-run"][data-status="running"]');
    await live.$('[data-testid="omp-team-stop"]').click();
    await browser.waitUntil(
      async () =>
        Array.from(await $$('[data-testid="omp-team-run"][data-status="cancelled"]')).length > 0,
      { timeout: 30000, timeoutMsg: "Native Team cancellation was not observed" },
    );
    await screenshot("omp-team-cancelled");
    const beforeColdRead = (await requests()).filter((request) => request.tools?.length).length;
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await click("omp-team-sidebar-open");
    await tid("omp-team-page").waitForDisplayed({ timeout: 30000 });
    await click("omp-team-refresh");
    await browser.waitUntil(
      async () => Array.from(await $$('[data-testid="omp-team-run"]')).length >= 2,
      { timeout: 30000, timeoutMsg: "Cold native Team journal did not restore both runs" },
    );
    await screenshot("omp-team-reopened-history");
    expect((await requests()).filter((request) => request.tools?.length).length).toBe(
      beforeColdRead,
    );
  });
});
