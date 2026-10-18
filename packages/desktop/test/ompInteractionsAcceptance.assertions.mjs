import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureIsolationScreenshot } from "./ompCore.evidence.cjs";
import { reveal, readMockRequests } from "./ompMockInteractions.assertions.mjs";
import { advertisedAskEvidence } from "./ompInteractionsAcceptance.records.mjs";
import {
  LIVE_CASES,
  QUESTION,
  UI_TOOL,
  askTimeout,
  callIdFor,
  hash,
  markerFor,
  probeResult,
  probeSpec,
  promptFor,
  richAnswers,
} from "./ompInteractionsAcceptance.contract.mjs";

const cardOf = (page) => page.locator('[data-elicitation-dialog-card="true"]');
const cancelOf = (dialog) => dialog.getByRole("button", { name: /^(?:取消|Cancel)$/u });
const submitOf = (dialog) =>
  dialog.getByRole("button", { name: /^(?:提交|确认|Submit|Confirm)$/u });
const nextOf = (dialog) => dialog.getByRole("button", { name: /^(?:继续|Continue)$/u });
// 描述与标签是相邻 span，非推荐项的 accessible name 不保证在标签后插入空格。
const optionOf = (card, label, role = "option") =>
  card.getByRole(role).filter({ has: card.page().getByText(label, { exact: true }) });

export async function submitInteraction(page, name, nonce) {
  await page.getByTestId("v4-composer-input").fill(promptFor(name, nonce));
  await page.getByTestId("v4-composer-send").click();
}

export async function completeInteraction(page, name, nonce, timeout = 60_000) {
  await page
    .getByText(markerFor(name, nonce), { exact: true })
    .waitFor({ state: "visible", timeout });
  await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
  await page.getByTestId("v4-stop").waitFor({ state: "hidden" });
}

async function selectQuestion(page, nonce, index) {
  const card = cardOf(page);
  const key = index === 0 ? "primary" : "secondary";
  await card.getByText(`${key} database`, { exact: true }).waitFor({ state: "visible" });
  const list = card.getByRole("group", { name: QUESTION, exact: true });
  assert.equal(
    await list.count(),
    1,
    "Identical question labels must remain a single current question, not a merged answer key",
  );
  const recommended = optionOf(list, index === 0 ? "Postgres" : "SQLite", "checkbox");
  await recommended.getByText(/^(?:推荐|Recommended)$/u).waitFor({ state: "visible" });
  const postgres = optionOf(list, "Postgres", "checkbox");
  await postgres.hover();
  await page
    .getByRole("tooltip")
    .getByText(`SELECT '${key}-${nonce}';`, { exact: true })
    .waitFor({ state: "visible" });
  if (index === 0) await postgres.click();
  await optionOf(list, "SQLite", "checkbox").click();
  assert.equal(await optionOf(list, "SQLite", "checkbox").getAttribute("aria-checked"), "true");
  if (index === 0)
    assert.equal(
      await postgres.getAttribute("aria-checked"),
      "true",
      "Multi-select must preserve the earlier choice",
    );
  const custom = card.getByRole("textbox");
  await custom.fill(richAnswers(nonce)[index].customInput);
  assert.equal(await custom.inputValue(), richAnswers(nonce)[index].customInput);
  assert.equal(
    await list
      .getByRole("checkbox")
      .filter({ has: page.getByRole("textbox") })
      .getAttribute("aria-checked"),
    "true",
    "Custom input must coexist with the selected multi-select options",
  );
}

async function waitForAskSurface(page, runtime, name, title) {
  const card = cardOf(page);
  const role = name === "ask-timeout" ? "listbox" : "group";
  try {
    await card.getByRole(role, { name: title, exact: true }).waitFor({ state: "visible" });
  } catch (error) {
    // 没有题卡也可能是模型请求先失败，不能把 locator 超时直接归因于单/多选 role。
    // 只保留字段计数和数字题号；不输出 DOM、问题/答案、自定义输入或 HTTP 正文。
    const evidence = { case: name, expectedRole: role };
    try {
      evidence.surface = await card.evaluateAll(
        (cards, expectedTitle) =>
          cards.map((node) => ({
            visible: node.getClientRects().length > 0,
            groupCount: node.querySelectorAll('[role="group"]').length,
            listboxCount: node.querySelectorAll('[role="listbox"]').length,
            checkboxCount: node.querySelectorAll('[role="checkbox"]').length,
            optionCount: node.querySelectorAll('[role="option"]').length,
            textInputCount: node.querySelectorAll("textarea, input").length,
            titleMatchCount: [...node.querySelectorAll('[role="group"], [role="listbox"]')].filter(
              (item) => item.getAttribute("aria-label") === expectedTitle,
            ).length,
            questionPositions: [
              ...new Set(
                [...node.querySelectorAll("span")]
                  .map((item) => item.textContent?.trim())
                  .filter((text) => /^\d+ \/ \d+$/u.test(text ?? "")),
              ),
            ],
          })),
        title,
      );
      const diagnostics = await readMockRequests(runtime);
      evidence.model = {
        requestCount: diagnostics.calls.length,
        issuedAskCount: diagnostics.acceptance.issued.filter((item) => item.name === name).length,
        verifiedAskCount: diagnostics.acceptance.verified.filter((item) => item.name === name)
          .length,
      };
    } catch (diagnosticError) {
      evidence.diagnosticErrorType = diagnosticError?.name ?? typeof diagnosticError;
    }
    const directory = process.env.OMP_E2E_EVIDENCE_DIR;
    if (directory) {
      try {
        await captureIsolationScreenshot(join(directory, `${name}-surface-failure.png`));
        evidence.screenshotCaptured = true;
      } catch (captureError) {
        evidence.screenshotCaptured = false;
        evidence.captureErrorType = captureError?.name ?? typeof captureError;
      }
      try {
        await writeFile(
          join(directory, `${name}-surface-failure.json`),
          JSON.stringify(evidence, null, 2),
        );
      } catch (writeError) {
        evidence.writeErrorType = writeError?.name ?? typeof writeError;
      }
    }
    console.error("ASK_SURFACE_FAILURE", JSON.stringify(evidence));
    throw error;
  }
}

