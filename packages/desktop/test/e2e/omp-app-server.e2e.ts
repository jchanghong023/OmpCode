import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { parseDocument } from "yaml";
import { DEFAULT_WORKSPACE, setInputValueByTestIdDom } from "./helpers/desktop-app.js";
import { startDraftFromProject } from "./helpers/project-sidebar.js";
import {
  clickV4Stop,
  clickV4Send,
  getV4CompactMarkers,
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  switchV4Mode,
  switchV4Model,
  waitForV4CompactMarker,
  waitForV4Pane,
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
import { runOmpNativeSource } from "./helpers/omp-native-acceptance.js";

const tid = (id: string) => $(`[data-testid="${id}"]`);
async function click(id: string) {
  const element = tid(id);
  await element.waitForDisplayed({ timeout: 30000 });
  await element.scrollIntoView();
  await element.click();
}
async function boundSession(): Promise<string> {
  const pane = await waitForV4Pane(
    (value) => Boolean(value.sessionId && value.sessionId !== "draft"),
    "OMP session did not bind",
  );
  if (!pane.sessionId) throw new Error("OMP session identity missing");
  return pane.sessionId;
}
async function waitSettled() {
  await waitForV4Pane((value) => !value.canStop, "OMP execution did not settle", 30000);
}
async function modelRequests(): Promise<ModelRequest[]> {
  const baseUrl = process.env.OMP_E2E_PROVIDER_URL;
  if (!baseUrl || new URL(baseUrl).hostname !== "127.0.0.1")
    throw new Error("Local OMP fixture not installed");
  const response = await fetch(`${baseUrl}/__requests`);
  if (!response.ok) throw new Error(`Fixture ledger failed: ${response.status}`);
  return response.json() as Promise<ModelRequest[]>;
}
async function nativePersistence() {
  return runOmpNativeSource<{ files: string[]; credentials: string }>(
    `import { readFile } from "node:fs/promises";
     import { createHash } from "node:crypto";
     import { resolve } from "node:path";
     import { pathToFileURL } from "node:url";
     // The actual OMP source checkout is selected by the runner at runtime.
     const { AuthStorage } = await import(pathToFileURL(resolve(process.env.OMP_E2E_SOURCE_DIR, "session/auth-storage.ts")).href);
     const dir = process.env.PI_CODING_AGENT_DIR;
     const files = await Promise.all(["config.yml", "models.yml"].map(name => readFile(resolve(dir, name), "utf8")));
     const auth = await AuthStorage.create(resolve(dir, "agent.db"));
     try {
       await auth.credentials.reload();
       const rows = auth.credentials.providers().sort().map(provider => [provider, auth.credentials.credentials(provider)]);
       const credentials = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
       console.log("OMP_E2E_RESULT:" + JSON.stringify({ files, credentials }));
     } finally { auth.close(); }`,
    DEFAULT_WORKSPACE,
  );
}
async function selectTemporaryModel(provider: string, model: string) {
  // 原生认证已迁入 agent.db；比较凭据语义指纹，避免将会话等无关 SQLite 写入误判为改认证。
  const persistedBefore = await nativePersistence();
  await click("omp-config-open");
  const select = tid("omp-temporary-model");
  await select.waitForDisplayed({ timeout: 30000 });
  await select.scrollIntoView();
  await select.selectByVisibleText(`${provider}/${model}`);
  await browser.waitUntil(
    async () =>
      (await tid("omp-config-notice").getAttribute("data-message-id")) ===
      "omp.configuration.temporaryModelSwitched",
    {
      timeout: 30000,
      timeoutMsg: "Temporary model operation did not confirm a real session switch",
    },
  );
  expect(await nativePersistence()).toEqual(persistedBefore);
  await click("omp-config-cancel");
}

// Selected automatically for an explicit Agent override, and explicitly runnable
// with --spec. No runtime/service replacement or renderer business-state injection.
describe("OMP actual app-server / Electron GUI", () => {
  it("two same-workspace sessions stream, execute tools, answer questions, stop independently and restore after refresh", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    await sendV4Prompt("OMP_E2E_STOP_A");
    const a = await boundSession();
    await waitForV4TimelineContaining("OMP_E2E_STOP_A_STREAMING");
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    // Native v4 approvals are unsupported. Authorize this real write through the
    // normal Full access control, never through an approval-shaped Ask response.
    await switchV4Mode("yolo");
    await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
      timeout: 30000,
      timeoutMsg: "Session B draft did not project the selected Full access mode",
    });
    const proofFile = resolve(DEFAULT_WORKSPACE, "omp-e2e-proof.txt");
    await expect(readFile(proofFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await sendV4Prompt("OMP_E2E_TOOL_B");
    const b = await boundSession();
    expect(b).not.toBe(a);
    expect((await getV4ConfigProjection()).mode).toBe("yolo");
    await waitForV4TimelineContaining("OMP_E2E_TOOL_B_DONE");
    await waitSettled();
    expect(await readFile(proofFile, "utf8")).toBe("OMP_E2E_TOOL_B");
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("OMP_E2E_STOP_A_STREAMING");

    await selectV4TaskById(a);
    await waitForV4Pane(
      (value) => value.canStop,
      "Background session A was implicitly stopped by navigation",
    );
    await clickV4Stop();
    await waitSettled();
    await selectV4TaskById(b);
    await selectTemporaryModel(OMP_PROVIDER_ID, "omp-alternate");
    await sendV4Prompt("OMP_E2E_STREAM_B");
    await waitForV4TimelineContaining("OMP_E2E_STREAM_B_STREAMING");
    await browser.refresh();
    await waitForV4Pane(
      (value) => value.sessionId === b,
      "Renderer refresh changed OMP session identity",
      60000,
    );
    await waitForV4TimelineContaining("OMP_E2E_STREAM_B_DONE");
    await waitSettled();
    await browser.waitUntil(
      async () => {
        const selection = await getV4ModelConfig();
        return (
          selection.provider === OMP_PROVIDER_ID &&
          selection.model === "omp-alternate" &&
          selection.thought === "disabled"
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "Renderer refresh lost session B's canonical model and reasoning selection",
      },
    );

    await sendV4Prompt("OMP_E2E_QUESTION_B");
    const question = $('[data-elicitation-dialog-body="true"]');
    await question.waitForDisplayed({ timeout: 30000 });
    expect(await question.getText()).toContain("OMP isolated question?");
    const option = question.$('button[role="option"]');
    await option.waitForDisplayed({ timeout: 10000 });
    await option.click();
    const submit = $('[data-elicitation-dialog-footer="true"] button:last-child');
    if (await submit.isExisting()) await submit.click();
    await waitForV4TimelineContaining("OMP_E2E_QUESTION_B_DONE");
    await waitSettled();
    await selectTemporaryModel("omp-anthropic", "omp-anthropic-chat");
    await sendV4Prompt("OMP_E2E_ANTHROPIC_B");
    await waitForV4TimelineContaining("OMP_E2E_ANTHROPIC_B_DONE");
    await waitSettled();
    const requests = await modelRequests();
    expect(
      requests.find((request) =>
        JSON.stringify(request.messages.at(-1)).includes("OMP_E2E_STREAM_B"),
      )?.model,
    ).toBe("omp-alternate");
    expect(
      requests.some((request) => JSON.stringify(request.messages.at(-1)).includes("Continue")),
    ).toBe(true);
    expect(
      requests.find((request) =>
        JSON.stringify(request.messages.at(-1)).includes("OMP_E2E_ANTHROPIC_B"),
      )?.model,
    ).toBe("omp-anthropic-chat");
    await selectV4TaskById(a);
    expect((await getV4PaneSnapshot()).timelineText).not.toContain("OMP_E2E_QUESTION_B");
    await sendV4Prompt("OMP_E2E_MODEL_A");
    await waitForV4TimelineContaining("OMP_E2E_MODEL_A_DONE");
    await waitSettled();
    const isolatedRequests = await modelRequests();
    expect(
      isolatedRequests.find((request) =>
        JSON.stringify(request.messages.at(-1)).includes("OMP_E2E_MODEL_A"),
      )?.model,
    ).toBe(OMP_MODEL_ID);
    await selectV4TaskById(a);
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-conversation.png"),
    );
  });

  it("real role and Team GUI preserves unresolved slots, previews without writes, saves duplicates and cancels dirty drafts", async function () {
    this.timeout(120000);
    await click("omp-config-open");
    await tid("omp-configuration-panel").waitForDisplayed({ timeout: 30000 });
    await tid("omp-team-member-1").waitForDisplayed({ timeout: 30000 });
    expect(await tid("omp-team-saved-lists").getText()).toContain("stale-provider/removed-model");
    const configFile = resolve(process.env.PI_CODING_AGENT_DIR!, "config.yml");
    const original = await readFile(configFile, "utf8");
    const roleSelect = tid("omp-role-select-default");
    await roleSelect.scrollIntoView();
    await roleSelect.selectByVisibleText(`${OMP_PROVIDER_ID}/omp-alternate`);
    await click("omp-role-save-default");
    await browser.waitUntil(
      // 候选 option 在保存前已存在；只以实际目标文件的用户 role 为保存事实。
      async () => {
        const document = parseDocument(await readFile(configFile, "utf8"));
        return (
          document.errors.length === 0 &&
          document.getIn(["modelRoles", "default"]) === `${OMP_PROVIDER_ID}/omp-alternate`
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "Role save did not read back the persisted user selection",
      },
    );
    const afterRole = await readFile(configFile, "utf8");
    expect(afterRole).not.toBe(original);
    const member = tid("omp-team-member-1").$("select");
    await member.scrollIntoView();
    // JSON value 含引号；selectByAttribute 会拼出非法 XPath，直接定位真实 option。
    await member
      .$(
        `option[value=${JSON.stringify(JSON.stringify({ provider: OMP_PROVIDER_ID, modelId: "omp-alternate" }))}]`,
      )
      .click();
    await tid("omp-team-preview").waitForDisplayed({ timeout: 30000 });
    expect(await readFile(configFile, "utf8")).toBe(afterRole);
    const copy = tid("omp-team-copy-1");
    await copy.click();
    await tid("omp-team-member-2").waitForDisplayed({ timeout: 10000 });
    await click("omp-team-save");
    await browser.waitUntil(
      async () => (await tid("omp-team-receipt").getAttribute("data-save-state")) === "complete",
      {
        timeout: 30000,
        timeoutMsg: "Team save lacks a complete active/persistent receipt",
      },
    );
    const saved = await readFile(configFile, "utf8");
    expect(saved).not.toContain("stale-provider/removed-model");
    expect(saved.match(/omp-e2e\/omp-alternate/gu)?.length).toBeGreaterThanOrEqual(3); // role plus two ordered Team slots
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-configuration.png"),
    );
    await click("omp-config-cancel");
    await click("omp-config-open");
    await tid("omp-team-member-2").waitForDisplayed({ timeout: 30000 });
    await click("omp-team-default");
    await tid("omp-team-preview").waitForDisplayed({ timeout: 30000 });
    expect(await readFile(configFile, "utf8")).toBe(saved);
    await click("omp-config-cancel");
    await click("omp-config-open");
    await tid("omp-team-member-2").waitForDisplayed({ timeout: 30000 });
    expect(await readFile(configFile, "utf8")).toBe(saved);
    await click("omp-config-cancel");
  });

  it("manual compact commits a real native summary and restores its marker and provider context", async function () {
    this.timeout(180000);
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await switchV4Model(OMP_PROVIDER_ID, OMP_MODEL_ID, "disabled");
    const ledgerStart = (await modelRequests()).length;
    await sendV4Prompt("OMP_E2E_COMPACT_SEED");
    const sessionId = await boundSession();
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_SEED_DONE");
    await waitSettled();

    // The oversized first reply is older than a complete small turn. Native
    // cut-point selection can summarize that pair without reducing its defaults.
    await sendV4Prompt("OMP_E2E_COMPACT_TAIL");
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_TAIL_DONE");
    await waitSettled();
    const before = (await modelRequests()).slice(ledgerStart);
    const tailRequest = before.find((request) =>
      JSON.stringify(request.messages.at(-1)).includes("OMP_E2E_COMPACT_TAIL"),
    );
    expect(tailRequest).toBeDefined();
    expect(JSON.stringify(tailRequest!.messages)).toContain(OMP_COMPACT_ARCHIVE_MARKER);
    expect(before.some(isOmpCompactionSummaryRequest)).toBe(false);

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15000,
      timeoutMsg: "OMP compact composer input did not appear",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await waitSettled();
    const compactMarker = (await getV4CompactMarkers()).find(
      (marker) => marker.origin === "manual" && marker.status === "success",
    );
    expect(compactMarker).toBeDefined();
    const compactRequests = (await modelRequests()).slice(ledgerStart);
    const summaryRequest = compactRequests.find(isOmpCompactionSummaryRequest);
    expect(summaryRequest).toBeDefined();
    expect(JSON.stringify(summaryRequest!.messages)).toContain(OMP_COMPACT_ARCHIVE_MARKER);
    expect(JSON.stringify(summaryRequest!.messages)).toContain("cedar-731");

    // Read the actual next provider context, not the old visible transcript:
    // the journal's accepted summary replaces the archive and keeps the tail.
    const assertSummaryContext = async (prompt: string) => {
      const requests = (await modelRequests()).slice(ledgerStart);
      const request = requests.find(
        (value) =>
          !isOmpCompactionSummaryRequest(value) &&
          JSON.stringify(value.messages.at(-1)).includes(prompt),
      );
      expect(request).toBeDefined();
      const history = JSON.stringify(request!.messages);
      expect(history).toContain(JSON.stringify(OMP_COMPACT_SUMMARY).slice(1, -1));
      expect(history).toContain("OMP_E2E_COMPACT_TAIL_DONE");
      expect(history).not.toContain(OMP_COMPACT_ARCHIVE_MARKER);
      expect(history).not.toContain("OMP_E2E_COMPACT_SEED_DONE");
    };
    await sendV4Prompt("OMP_E2E_COMPACT_AFTER");
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_AFTER_DONE");
    await waitSettled();
    await assertSummaryContext("OMP_E2E_COMPACT_AFTER");

    await browser.refresh();
    await waitForV4Pane(
      (value) => value.sessionId === sessionId,
      "Renderer refresh lost the compacted OMP session",
      60000,
    );
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId);
    await waitForV4CompactMarker({ origin: "manual", status: "success" });
    expect(
      (await getV4CompactMarkers()).find(
        (marker) => marker.origin === "manual" && marker.status === "success",
      )?.rowId,
    ).toBe(compactMarker!.rowId);
    await sendV4Prompt("OMP_E2E_COMPACT_RESTORED");
    await waitForV4TimelineContaining("OMP_E2E_COMPACT_RESTORED_DONE");
    await waitSettled();
    await assertSummaryContext("OMP_E2E_COMPACT_RESTORED");
    await browser.saveScreenshot(
      resolve(process.env.ZCODE_E2E_ARTIFACT_DIR!, "omp-compact-restored.png"),
    );
  });
});
