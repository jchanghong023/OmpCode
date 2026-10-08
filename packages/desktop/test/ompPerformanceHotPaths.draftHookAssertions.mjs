import assert from "node:assert/strict";

const settledRender = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
export async function runDraftHookAssertions(page, evidence) {
  await page.evaluate(() =>
    window.performanceFixture.render({
      mode: "draft-hooks",
      hookScope: "hook-a",
      secondPane: false,
    }),
  );
  const left = page.getByTestId("draft-hook-left").getByTestId("v4-composer-input");
  const right = page.getByTestId("draft-hook-right").getByTestId("v4-composer-input");
  await left.waitFor({ state: "visible" });
  await settledRender(page);
  await page.evaluate(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    window.draftHookTelemetry = {
      reads: 0,
      writes: 0,
      restore: () => {
        Storage.prototype.getItem = get;
        Storage.prototype.setItem = set;
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
  evidence.push({
    event: "actual-draft-hook-shared-owner-and-source-rollback",
    hook: "useDraftConfigControl",
    secondPaneUnflushedReads: 0,
    secondPaneUnflushedWrites: 0,
    siblingContentSynchronized: true,
    sourceBlockedAndThrowRestored: true,
    newBAndNewAEditsPreserved: true,
    transportBoundary: "controlled-port",
  });
}