export async function exerciseAsk(page, runtime, name) {
  const nonce = runtime.acceptance.nonce;
  await submitInteraction(page, name, nonce);
  const card = cardOf(page);
  const title = name === "ask-timeout" ? `Timeout recommendation ${nonce}` : QUESTION;
  await waitForAskSurface(page, runtime, name, title);
  const visibleAt = Date.now();
  if (name === "ask-rich") {
    await selectQuestion(page, nonce, 0);
    await nextOf(card).click();
    // 两题文字相同：第二题不得继承第一题的已选项或自定义草稿。
    const list = card.getByRole("group", { name: QUESTION, exact: true });
    assert.equal(
      await optionOf(list, "Postgres", "checkbox").getAttribute("aria-checked"),
      "false",
    );
    assert.equal(await optionOf(list, "SQLite", "checkbox").getAttribute("aria-checked"), "false");
    assert.equal(await card.getByRole("textbox").inputValue(), "");
    await selectQuestion(page, nonce, 1);
    await submitOf(card).click();
  } else if (name === "ask-cancel") {
    await selectQuestion(page, nonce, 0);
    await nextOf(card).click();
    await card.getByRole("button", { name: /^(?:忽略|Dismiss)$/u }).click();
    // 真实 OMP rich ask 取消会 context.abort() 终止整轮，不再向模型请求完成 marker。
    // 以题卡清场、运行结束及本次精确工具身份的取消结果证明，不伪造后续助手回答。
    await card.waitFor({ state: "hidden" });
    await page.getByTestId("v4-stop").waitFor({ state: "hidden" });
    await page.getByTestId("v4-composer-send").waitFor({ state: "visible" });
    const block = page.locator(`[data-tool-call-id="${callIdFor(name, nonce)}"]`);
    await reveal(page, block);
    assert.equal(await block.count(), 1);
    assert.ok(
      ["cancelled", "error", "failed"].includes(await block.getAttribute("data-status")),
      "Cancelling the real ask must terminate its tool, not report successful answers",
    );
    assert.equal(await page.getByText(markerFor(name, nonce), { exact: true }).count(), 0);
    return;
  } else {
    assert.equal(name, "ask-timeout");
    const recommended = optionOf(card, "SQLite");
    await recommended.getByText(/^(?:推荐|Recommended)$/u).waitFor({ state: "visible" });
    // 不点击答案、继续或确认；只有 OMP 自己的 deadline 能提交推荐项并清场。
    assert.equal(await recommended.getAttribute("aria-selected"), "false");
    const diagnostics = await readMockRequests(runtime);
    const advertised = advertisedAskEvidence(diagnostics, name, nonce);
    const timeout = askTimeout(advertised.schema);
    const issued = diagnostics.acceptance.issued.filter((item) => item.name === name);
    assert.equal(issued.length, 1);
    assert.deepEqual(
      issued[0].timeout,
      timeout,
      "Use only the actual HTTP parameter contract, or the unmodified core default",
    );
    const intentIssuedAt = issued[0].intentIssuedAt;
    assert.ok(Number.isFinite(intentIssuedAt) && intentIssuedAt <= visibleAt);
    // 未暴露参数时等真实 core 默认 deadline，timeout:0 仅禁用 Playwright 本地截止；外层 gate 仍持有硬限。
    // 参数可调时，core 计时起点介于工具意图与 GUI 可见之间；测试端永不提交推荐答案。
    await card.waitFor({ state: "hidden", timeout: timeout ? timeout.milliseconds + 15_000 : 0 });
    const hiddenAt = Date.now();
    if (timeout) {
      assert.ok(
        hiddenAt >= intentIssuedAt + timeout.milliseconds - 250,
        "An immediate auto-answer must not masquerade as expiration of the advertised core deadline",
      );
      assert.ok(
        hiddenAt <= visibleAt + timeout.milliseconds + 15_000,
        "The actual core deadline must resolve within the advertised duration plus delivery allowance",
      );
    }
    await completeInteraction(page, name, nonce, timeout ? 15_000 : 0);
    return {
      source: timeout ? "parameter" : "core-default",
      ...timeout,
      intentIssuedAt,
      visibleAt,
      hiddenAt,
    };
  }
  await completeInteraction(page, name, nonce);
  await card.waitFor({ state: "hidden" });
}

