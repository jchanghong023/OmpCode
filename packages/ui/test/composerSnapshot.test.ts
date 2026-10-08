import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { projectComposerSnapshot } from "../src/v4/composer/composerSnapshot.js";

function snapshot(): ConversationSnapshot {
  return {
    control: { phase: "running", canStop: true },
    inputRouting: { mode: "enqueue" },
    config: { provider: "p", model: "m", followupMode: "queue" },
    usage: {},
    backgroundWorks: [],
    queue: { items: [] },
    rows: { window: [], totalCount: 1 },
    seq: 1,
  } as unknown as ConversationSnapshot;
}

test("流式历史与 seq/queue 更新复用 Composer 展示引用，最新提交仍读完整事实", () => {
  const first = snapshot();
  const projected = projectComposerSnapshot(first, null)!;
  const latest = {
    ...first,
    seq: 200,
    queue: { ...first.queue, items: [{ queueItemId: "new" }] },
    rows: { ...first.rows, totalCount: 50000 },
  } as ConversationSnapshot;
  assert.equal(projectComposerSnapshot(latest, projected), projected);
  assert.equal("rows" in projected, false);
  assert.equal("queue" in projected, false);
  assert.equal(latest.queue.items[0].queueItemId, "new");
  assert.notEqual(
    projectComposerSnapshot(
      { ...latest, inputRouting: { ...latest.inputRouting, mode: "reject" } },
      projected,
    ),
    projected,
  );
  assert.notEqual(
    projectComposerSnapshot({ ...latest, usage: { ...latest.usage } }, projected),
    projected,
  );
  assert.equal(projectComposerSnapshot(null, projected), null);
});

test("历史从空到非空、父模型与后台任务变化仍及时更新展示", () => {
  const first = snapshot();
  const empty = { ...first, rows: { ...first.rows, totalCount: 0 } };
  const projected = projectComposerSnapshot(empty, null)!;
  assert.equal(projected.hasHistoryMessages, false);
  assert.equal(projectComposerSnapshot(first, projected)?.hasHistoryMessages, true);
  assert.equal(
    projectComposerSnapshot({ ...empty, config: { ...empty.config, model: "updated" } }, projected)
      ?.config.model,
    "updated",
  );
  assert.notEqual(
    projectComposerSnapshot({ ...empty, backgroundWorks: [...empty.backgroundWorks] }, projected),
    projected,
  );
});
