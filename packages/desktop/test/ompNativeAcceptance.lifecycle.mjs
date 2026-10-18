import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { journalEvidence } from "./ompNativeAcceptance.helpers.mjs";

export async function finalizeNativeReceipt(runtime, receiptPath) {
  const saved = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(saved.root, runtime.runRoot);
  assert.equal(saved.launcherPid, runtime.launcherPid);
  assert.equal(saved.journalPhase, "live", "Only a successful live receipt can be finalized");
  const observedAt = Date.parse(saved.journalsObservedAt);
  assert.ok(Number.isFinite(observedAt), "Live journals require an observation timestamp");
  const journals = await journalEvidence(runtime);
  assert.deepEqual(
    journals.map(({ path }) => path),
    saved.journals.map(({ path }) => path),
    "Shutdown must retain the exact observed native journal file set and order",
  );
  const now = Date.now();
  assert.ok(observedAt <= now);
  const ids = new Set(saved.journals.flatMap(({ lines }) => lines.map(({ id }) => id)));
  for (const [index, journal] of journals.entries()) {
    const before = saved.journals[index].lines;
    assert.deepEqual(
      journal.lines.slice(0, before.length),
      before,
      "Shutdown must preserve every observed native message, tool and custom entry",
    );
    const suffix = journal.lines.slice(before.length);
    assert.ok(suffix.length <= 1, "Shutdown may append at most one normal exit per journal");
    if (suffix.length === 0) continue;
    // 正常 dispose 在 live 快照之后才追加退出记录；只在真实关闭屏障定稿，冷恢复仍全量严格比较。
    const [exit] = suffix;
    assert.equal(exit.type, "custom");
    assert.equal(exit.customType, "session_exit");
    assert.deepEqual(
      exit.data,
      { reason: "dispose", kind: "normal", recordedAt: exit.data?.recordedAt },
      "Completed native histories cannot acquire pending tool diagnostics at shutdown",
    );
    assert.ok(before.length > 0, "Exit must extend an observed native history");
    assert.equal(exit.parentId, before.at(-1).id, "Exit must extend the exact observed tail");
    assert.equal(typeof exit.id, "string");
    assert.ok(exit.id.length > 0 && !ids.has(exit.id), "Exit must have a unique new ID");
    ids.add(exit.id);
    const recordedAt = Date.parse(exit.data.recordedAt);
    assert.ok(
      recordedAt >= observedAt && recordedAt <= now,
      "Appended exit must belong to the observed live-to-shutdown interval",
    );
    assert.ok(Date.parse(exit.timestamp) >= recordedAt && Date.parse(exit.timestamp) <= now);
  }
  await writeFile(
    receiptPath,
    JSON.stringify({ ...saved, journals, journalPhase: "post-shutdown" }, null, 2),
  );
}