export async function exerciseExtension(page, runtime, name) {
  const spec = probeSpec(name, runtime.acceptance.nonce);
  await submitInteraction(page, name, runtime.acceptance.nonce);
  // input/editor 的真实入口是 V4UserInputDialog 的既有容器，不带 dialog role；
  // 保留标题精确匹配，不能为测试假设更改产品 role 或仅凭任意输入框继续执行。
  const dialog = page
    .getByTestId("v4-user-input-dialog")
    .filter({ has: page.getByText(spec.title, { exact: true }) });
  await dialog.waitFor({ state: "visible" });
  // editor 是多行临时编辑器（textarea，含完整 prefill）；input 是单行文本输入框。
  const input = spec.editor ? dialog.locator("textarea") : dialog.locator('input[type="text"]');
  assert.equal(await input.count(), 1);
  const initialValue = await input.inputValue();
  assert.equal(
    hash(initialValue),
    hash(spec.prefill ?? ""),
    "The real extension UI must expose the complete prefill, including trailing newline/whitespace",
  );
  if (!name.startsWith("editor-empty-")) await input.fill(spec.value);
  // 无 prefill 的两个空白分支保持从未编辑；空白取消不能靠先写入内容再取消冒充。
  assert.equal(
    hash(await input.inputValue()),
    hash(spec.value),
    "Input editing must preserve the exact bytes without exposing secrets in assertion errors",
  );
  await dialog.getByText(spec.title, { exact: true }).click();
  if (spec.cancelled) await cancelOf(dialog).click();
  else await submitOf(dialog).click();
  await dialog.waitFor({ state: "hidden" });
  await completeInteraction(page, name, runtime.acceptance.nonce);
}

export async function assertInteractionTools(page, nonce) {
  for (const name of LIVE_CASES) {
    const id = callIdFor(name, nonce);
    const block = page.locator(`[data-tool-call-id="${id}"]`);
    await reveal(page, block);
    assert.equal(await block.count(), 1, `One visible real tool identity for ${name}`);
    assert.equal(
      await block.getAttribute("data-tool-name"),
      name.startsWith("ask-") ? "ask" : UI_TOOL,
    );
    const summary = block.getByTestId(`tool-summary-trigger-${id}`);
    if ((await summary.getAttribute("aria-expanded")) === "false") await summary.click();
    if (name === "ask-cancel") {
      assert.ok(
        ["cancelled", "error", "failed"].includes(await block.getAttribute("data-status")),
        "Whole ask cancellation must not render as ordinary successful answers",
      );
      for (const answer of richAnswers(nonce))
        assert.equal((await block.innerText()).includes(answer.customInput), false);
    } else {
      assert.equal(await block.getAttribute("data-status"), "completed");
      if (name === "ask-rich") {
        const expected = richAnswers(nonce).map((answer) =>
          [...answer.selectedOptions, answer.customInput].join("，"),
        );
        const actual = [];
        for (const value of expected) {
          const displayed = block.getByText(value, { exact: true });
          assert.equal(
            await displayed.count(),
            1,
            "Repeated question text must not collapse or duplicate either answer",
          );
          actual.push(await displayed.innerText());
        }
        assert.deepEqual(actual, expected);
        const first = block.getByText(expected[0], { exact: true });
        const second = block.getByText(expected[1], { exact: true });
        assert.equal(
          await first.evaluate((node, selector) => {
            const other = [...node.closest("[data-tool-call-id]").querySelectorAll("*")].find(
              (candidate) => candidate.textContent === selector,
            );
            return Boolean(
              other && node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }, expected[1]),
          true,
          "Recovered answer presentation must retain question order",
        );
        await second.waitFor({ state: "visible" });
      } else if (name === "ask-timeout") {
        await block.getByText("SQLite", { exact: true }).waitFor({ state: "visible" });
      } else {
        const expected = probeResult(probeSpec(name, nonce));
        // 工具结果正文由 CodeViewer(@pierre/diffs)渲染在 Shadow DOM 内：light DOM 的
        // innerText/textContent 都读不到，改用会穿透开放 shadow root 的文本定位器。
        const shown = expected.cancelled
          ? block.getByText(/"cancelled"\s*:\s*true/u)
          : block.getByText(expected.sha256);
        assert.equal(
          await shown.count(),
          1,
          "The GUI tool must expose the actual exact-return result text",
        );
      }
    }
  }
}
