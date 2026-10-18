import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureIsolationScreenshot, readIsolationEvidence } from "./ompCore.evidence.cjs";
import { C, latestInput, promptOf, textOf } from "./ompConversationAcceptance.fixture.mjs";
import {
  assertPersistedHistory,
  diagnostics,
  exerciseGuideInputs,
  idle,
  poll,
  queued,
  queueRows,
  release,
  reply,
  sameTask,
  setInputMode,
  stopRequest,
  stored,
  submit,
  taskIds,
  timelineOccurrences,
} from "./ompConversationAcceptance.assertions.mjs";
import {
  exerciseConversationAttachments,
  recoverConversationEvidence,
} from "./ompConversationAcceptance.attachments.mjs";
import { assertChainFiles, assertPersistedTools } from "./ompConversationAcceptance.tools.mjs";

const required = (name) => {
  assert.ok(process.env[name], `Missing gate-owned ${name}`);
  return process.env[name];
};
const endpoint = required("OMP_E2E_CDP_URL");
const phase = required("OMP_E2E_PHASE");
assert.ok(["live", "recovery"].includes(phase));
const runtime = JSON.parse(await readFile(required("OMP_E2E_RUNTIME_MANIFEST"), "utf8"));
assert.equal(runtime.suite, "conversation");
const manifest = runtime.acceptance;
assert.ok(manifest && manifest.phase === phase);
assert.equal(manifest.workspace, runtime.requestedWorkspace);
assert.equal(manifest.configRoot, runtime.configRoot);
const runId = required("OMP_E2E_RUN_ID");
const evidence = required("OMP_E2E_EVIDENCE_DIR");
await mkdir(evidence, { recursive: true });
const receiptPath = join(evidence, `conversation-${runId}.json`);
const rendererLogs = [];
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith(runtime.rendererUrl));
  assert.ok(page, "Use only the owned renderer");
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on("pageerror", (error) => {
    rendererLogs.push({ level: "pageerror", text: error.message });
    problems.push(error.message);
  });
  page.on("console", (message) => {
    if (!["warning", "error"].includes(message.type())) return;
    const text = message.text();
    rendererLogs.push({ level: message.type(), text });
    // 负例需要保留业务失败日志；只把未处理运行时/React错误认定为渲染器缺陷。
    if (
      /\b(?:uncaught|unhandled|(?:Reference|Type|Syntax|Range|Eval|URI)Error)\b|invalid hook call|maximum update depth|cannot update a component|can't perform a React state update|rendered (?:more|fewer) hooks|hydration|each child in a list|validateDOMNesting|React does not recognize|Minified React error|an error occurred in the </iu.test(
        text,
      )
    )
      problems.push(text);
  });
  const isolation = async () => {
    const actual = await readIsolationEvidence(runtime.isolationEvidence);
    assert.equal(actual.electronPid, runtime.electronPid);
    assert.equal(actual.mode, "hidden-native-windows");
    assert.equal(actual.verified, true);
    assert.ok(actual.windows.length > 0);
    for (const window of actual.windows) {
      assert.equal(window.visible, false);
      assert.equal(window.focused, false);
      assert.equal(window.focusable, false);
    }
  };
  await isolation();
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    0,
    "Opening the suite must never generate an unsolicited model turn",
  );
  const screenshot = (name) =>
    captureIsolationScreenshot(join(evidence, `conversation-${phase}-${name}-${runId}.png`));
  const notRevived = async (includeQueue = true) => {
    const stopped = [
      ["STOP_PREFIX_VISIBLE", "STOP_LATE_MUST_NOT_REVIVE"],
      ["QUEUE_STOP_PREFIX", "QUEUE_STOP_LATE_MUST_NOT_REVIVE"],
    ];
    for (const [prefix, forbidden] of includeQueue ? stopped : stopped.slice(0, 1)) {
      // 先挂载被停止的旧回复，避免虚拟化或合并正文节点让晚到文本断言假绿。
      try {
        await reply(page, prefix);
      } catch (error) {
        const viewport = await page
          .getByTestId("v4-timeline")
          .first()
          .evaluate((element) => ({
            scrollTop: element.scrollTop,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            rowCount: element.getAttribute("data-row-count"),
            rows: Array.from(element.querySelectorAll("[data-row-id]"), (row) => ({
              id: row.getAttribute("data-row-id"),
              text: row.textContent,
            })),
            queries: Array.from(
              document.querySelectorAll("button[data-query-row-id]"),
              (button) => ({
                id: button.getAttribute("data-query-row-id"),
                turnId: button.getAttribute("data-turn-id"),
                label: button.getAttribute("aria-label"),
              }),
            ),
          }));
        await writeFile(
          join(evidence, `conversation-${phase}-unrevealed-${runId}.json`),
          JSON.stringify({ prefix, viewport }, null, 2),
        );
        await screenshot("stopped-history-unrevealed");
        throw error;
      }
      assert.equal(await timelineOccurrences(page, forbidden), 0);
    }
  };
  if (phase === "live") {
    assert.deepEqual(await taskIds(page), [], "The suite needs a truly empty isolated workspace");
    for (const file of manifest.files) {
      const bytes = await readFile(file.path);
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }
    for (const call of [manifest.chain[0], manifest.chain[2]])
      await assert.rejects(readFile(call.arguments.path), { code: "ENOENT" });
    await assert.rejects(readFile(manifest.missingPath), { code: "ENOENT" });

    await submit(page, C.stream);
    await reply(page, "STREAM_PREFIX_VISIBLE");
    await page.getByTestId("v4-stop").waitFor({ state: "visible" });
    let observed = await diagnostics(runtime);
    assert.equal(observed.calls.length, 1);
    assert.equal(
      observed.calls[0].completed,
      false,
      "Prefix must render while HTTP is still streaming",
    );
    assert.equal(observed.calls[0].aborted, false);
    assert.equal(await timelineOccurrences(page, "STREAM_BODY_GREW_BEFORE_TERMINAL"), 0);
    await screenshot("stream-prefix");
    await release(runtime, "stream-body");
    await reply(page, "STREAM_BODY_GREW_BEFORE_TERMINAL");
    assert.equal(
      await timelineOccurrences(page, "STREAM_PREFIX_VISIBLE"),
      1,
      "Streaming growth must retain the already visible prefix",
    );
    observed = await diagnostics(runtime);
    assert.equal(
      observed.calls[0].completed,
      false,
      "Body growth must be visible before the terminal event",
    );
    await page.getByTestId("v4-stop").waitFor({ state: "visible" });
    assert.equal(await timelineOccurrences(page, "STREAM_DONE"), 0);
    await screenshot("stream-body-before-terminal");
    await release(runtime, "stream-finish");
    await reply(page, "STREAM_DONE");
    assert.equal(await timelineOccurrences(page, "STREAM_PREFIX_VISIBLE"), 1);
    assert.equal(await timelineOccurrences(page, "STREAM_BODY_GREW_BEFORE_TERMINAL"), 1);
    await idle(page);
    await poll(
      () => taskIds(page),
      (ids) => ids.length === 1,
      "one persistent task identity",
    );
    const [taskId] = await taskIds(page);
    assert.match(taskId, /^task-item-[0-9a-f]{8}-[0-9a-f-]{27,}$/iu);

    await submit(page, C.stop);
    await reply(page, "STOP_PREFIX_VISIBLE");
    const firstAbortId = await stopRequest(
      page,
      runtime,
      C.stop,
      "stop-late",
      "STOP_LATE_MUST_NOT_REVIVE",
    );
    await submit(page, C.afterStop);
    await reply(page, "AFTER_STOP_SAME_SESSION_DONE");
    await idle(page);
    await sameTask(page, taskId);
    await notRevived(false);

    await exerciseGuideInputs(page, runtime, screenshot);

    await setInputMode(page, "queue");
    await submit(page, C.queue);
    await reply(page, "QUEUE_BASE_PREFIX");
    const queueCalls = (await diagnostics(runtime)).calls.length;
    const ids = [];
    for (let i = 0; i < 3; i++) {
      await submit(page, "hello", true);
      const current = await queued(page, i + 1);
      assert.deepEqual(
        current.slice(0, i),
        ids,
        "Adding equal text must preserve older pending identities",
      );
      ids.push(current.at(-1));
    }
    assert.equal(await queueRows(page).getByText("hello", { exact: true }).count(), 3);
    assert.equal(
      (await diagnostics(runtime)).calls.length,
      queueCalls,
      "No queued hello may dispatch before the model boundary",
    );
    await screenshot("three-independent-hello-items");
    await release(runtime, "queue-base");
    for (let n = 1; n <= 3; n++) {
      await reply(page, `HELLO_${n}_STARTED`);
      await queued(page, 3 - n, ids.slice(n));
      const current = await diagnostics(runtime);
      assert.equal(
        current.calls.length,
        queueCalls + n,
        "One consumption must correspond to exactly one HTTP request",
      );
      const call = current.calls.at(-1);
      assert.equal(promptOf(latestInput(call.messages).content), "hello");
      assert.equal(
        call.completed,
        false,
        "Each queue assertion is taken while its model response is held",
      );
      await release(runtime, `hello-${n}`);
      await reply(page, `HELLO_${n}_DONE`);
    }
    await idle(page);
    await queued(page, 0, []);

    await submit(page, C.queueStop);
    await reply(page, "QUEUE_STOP_PREFIX");
    for (let n = 1; n <= 3; n++) await submit(page, `STOP_PENDING_${n}`, true);
    await queued(page, 3);
    const secondAbortId = await stopRequest(
      page,
      runtime,
      C.queueStop,
      "queue-stop-late",
      "QUEUE_STOP_LATE_MUST_NOT_REVIVE",
    );
    await queued(page, 0, []);
    await submit(page, C.afterQueueStop);
    await reply(page, "AFTER_QUEUE_STOP_DONE");
    await idle(page);
    await notRevived();

    await submit(page, C.queueFail);
    await reply(page, "QUEUE_FAIL_PREFIX");
    for (let n = 1; n <= 3; n++) await submit(page, `FAIL_PENDING_${n}`, true);
    await queued(page, 3);
    const failureCalls = (await diagnostics(runtime)).calls.length;
    await release(runtime, "queue-fail");
    // 隔离 GUI 实测证据（2026-10-18，真实 OMP + 模拟模型）：provider 失败被投影为
    // control.lastError → Composer 上方错误横幅，DOM 为
    // <div data-testid="chat-error-banner" data-error-code="omp_provider_error">，
    // 正文含原始 "Anthropic stream error (api_error): CONVERSATION_QUEUE_PROVIDER_FAILURE"。
    // 该横幅是普通容器（packages/ui/src/ChatErrorBanner.tsx 只挂 data-testid/data-error-code），
    // 全页没有任何 role="alert"，因此按真实 DOM 归属断言"原始错误已显现"，
    // 不为错误选择器改变产品角色（docs/requirements/test-gates.md）。
    await page
      .getByTestId("chat-error-banner")
      .filter({ hasText: "CONVERSATION_QUEUE_PROVIDER_FAILURE" })
      .waitFor({ state: "visible" });
    await idle(page);
    await queued(page, 0, []);
    assert.equal(
      (await diagnostics(runtime)).calls.length,
      failureCalls,
      "Provider failure must not execute stranded waiting inputs",
    );
    await screenshot("queue-failure-cleared");
    await submit(page, C.afterQueueFail);
    await reply(page, "AFTER_QUEUE_FAIL_DONE");
    await idle(page);

    const toolEvidence = await exerciseConversationAttachments({
      page,
      runtime,
      manifest,
      screenshot,
    });
    await submit(page, C.end);
    await reply(page, "CONVERSATION_LIVE_COMPLETE");
    await idle(page);
    await sameTask(page, taskId);
    await assertChainFiles(manifest, toolEvidence.files);
    await notRevived();
    // diagnostics.completed 专指成功终态；已在 GUI 和持久历史核对的提供者失败不能冒充成功。
    const final = await poll(
      () => diagnostics(runtime),
      (value) =>
        value.calls.length === 24 &&
        value.calls.every(
          (call) =>
            call.aborted ||
            call.completed ||
            promptOf(latestInput(call.messages)?.content) === C.queueFail,
        ),
      "all expected successful HTTP calls settled",
    );
    assert.equal(final.acceptance.cursor, 24);
    assert.equal(final.acceptance.expectedRequests, 24);
    assert.equal(final.calls.length, 24);
    assert.deepEqual(
      final.calls.filter((call) => call.aborted).map((call) => call.requestId),
      [firstAbortId, secondAbortId],
    );
    const providerFailures = final.calls.filter(
      (call) => promptOf(latestInput(call.messages)?.content) === C.queueFail,
    );
    assert.equal(providerFailures.length, 1);
    assert.equal(providerFailures[0].completed, false);
    assert.equal(providerFailures[0].aborted, false);
    const history = await poll(
      () => stored(runtime, taskId),
      (value) =>
        value.records.some(
          (record) =>
            record.role === "assistant" &&
            textOf(record.content).includes("CONVERSATION_LIVE_COMPLETE"),
        ),
      "live history persisted",
    );
    assertPersistedHistory(history, manifest);
    assert.deepEqual(
      assertPersistedTools(history.records, manifest),
      toolEvidence.outputs,
      "Persist every exact real HTTP tool result without synthetic explanations",
    );
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          runId,
          runRoot: runtime.runRoot,
          launcherPid: runtime.launcherPid,
          electronPid: runtime.electronPid,
          taskId,
          history,
          toolEvidence,
        },
        null,
        2,
      ),
    );
  } else {
    await recoverConversationEvidence({
      page,
      runtime,
      manifest,
      receiptPath,
      runId,
      screenshot,
      notRevived,
    });
  }
  await screenshot("complete");
  await isolation();
  assert.deepEqual(problems, [], "Conversation GUI must have no unhandled runtime or React errors");
  const stderr = await readFile(join(runtime.runRoot, "electron-stderr.log"), "utf8");
  assert.doesNotMatch(stderr, /omp_core_frame_decode_failed/u);
  await writeFile(
    join(evidence, `conversation-${phase}-http-${runId}.json`),
    JSON.stringify(await diagnostics(runtime), null, 2),
  );
} finally {
  try {
    await writeFile(
      join(evidence, `conversation-${phase}-renderer-log-${runId}.json`),
      JSON.stringify(rendererLogs, null, 2),
    );
  } finally {
    await browser.close();
  }
}
