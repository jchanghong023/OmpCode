import assert from "node:assert/strict";

const settledRender = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function insertFileMention(page, input, label, prefix = "") {
  const mentionId = `file:${label}`;
  // 同 scope 的另一 pane 也有候选投影；只操作实际编辑 pane 的 picker。
  const pane = input.locator(
    "xpath=ancestor::*[@data-testid='draft-hook-left' or @data-testid='draft-hook-right'][1]",
  );
  const panel = pane.getByTestId("prompt-suggestion-panel");
  await input.fill(prefix);
  await input.press("End");
  await input.pressSequentially(`@${label}`, { delay: 1 });
  await panel.waitFor({ state: "visible" });
  const option = pane
    .locator('[data-testid^="prompt-suggestion-option-"]')
    .filter({ hasText: label })
    .first();
  await option.waitFor({ state: "visible" });
  // 组件夹具纵向排列多组输入区；使用真实 picker 的键盘选择，不强制点击屏外 portal。
  assert.equal(await option.getAttribute("aria-selected"), "true");
  await settledRender(page);
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    "Restoring the sibling draft must not steal focus from the editing pane",
  );
  await input.press("Enter");
  await input.locator(`[data-mention-id="${mentionId}"]`).waitFor({ state: "visible" });
  await panel.waitFor({ state: "hidden" });
  // MentionPlugin 的选中动作在下一帧恢复 editor 焦点；先完成该动作，再开始下一次输入。
  await settledRender(page);
  const text = await input.evaluate((element) => element.__zcodeLexicalInputE2E.getText());
  return { mentionId, text };
}

