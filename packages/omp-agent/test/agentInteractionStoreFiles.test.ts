import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createOmpStore } from "../src/adapters/ompStore.js";
import { OmpAgentInteractionLog } from "../src/domain/OmpAgentInteractionLog.js";
import { safeInteractionAgentId } from "../src/domain/OmpInteractionIds.js";

test("受控原生Alpha.Gamma后代路径与size/mtime续读缓存，路径逃逸和空段拒绝", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omp-interactions-files-"));
  context.after(async () => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const sessionPath = join(root, "parent.jsonl");
  const childDirectory = join(root, "parent", "Alpha");
  await mkdir(childDirectory, { recursive: true });
  const nestedPath = join(childDirectory, "Alpha.Gamma.jsonl");
  await writeFile(sessionPath, "{}\n");
  await writeFile(nestedPath, `${JSON.stringify({ message: "native nested" })}\n`);
  const store = createOmpStore({ OMP_CONFIG_ROOT: root });
  const first = await store.readInteractionEntries!(sessionPath, ["Alpha", "Alpha.Gamma"]);
  assert.deepEqual(first.entries, [{ message: "native nested" }]);
  const unchanged = await store.readInteractionEntries!(
    sessionPath,
    ["Alpha", "Alpha.Gamma"],
    first.version,
  );
  assert.equal(unchanged.entries, undefined);
  await appendFile(nestedPath, `${JSON.stringify({ message: "appended" })}\n`);
  const changed = await store.readInteractionEntries!(
    sessionPath,
    ["Alpha", "Alpha.Gamma"],
    first.version,
  );
  assert.notEqual(changed.version, first.version);
  assert.equal(changed.entries?.length, 2);
  for (const name of ["..", ".", "../escape", "Alpha..Gamma", "Alpha/Gamma", "", "Alpha\\Gamma"]) {
    assert.equal(safeInteractionAgentId(name), false);
    assert.equal((await store.readInteractionEntries!(sessionPath, [name])).available, false);
  }
});

test("live观察达到预算时首次truncated变化推进revision，查询缓存可显示partial", () => {
  const log = new OmpAgentInteractionLog();
  for (let index = 0; index < 20_000; index += 1)
    log.ingest("$root", {
      type: "irc_message",
      message: {
        role: "custom",
        customType: "irc:incoming",
        display: true,
        content: "text",
        details: { id: String(index), from: "Alpha", message: "message" },
      },
    });
  const revision = log.revision;
  log.ingest("$root", {
    type: "irc_message",
    message: {
      role: "custom",
      customType: "irc:incoming",
      display: true,
      content: "text",
      details: { id: "overflow", from: "Alpha", message: "message" },
    },
  });
  assert.equal(log.truncated, true);
  assert.equal(log.revision, revision + 1);
  assert.equal(log.sources()[0]?.entries.length, 20_000);
});
