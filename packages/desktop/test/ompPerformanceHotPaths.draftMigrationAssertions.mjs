import assert from "node:assert/strict";

const settledRender = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

const eventForMigration = (workspacePath, fromTaskId, toTaskId) => ({
  type: "workspace_task_list_changed",
  workspacePath,
  taskId: toTaskId,
  reason: "realtime_sync",
  taskIdMigration: { fromTaskId, toTaskId },
});

export async function runDraftMigrationAssertions(page, evidence) {
  const left = page.getByTestId("draft-hook-left").getByTestId("v4-composer-input");
  const right = page.getByTestId("draft-hook-right").getByTestId("v4-composer-input");
  const eventSource = "tmp-window-event";
  const eventTarget = "11111111-1111-4111-8111-111111111111";
  await page.evaluate(
    ({ hookScope, rightHookScope }) =>
      window.performanceFixture.render({
        hookScope,
        rightHookScope,
        secondPane: true,
        migrationEvents: true,
      }),
    { hookScope: eventSource, rightHookScope: eventTarget },
  );
  await left.waitFor({ state: "visible" });
  await right.waitFor({ state: "visible" });
  await settledRender(page);
  await left.fill("配置迁移来源正文");
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  await page.evaluate(() => {
    window.draftHookFixture.selectModel("left", "source-provider", "source-model");
    window.draftHookFixture.selectModel("right", "target-provider", "target-model");
    window.draftHookFixture.selectThought("right", "medium");
  });
  const beforeEvent = await page.evaluate(() => ({
    source: window.draftHookFixture.read("left"),
    target: window.draftHookFixture.read("right"),
    subscriptions: window.draftHookFixture.migrationSubscriptionCount(),
  }));
  assert.equal(beforeEvent.source.text, "配置迁移来源正文");
  assert.equal(beforeEvent.target.text, "");
  assert.equal(beforeEvent.subscriptions, 1);
  assert.equal(beforeEvent.target.ompModelEdited, true);
  assert.equal(beforeEvent.target.ompThoughtEdited, true);
  const migrationEvent = eventForMigration("component-draft-hooks", eventSource, eventTarget);
  assert.equal(
    await page.evaluate(
      (event) => window.draftHookFixture.publishWorkspaceEvent(event),
      migrationEvent,
    ),
    1,
    "The fixture must deliver migration through the subscribed workspace event port",
  );
  await page.waitForFunction(
    () =>
      window.draftHookFixture.read("right").text === "配置迁移来源正文" &&
      window.draftHookFixture.read("right").modelSelection?.modelId === "target-model",
  );
  const migratedConfig = await page.evaluate(() => window.draftHookFixture.read("right"));
  assert.deepEqual(migratedConfig.modelSelection, {
    providerId: "target-provider",
    modelId: "target-model",
    options: { reasoningLevel: "medium" },
  });
  assert.equal(migratedConfig.ompModelEdited, true);
  assert.equal(migratedConfig.ompThoughtEdited, true);
  evidence.push({
    event: "actual-workspace-event-draft-migration-config-conflict",
    migrationHook: "ComposerDraftMigrationEvents",
    workspaceEventSubscription: true,
    sourceContentRetained: true,
    targetOnlyModelAndThoughtIntentWon: true,
  });

  const coldSource = "tmp-cold-query-meta";
  const coldTarget = "22222222-2222-4222-8222-222222222222";
  const coldText = "冷查询缓存迁移来源全文";
  await page.evaluate(() => window.performanceFixture.render({ mode: "composer" }));
  await settledRender(page);
  await page.evaluate(
    (hookScope) =>
      window.performanceFixture.render({
        mode: "draft-hooks",
        hookScope,
        secondPane: false,
        migrationEvents: false,
      }),
    coldSource,
  );
  await left.waitFor({ state: "visible" });
  await settledRender(page);
  await left.fill(coldText);
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  await page.evaluate(
    ({ fromTaskId, toTaskId }) =>
      window.draftHookFixture.primeCachedMigration(fromTaskId, toTaskId),
    { fromTaskId: coldSource, toTaskId: coldTarget },
  );
  assert.equal(
    await page.evaluate(() => window.draftHookFixture.migrationSubscriptionCount()),
    0,
    "Cold query metadata is seeded before the migration hook binds",
  );
  await page.evaluate(() => window.performanceFixture.render({ migrationEvents: true }));
  await page.waitForFunction(
    ({ expected, target }) =>
      window.draftHookFixture.migrationSubscriptionCount() === 1 &&
      window.draftHookFixture.read("left").text === expected &&
      Object.keys(localStorage)
        .filter((key) => key.startsWith("zcode-v4-composer-drafts:v1:component-draft-hooks"))
        .some((key) =>
          Object.entries(JSON.parse(localStorage.getItem(key)).scopes).some(
            ([scope, draft]) => scope === target && draft.text === expected,
          ),
        ),
    { expected: coldText, target: coldTarget },
  );
  await page.evaluate(() => window.draftHookFixture.flush("left"));
  const coldScopes = await page.evaluate(
    (text) =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("zcode-v4-composer-drafts:v1:component-draft-hooks"))
        .flatMap((key) =>
          Object.entries(JSON.parse(localStorage.getItem(key)).scopes)
            .filter(([, draft]) => draft.text === text)
            .map(([scope]) => scope),
        ),
    coldText,
  );
  assert.deepEqual(coldScopes, [coldTarget]);
  assert.equal(await page.evaluate(() => window.draftHookFixture.migrationSubscriptionCount()), 1);
  evidence.push({
    event: "cold-query-cache-meta-draft-migration",
    cachedMetadataSeededBeforeHookBinding: true,
    existingTaskQueryCacheEntry: true,
    migratedSourceDraftScopes: coldScopes,
    canonicalUuidScope: coldTarget,
  });
}