export async function runDraftHookAssertions(page, evidence) {
  await page.evaluate(() =>
    window.performanceFixture.render({
      mode: "draft-hooks",
      hookScope: "hook-a",
      secondPane: false,
      migrationEvents: true,
    }),
  );
  const left = page.getByTestId("draft-hook-left").getByTestId("v4-composer-input");
  const right = page.getByTestId("draft-hook-right").getByTestId("v4-composer-input");
  await left.waitFor({ state: "visible" });
  await settledRender(page);
  await page.evaluate(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const stringify = JSON.stringify;
    window.draftHookTelemetry = {
      reads: 0,
      writes: 0,
      editorStateSerializations: 0,
      restore: () => {
        Storage.prototype.getItem = get;
        Storage.prototype.setItem = set;
        JSON.stringify = stringify;
      },
    };
    Storage.prototype.getItem = function (key) {
      if (key.startsWith("zcode-v4-composer-drafts:v1:component-draft-hooks"))
        window.draftHookTelemetry.reads++;
      return Reflect.apply(get, this, [key]);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("zcode-v4-composer-drafts:v1:component-draft-hooks"))
        window.draftHookTelemetry.writes++;
      return Reflect.apply(set, this, [key, value]);
    };
    JSON.stringify = function (value, ...args) {
      if (value && typeof value === "object" && Array.isArray(value.root?.children))
        window.draftHookTelemetry.editorStateSerializations++;
      return Reflect.apply(stringify, this, [value, ...args]);
    };
  });
  const typedText = "逐键JSON检查".repeat(8);
  await left.fill("");
  await page.evaluate(() => {
    window.draftHookTelemetry.editorStateSerializations = 0;
  });
  await left.pressSequentially(typedText, { delay: 1 });
  await page.waitForTimeout(450);
  const editorStateSerializations = await page.evaluate(
    () => window.draftHookTelemetry.editorStateSerializations,
  );
  assert.ok(
    editorStateSerializations < typedText.length,
    `EditorState was serialized ${editorStateSerializations} times for ${typedText.length} typed characters`,
  );
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  await page.evaluate(() => {
    window.draftHookTelemetry.reads = 0;
    window.draftHookTelemetry.writes = 0;
  });
  const unsaved = "未flush共享草稿最新全文";
  await left.fill(unsaved);
  assert.equal((await page.evaluate(() => window.draftHookFixture.read("left"))).text, unsaved);
  await page.evaluate(() => window.performanceFixture.render({ secondPane: true }));
  const mountCounts = await page.evaluate(() => ({
    reads: window.draftHookTelemetry.reads,
    writes: window.draftHookTelemetry.writes,
  }));
  assert.deepEqual(
    mountCounts,
    { reads: 0, writes: 0 },
    "A second same-scope hook must use shared unflushed memory without Storage IO",
  );
  await page.waitForFunction(
    (text) =>
      document
        .querySelector('[data-testid="draft-hook-right"] [data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === text,
    unsaved,
  );
  await page.evaluate(() => window.performanceFixture.render({ secondPane: false }));
  await settledRender(page);
  const plainPrefix = "交接正文 ";
  // 旧普通文本与新 mention 使用同一真实 picker 的 Markdown，不固定序列化器的路径拼写。
  const { mentionId: seedRichId, text: plainMarkdown } = await insertFileMention(
    page,
    left,
    "共享文件.ts",
    plainPrefix,
  );
  await left.fill(plainMarkdown);
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  const plainDraft = await page.evaluate(() => window.draftHookFixture.read("left"));
  assert.equal(plainDraft.text, plainMarkdown);
  assert.equal(plainDraft.editorStateJson.includes(seedRichId), false);
  const { mentionId: richId, text: richMarkdown } = await insertFileMention(
    page,
    left,
    "共享文件.ts",
    plainPrefix,
  );
  assert.equal(richMarkdown, plainMarkdown);
  await page.evaluate(() => window.performanceFixture.render({ secondPane: true }));
  await right.waitFor({ state: "visible" });
  await right.locator(`[data-mention-id="${richId}"]`).waitFor({ state: "visible" });
  assert.equal(
    await right.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    richMarkdown,
  );
  const handoffDraft = await page.evaluate(() => window.draftHookFixture.read("left"));
  assert.equal(handoffDraft.text, richMarkdown);
  assert.ok(
    handoffDraft.editorStateJson.includes(richId),
    "After the receiving pane restores the current mention, the shared owner must materialize its Lexical structure",
  );
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  assert.ok(
    (await page.evaluate(() => window.draftHookFixture.read("left"))).editorStateJson.includes(
      richId,
    ),
    "The rich handoff must survive persistence flush",
  );
  await right.fill("另一pane最新编辑");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="draft-hook-left"] [data-testid="v4-composer-input"]')
        ?.__zcodeLexicalInputE2E?.getText() === "另一pane最新编辑",
  );
  await page.evaluate(() => window.performanceFixture.render({ secondPane: false }));
  await settledRender(page);
  assert.equal(
    (await page.evaluate(() => window.draftHookFixture.read("left"))).text,
    "另一pane最新编辑",
    "Unmounting a sibling must not overwrite newer shared content",
  );
  await page.evaluate(() => window.draftHookTelemetry.restore());

  for (const result of ["blocked", "throw"]) {
    const source = `来源A完整失败草稿-${result}`;
    await left.fill(source);
    await page.getByTestId("draft-hook-left").getByTestId("v4-composer-send").click();
    await page.waitForFunction(() => window.draftHookFixture.pending().length === 1);
    await page.evaluate(() => window.performanceFixture.render({ hookScope: "hook-b" }));
    await settledRender(page);
    await left.fill(`B独立编辑-${result}`);
    await page.evaluate((value) => window.draftHookFixture.respond(value), result);
    await settledRender(page);
    assert.equal(
      await left.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
      `B独立编辑-${result}`,
    );
    await page.evaluate(() => window.performanceFixture.render({ hookScope: "hook-a" }));
    await page.waitForFunction(
      (text) =>
        document
          .querySelector('[data-testid="draft-hook-left"] [data-testid="v4-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText() === text,
      source,
    );
    assert.equal((await page.evaluate(() => window.draftHookFixture.read("left"))).text, source);
  }
  await left.fill("旧提交来源A");
  await page.getByTestId("draft-hook-left").getByTestId("v4-composer-send").click();
  await page.waitForFunction(() => window.draftHookFixture.pending().length === 1);
  await page.evaluate(() => window.performanceFixture.render({ hookScope: "hook-b" }));
  await settledRender(page);
  await page.evaluate(() => window.performanceFixture.render({ hookScope: "hook-a" }));
  await settledRender(page);
  await left.fill("返回A后的新编辑");
  await page.evaluate(() => window.draftHookFixture.respond("throw"));
  await settledRender(page);
  assert.equal(
    await left.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
    "返回A后的新编辑",
    "An old failed receipt must not overwrite newer A edits after returning",
  );
  assert.equal(
    (await page.evaluate(() => window.draftHookFixture.read("left"))).text,
    "返回A后的新编辑",
  );

  const sharedPendingEvidence = [];
  for (const result of ["sent", "throw"]) {
    const scope = `same-scope-pending-${result}`;
    const submittedLabel = `submitted-${result}.ts`;
    const submittedPrefix = `发送来源-${result} `;
    const submittedMention = `file:${submittedLabel}`;
    const submittedAttachment = `submitted-${result}`;
    const newerLabel = `newer-${result}.ts`;
    const newerPrefix = `另一pane等待回包期间编辑-${result} `;
    const newerMention = `file:${newerLabel}`;
    const newerAttachment = `newer-${result}`;
    await page.evaluate(
      (hookScope) =>
        window.performanceFixture.render({
          hookScope,
          secondPane: true,
          rightHookScope: hookScope,
        }),
      scope,
    );
    await left.waitFor({ state: "visible" });
    await right.waitFor({ state: "visible" });
    await settledRender(page);
    const { text: submittedText } = await insertFileMention(
      page,
      left,
      submittedLabel,
      submittedPrefix,
    );
    await page.evaluate(
      ({ target, id }) => {
        window.draftHookFixture.addAttachment(target, id);
        window.draftHookFixture.flush("left");
      },
      { target: scope, id: submittedAttachment },
    );
    const submittedDraft = await page.evaluate(() => window.draftHookFixture.read("left"));
    assert.equal(submittedDraft.text, submittedText);
    assert.ok(
      submittedDraft.editorStateJson.includes(submittedMention),
      "The genuine Lexical file mention must be materialized before the submission receipt is captured",
    );
    await page.getByTestId("draft-hook-left").getByTestId("v4-composer-send").click();
    await page.waitForFunction(() => window.draftHookFixture.pending().length === 1);
    const pendingAtSubmit = await page.evaluate(() => window.draftHookFixture.pending());
    assert.deepEqual(
      pendingAtSubmit.map(({ paneId, scope, attachmentRefs }) => ({
        paneId,
        scope,
        attachmentRefs,
      })),
      [
        {
          paneId: "left",
          scope,
          attachmentRefs: [`fixture://${submittedAttachment}`],
        },
      ],
    );
    const { text: newerText } = await insertFileMention(page, right, newerLabel, newerPrefix);
    await page.evaluate(({ target, id }) => window.draftHookFixture.addAttachment(target, id), {
      target: scope,
      id: newerAttachment,
    });
    await page.waitForFunction(
      (text) =>
        document
          .querySelector('[data-testid="draft-hook-left"] [data-testid="v4-composer-input"]')
          ?.__zcodeLexicalInputE2E?.getText() === text,
      newerText,
    );
    assert.equal(
      (await page.evaluate(() => window.draftHookFixture.pending())).length,
      1,
      "Editing the sibling pane must not replace or settle the in-flight submission",
    );
    await page.evaluate((value) => window.draftHookFixture.respond(value), result);
    await page.waitForFunction(
      (expected) =>
        window.draftHookFixture.pending().length === 0 &&
        window.draftHookFixture.read("left").text === expected,
      newerText,
    );
    await settledRender(page);
    const current = await page.evaluate(() => window.draftHookFixture.read("right"));
    assert.equal(current.text, newerText);
    assert.ok(current.editorStateJson.includes(newerMention));
    assert.equal(
      await left.evaluate((element) => element.__zcodeLexicalInputE2E.getText()),
      newerText,
    );
    await right.locator(`[data-mention-id="${newerMention}"]`).waitFor({ state: "visible" });
    await left.locator(`[data-mention-id="${newerMention}"]`).waitFor({ state: "visible" });
    const attachments = await page.evaluate(
      (target) => window.draftHookFixture.attachments(target).map((item) => item.id),
      scope,
    );
    assert.deepEqual(
      attachments,
      result === "sent" ? [newerAttachment] : [submittedAttachment, newerAttachment],
      result === "sent"
        ? "Success consumes only the submitted attachment and keeps the sibling's later attachment"
        : "Failure keeps both the submitted and sibling's later attachments",
    );
    sharedPendingEvidence.push({
      result,
      submittedAttachment,
      newerAttachment,
      latestTextPreserved: true,
      latestLexicalMentionPreserved: true,
      pendingSubmissionRemainedOwnedByLeft: true,
      attachments,
    });
  }

  evidence.push({
    event: "actual-draft-hook-shared-owner-and-source-rollback",
    hook: "useDraftConfigControl",
    secondPaneUnflushedReads: 0,
    secondPaneUnflushedWrites: 0,
    editorStateSerializations,
    serializedEditorStateFewerThanTypedCharacters: true,
    richJsonHandoffAcrossPanes: true,
    siblingContentSynchronized: true,
    sourceBlockedAndThrowRestored: true,
    newBAndNewAEditsPreserved: true,
    pendingSuccessAndFailurePreserveSiblingEdits: sharedPendingEvidence,
    transportBoundary: "controlled-port",
  });
}
