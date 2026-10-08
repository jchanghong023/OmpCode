import assert from "node:assert/strict";
import { join } from "node:path";

// 同步root.render之后等待真实React/Lexical提交帧；不改变产品的scope或回复时序。
const settledRender = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

export async function runComposerAssertions(page, evidenceDir, evidence) {
  await page.evaluate(() => window.performanceFixture.render({ mode: "composer" }));
  const composerInput = page.getByTestId("v4-composer-input");
  await composerInput.waitFor({ state: "visible" });
  for (const result of ["blocked", "throw"]) {
    const original = `完整失败恢复草稿-${result}`;
    await composerInput.fill(original);
    await composerInput.press("Control+Enter");
    await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
    const request = await page.evaluate(() => window.performanceFixture.composer().pending[0]);
    assert.equal(request.text, original);
    assert.equal(request.options.requestedDelivery, "startNow");
    await page.evaluate((value) => window.performanceFixture.respond(value), result);
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-testid="v4-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText() === expected,
      original,
    );
    assert.equal(await composerInput.innerText(), original);
  }
  const richMarkdown = "[fixture.ts](fixture.ts) ";
  await composerInput.fill(richMarkdown);
  await composerInput.evaluate((element) => {
    const bridge = element.__zcodeLexicalInputE2E;
    const json = bridge.getEditorState().toJSON();
    json.root.children[0].children = [
      {
        type: "prompt-mention",
        version: 1,
        text: "fixture.ts",
        format: 0,
        detail: 0,
        mode: "token",
        style: "",
        mentionId: "file:fixture.ts",
        category: "files",
        value: "fixture.ts",
        markdown: "[fixture.ts](fixture.ts)",
        data: { kind: "file", relativePath: "fixture.ts" },
      },
      { type: "text", version: 1, text: " ", format: 0, detail: 0, mode: "normal", style: "" },
    ];
    bridge.setEditorStateJson(JSON.stringify(json));
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.querySelectorAll("[data-mention-id]").length === 1,
  );
  await page.evaluate(() => window.performanceFixture.flush());
  await page.getByTestId("v4-composer-send").click();
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
  await composerInput.press("Control+A");
  await composerInput.press("Control+C");
  await composerInput.press("Control+V");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.querySelectorAll("[data-mention-id]").length === 0,
  );
  assert.equal(
    await composerInput.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    richMarkdown,
  );
  await page.evaluate(() => window.performanceFixture.respond("sent"));
  await page.waitForFunction(
    (expected) => window.performanceFixture.composer().owner.text === expected,
    richMarkdown,
  );
  await page.evaluate(() => window.performanceFixture.flush());
  const savedOwner = await page.evaluate(() => window.performanceFixture.composer().owner);
  assert.equal(savedOwner.text, richMarkdown);
  assert.equal(
    savedOwner.editorStateJson.includes("prompt-mention"),
    false,
    "Pending success must persist the latest same-Markdown rich edit",
  );
  await page.evaluate(() => window.performanceFixture.render({ composerScope: "b" }));
  await settledRender(page);
  await page.evaluate(() => window.performanceFixture.render({ composerScope: "a" }));
  await settledRender(page);
  await settledRender(page);
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === expected,
    richMarkdown,
  );
  assert.equal(await composerInput.locator("[data-mention-id]").count(), 0);
  await page.getByTestId("v4-composer-send").click();
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
  await page.evaluate(
    (text) =>
      window.performanceFixture.render({
        externalTextInsertRequest: {
          requestId: 101,
          text,
          mention: {
            id: "file:replacement-fixture.ts",
            category: "files",
            label: "fixture.ts",
            value: "fixture.ts",
            markdown: "[fixture.ts](fixture.ts)",
            data: { kind: "file", relativePath: "fixture.ts" },
          },
        },
      }),
    richMarkdown,
  );
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="v4-composer-input"]')
      ?.querySelector('[data-mention-id="file:replacement-fixture.ts"]'),
  );
  await page.evaluate(() => window.performanceFixture.respond("sent"));
  await page.waitForFunction(() =>
    window.performanceFixture
      .composer()
      .owner.editorStateJson?.includes("file:replacement-fixture.ts"),
  );
  assert.equal(
    await composerInput.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    richMarkdown,
  );
  await page.evaluate(() => window.performanceFixture.render({ externalTextInsertRequest: null }));
  await composerInput.fill("旧scope失败正文");
  await composerInput.press("Control+Enter");
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
  await page.evaluate(() => window.performanceFixture.render({ composerScope: "b" }));
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === "",
  );
  await page.evaluate(() => window.performanceFixture.respond("throw"));
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 0);
  await page.waitForTimeout(60);
  assert.equal(
    await composerInput.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    "",
    "Old scope failure cannot restore its submitted text into the new empty scope",
  );
  assert.equal((await page.evaluate(() => window.performanceFixture.composer().owner)).text, "");
  const sameTextAcrossScopes = "新scope同文草稿";
  await page.evaluate(() => window.performanceFixture.render({ composerScope: "a" }));
  await settledRender(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === window.performanceFixture.composer().owner.text,
  );
  await composerInput.fill(sameTextAcrossScopes);
  await page.getByTestId("v4-composer-send").click();
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
  await page.evaluate(() => window.performanceFixture.render({ composerScope: "b" }));
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === "",
  );
  await composerInput.fill(sameTextAcrossScopes);
  await page.evaluate(() => window.performanceFixture.respond("sent"));
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 0);
  await page.waitForTimeout(60);
  assert.equal(
    await composerInput.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    sameTextAcrossScopes,
    "Old accepted reply cannot clear a new scope containing the same text",
  );
  assert.equal(
    (await page.evaluate(() => window.performanceFixture.composer().owner)).text,
    sameTextAcrossScopes,
  );
  await page.evaluate(() => {
    window.performanceFixture.render({ composerScope: "attachment-a" });
    window.performanceFixture.addAttachment("attachment-a", "a-submitted");
  });
  await settledRender(page);
  await composerInput.fill("附件旧scope成功回包");
  await page.getByTestId("v4-composer-send").click();
  await page.waitForFunction(() => window.performanceFixture.composer().pending.length === 1);
  assert.equal(
    (await page.evaluate(() => window.performanceFixture.composer().pending[0])).options
      .attachments[0].ref,
    "fixture://a-submitted",
  );
  await page.evaluate(() => {
    window.performanceFixture.addAttachment("attachment-a", "a-new");
    window.performanceFixture.addAttachment("attachment-b", "b-preserved", "B附件错误保留");
    window.performanceFixture.render({ composerScope: "attachment-b" });
  });
  await settledRender(page);
  await page.evaluate(() => window.performanceFixture.respond("sent"));
  await page.waitForFunction(
    () =>
      !window.performanceFixture
        .attachments("attachment-a")
        .some((item) => item.id === "a-submitted"),
  );
  assert.deepEqual(
    (await page.evaluate(() => window.performanceFixture.attachments("attachment-a"))).map(
      (item) => item.id,
    ),
    ["a-new"],
  );
  const attachmentB = await page.evaluate(() =>
    window.performanceFixture.attachments("attachment-b"),
  );
  assert.equal(attachmentB[0].id, "b-preserved");
  assert.equal(attachmentB[0].uploadError, "B附件错误保留");
  evidence.push({
    event: "composer-send-failure-and-pending-rich-edit",
    startNowBlockedAndThrowRestored: true,
    pendingRichEditPreserved: true,
    ownerJsonLatest: true,
    externalSameMarkdownMentionPreserved: true,
    staleScopeReplyIsolated: true,
    frozenAttachmentsConsumed: true,
    newerAndOtherScopeAttachmentsPreserved: true,
    transportBoundary: "controlled-port",
  });
  await page.screenshot({
    path: join(evidenceDir, "components-composer-restored.png"),
    animations: "disabled",
  });
}
