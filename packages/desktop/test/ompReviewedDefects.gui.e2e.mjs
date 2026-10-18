import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  MOCK_MODEL_NAME,
  MOCK_MODEL_SELECTOR,
  MOCK_PROVIDER,
  MOCK_MODEL_ID,
} from "../../omp-agent/test/fixtures/ompMockServer.mjs";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import {
  assertRecoveredInteractions,
  assertStoredInteractions,
  exerciseMockInteractions,
  readMockRequests,
  reveal,
} from "./ompMockInteractions.assertions.mjs";
import { poll } from "./ompConversationAcceptance.assertions.mjs";

const endpoint = process.env.OMP_E2E_CDP_URL;
assert.ok(endpoint, "Set OMP_E2E_CDP_URL to an isolated OmpCode Electron CDP endpoint");
const runId = process.env.OMP_E2E_RUN_ID;
assert.ok(runId, "Set OMP_E2E_RUN_ID to a unique test marker");
const phase = process.env.OMP_E2E_PHASE ?? "live";
assert.ok(phase === "live" || phase === "recovery", "OMP_E2E_PHASE must be live or recovery");
const evidenceDir = process.env.OMP_E2E_EVIDENCE_DIR;
assert.ok(evidenceDir, "Set OMP_E2E_EVIDENCE_DIR for live and same-root recovery evidence");
const identityReceipt = join(evidenceDir, `reviewed-defects-${runId}.json`);
const manifestPath = process.env.OMP_E2E_RUNTIME_MANIFEST;
assert.ok(manifestPath, "Use the owned launcher runtime manifest, never a daily GUI instance");
const runtime = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(runtime.mock.modelSelector, MOCK_MODEL_SELECTOR);
const rendererUrl = runtime.rendererUrl;
const rendererPrefix = rendererUrl ? `${rendererUrl.replace(/\/+$/u, "")}/` : undefined;

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) =>
      rendererPrefix
        ? candidate.url().startsWith(rendererPrefix)
        : /^http:\/\/(?:localhost|127\.0\.0\.1):5194\//u.test(candidate.url()),
    );
  assert.ok(page, "Expected an isolated OmpCode renderer page");
  page.setDefaultTimeout(30_000);
  const rendererProblems = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") {
      rendererProblems.push(message.text());
    }
  });
  page.on("pageerror", (error) => rendererProblems.push(error.message));
  async function assertIsolation() {
    const isolation = await readIsolationEvidence(runtime.isolationEvidence);
    assert.equal(isolation.electronPid, runtime.electronPid);
    assert.equal(isolation.verified, true);
    assert.equal(isolation.mode, "hidden-native-windows");
    assert.ok(isolation.windows.length);
    for (const window of isolation.windows) {
      assert.equal(window.visible, false);
      assert.equal(window.focused, false);
      assert.equal(window.focusable, false);
    }
  }
  await assertIsolation();
  const startupRequests = await readMockRequests(runtime);
  if (phase === "recovery")
    assert.deepEqual(
      startupRequests.calls,
      [],
      "Cold startup must not replay historical model inputs",
    );

  const model = page.getByTestId("chat-model-select-trigger");
  await model.waitFor({ state: "visible" });
  if ((await model.getAttribute("aria-label")) !== `${MOCK_PROVIDER}/${MOCK_MODEL_NAME}`) {
    await model.click();
    await page.getByTestId(`chat-model-select-group-omp-provider:${MOCK_PROVIDER}`).hover();
    await page
      .getByTestId(`chat-model-select-item-custom:${MOCK_PROVIDER}:${MOCK_MODEL_ID}`)
      .click();
  }
  assert.equal(await model.getAttribute("aria-label"), `${MOCK_PROVIDER}/${MOCK_MODEL_NAME}`);

  async function sendAndWait(marker) {
    const prompt = `ZCODE_MOCK_TEXT ${marker}`;
    const beforeCalls = (await readMockRequests(runtime)).calls.length;
    const input = page.getByTestId("v4-composer-input");
    const send = page.getByTestId("v4-composer-send");
    await input.fill(prompt);
    // 真实悬浮与两轮状态切换覆盖 Tooltip 生命周期，不按实现 key 或文案断言。
    await send.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await send.click();
    const held = await poll(
      async () => {
        const observed = await readMockRequests(runtime);
        return {
          barrier: observed.acceptance.barriers[marker],
          calls: observed.calls.map(({ requestId, completed, aborted }) => ({
            requestId,
            completed,
            aborted,
          })),
        };
      },
      (observed) => observed.barrier === "waiting",
      `Identity response barrier ${marker}`,
    );
    assert.equal(
      held.calls.length,
      beforeCalls + 1,
      "One send must start exactly one HTTP request",
    );
    const heldRequest = held.calls.at(-1);
    assert.equal(heldRequest.completed, false);
    assert.equal(heldRequest.aborted, false);
    await page.getByTestId("v4-stop").hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await captureIsolationScreenshot(join(evidenceDir, `composer-stop-${marker}.png`));
    // 可悬浮提示有指针过渡区与焦点语义；真实返回编辑器，而非仅瞬移鼠标。
    await input.click();
    await poll(
      () => input.evaluate((element) => element.contains(element.ownerDocument.activeElement)),
      (focused) => focused,
      "Returning to the composer must transfer keyboard focus to the editor",
    );
    await page.getByRole("tooltip").waitFor({ state: "hidden" });
    // 悬浮截图和移开关闭必须发生在同一真实请求未终结时，不能接受已空闲的替代状态。
    const beforeRelease = (await readMockRequests(runtime)).calls.at(-1);
    assert.equal(beforeRelease.requestId, heldRequest.requestId);
    assert.equal(beforeRelease.completed, false);
    assert.equal(beforeRelease.aborted, false);
    const releaseResponse = await fetch(runtime.mock.controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "release", name: marker }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(releaseResponse.status, 200, await releaseResponse.text());
    await page.getByText(marker, { exact: true }).waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible", timeout: 30_000 });
    const completed = (await readMockRequests(runtime)).calls.at(-1);
    assert.equal(completed.requestId, heldRequest.requestId);
    assert.equal(completed.completed, true);
    assert.equal(completed.aborted, false);
    return marker;
  }

  const taskRows = page.locator('li[data-testid^="task-item-"]');
  const readTaskIds = () =>
    taskRows.evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
  // OMP 标题真实截断到 60 字再加省略号；身份验收不能按完整提示词或自动标题定位。
  const saved = phase === "recovery" ? JSON.parse(await readFile(identityReceipt, "utf8")) : null;
  if (saved) assert.equal(saved.runId, runId, "Recovery must consume this exact live attempt");
  if (saved) {
    assert.equal(
      saved.launcherPid === runtime.launcherPid,
      false,
      "Recovery requires a new launcher process",
    );
    assert.equal(saved.runRoot, runtime.runRoot, "Recovery must reuse the same isolated root");
  }
  const before = saved?.before ?? (await readTaskIds());
  if (phase === "live") await sendAndWait(`GUI_IDENTITY_FIRST_${runId}`);
  await page.waitForFunction((previous) => {
    const created = [...document.querySelectorAll('li[data-testid^="task-item-"]')]
      .map((item) => item.getAttribute("data-testid"))
      .filter((id) => !previous.includes(id));
    return (
      created.length === 1 && /^task-item-[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(created[0] ?? "")
    );
  }, before);
  const created = (await readTaskIds()).filter((id) => !before.includes(id));
  assert.equal(created.length, 1, "One conversation must have one sidebar task");
  const taskTestId = created[0];
  if (saved) assert.equal(taskTestId, saved.taskTestId, "Cold recovery must keep the live UUID");
  const matchingTask = page.getByTestId(taskTestId);
  await matchingTask.click();
  const firstReply = page.getByText(`GUI_IDENTITY_FIRST_${runId}`, { exact: true });
  await reveal(page, firstReply);
  await firstReply.waitFor({ state: "visible" });
  if (phase === "live") {
    await sendAndWait(`GUI_IDENTITY_SECOND_${runId}`);
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  } else {
    const secondReply = page.getByText(`GUI_IDENTITY_SECOND_${runId}`, { exact: true });
    await reveal(page, secondReply);
    await secondReply.waitFor({ state: "visible" });
  }
  await captureIsolationScreenshot(join(evidenceDir, `identity-${phase}-${runId}.png`));
  const interactions =
    phase === "live"
      ? { runId, ...(await exerciseMockInteractions(page, runtime, evidenceDir, runId)) }
      : saved.interactions;
  if (phase === "recovery")
    await assertRecoveredInteractions(page, interactions, taskTestId.slice("task-item-".length));
  const records = await assertStoredInteractions(runtime, taskTestId, interactions, saved?.records);
  const requests = await readMockRequests(runtime);
  if (phase === "recovery") {
    // 读取历史不能重发模型；原来只保存 requests，重复提交仍会被当作成功。
    assert.deepEqual(
      requests.calls,
      [],
      "Opening recovered parent/child records must call no model",
    );
    const third = `GUI_IDENTITY_THIRD_${runId}`;
    await sendAndWait(third);
    const resumed = await readMockRequests(runtime);
    assert.equal(
      resumed.calls.length,
      1,
      "One explicit resumed input must produce one model request",
    );
    assert.equal(resumed.calls[0].completed, true);
    const context = resumed.calls[0].messages;
    const content = (message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    assert.ok(content(context.at(-1)).endsWith(`ZCODE_MOCK_TEXT ${third}`));
    for (const marker of [`GUI_IDENTITY_FIRST_${runId}`, `GUI_IDENTITY_SECOND_${runId}`])
      assert.equal(
        context.filter(
          (message) => message.role === "assistant" && content(message).includes(marker),
        ).length,
        1,
        `Resumed request must retain exactly one original assistant response: ${marker}`,
      );
    const afterResume = await assertStoredInteractions(runtime, taskTestId, interactions);
    assert.equal(afterResume.parentId, records.parentId);
    assert.equal(afterResume.childContentHash, records.childContentHash);
    assert.equal(
      afterResume.parentMessageCount,
      records.parentMessageCount + 2,
      "Resuming must append only its real user/assistant pair",
    );
    await writeFile(
      join(evidenceDir, `mock-resume-${runId}.json`),
      JSON.stringify(resumed, null, 2),
    );
  }
  await writeFile(
    join(evidenceDir, `mock-requests-${phase}-${runId}.json`),
    JSON.stringify(requests, null, 2),
  );
  assert.equal(
    (await readTaskIds()).filter((id) => !before.includes(id)).length,
    1,
    "A later turn must not revive the temporary task ID",
  );
  assert.equal(await matchingTask.getAttribute("data-testid"), taskTestId);
  if (phase === "live") {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      identityReceipt,
      JSON.stringify(
        {
          runId,
          before,
          taskTestId,
          interactions,
          records,
          launcherPid: runtime.launcherPid,
          runRoot: runtime.runRoot,
        },
        null,
        2,
      ),
    );
  }
  await captureIsolationScreenshot(join(evidenceDir, `interactions-${phase}-${runId}.png`));
  await assertIsolation();
  assert.deepEqual(
    rendererProblems,
    [],
    "Real conversation transitions must have no renderer problems",
  );
  {
    // Renderer 正常不代表适配器接受了核心帧；真实两轮曾因 schema 缺项持续拒绝合法通知。
    const stderr = await readFile(join(runtime.runRoot, "electron-stderr.log"), "utf8");
    assert.doesNotMatch(
      stderr,
      /omp_core_frame_decode_failed/u,
      "Real core frames must decode without adapter rejection",
    );
  }
  console.log(
    `omp GUI identity ${phase}: real OMP + local mock; tools/ask/child records; stable task ${taskTestId}`,
  );
} finally {
  await browser.close();
}
