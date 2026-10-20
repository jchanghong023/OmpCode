import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  diagnostics,
  dashboard,
  choice,
  confirm,
  panel,
  visibleText,
  idle,
  indexSnapshot,
  assertToolResult,
} from "./ompNativeAcceptance.helpers.mjs";
import { commandRows } from "./ompNativeAcceptance.commandRows.mjs";
import { indexIdentity } from "./ompNativeAcceptance.indexIdentity.mjs";
import { repositoryDiscoveryComplete } from "./ompNativeAcceptance.discovery.mjs";
import { commandOperation, nativeStatus } from "./ompNativeAcceptance.history.mjs";
import { exerciseWiki } from "./ompNativeAcceptance.wiki.mjs";

const positiveIndexed = /^Build repository index complete\./u;
const positiveUpdated = /^Update repository index complete\./u;
const positiveRebuilt = /^Rebuild repository index complete\./u;
const positiveDeleted =
  /(?:\bdeleted\b|delet(?:ion|e)\s+(?:completed|complete|finished)|已删除|删除完成)/iu;
const unavailable = /(?:No.*index|未.*索引|not.*indexed|0\s*(?:documents|files|篇))/iu;
const noMatches =
  /No indexed matches\. Try another query or use grep for exhaustive\/current file coverage\./u;

const only = (snapshot, identity) => snapshot.filter((db) => db.path === identity.path);

async function maintenance(page, runtime, action, pattern, label) {
  const count = (await diagnostics(runtime)).calls.length;
  if (pattern === null) {
    const before = new Set((await commandRows(page)).map((row) => row.id));
    await action();
    await idle(page);
    const added = (await commandRows(page)).filter((row) => !before.has(row.id));
    assert.ok(added.length > 0, `${label} must first show its real native dashboard`);
    for (const row of added)
      assert.doesNotMatch(
        row.text,
        /(?:^\/(?:wiki|repo) failed:|^(?:Created|Deleted) document index|^(?:Build|Rebuild|Update) repository index complete\.)/mu,
        `${label} must not complete maintenance after cancellation`,
      );
  } else {
    await commandOperation(page, action, pattern, label);
  }
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    count,
    `${label} must not send the untouched composer or a model request`,
  );
}

async function repoSearch(page, runtime, query, key, reply, expected, fileContent) {
  const dialog = await panel(page, runtime, "知识与代码索引");
  assert.match(await dialog.innerText(), /当前会话模型.*repo|repo.*当前会话模型/iu);
  await dialog.getByRole("textbox", { name: "代码检索内容", exact: true }).fill(query);
  await dialog.getByRole("button", { name: "通过当前会话模型使用 repo 工具", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await visibleText(page, reply);
  await idle(page);
  await assertToolResult(page, runtime, `${key}-docs`, "Execute by writing JSON to xd://repo.");
  await assertToolResult(page, runtime, key, expected);
  if (fileContent) await assertToolResult(page, runtime, `${key}-file`, fileContent.trim());
}

export async function exerciseIndexes(page, runtime, manifest) {
  const { paths, values } = manifest;
  const wiki = await exerciseWiki(page, runtime, manifest);
  await nativeStatus(page, runtime, "Repo", unavailable);
  // OMP 的首次 Repo status 会初始化空数据库；取消仅与该只读准备后的状态比较。
  const wikiBuilt = await indexSnapshot(runtime);
  await maintenance(
    page,
    runtime,
    async () => {
      await dashboard(page, runtime, "Repo");
      await choice(page, "Build repository index");
      await confirm(page, false);
    },
    null,
    "Repo cancelled build",
  );
  assert.deepEqual(
    await indexSnapshot(runtime),
    wikiBuilt,
    "Cancel Repo build must preserve Wiki and leave Repo unbuilt",
  );
  await maintenance(
    page,
    runtime,
    async () => {
      await dashboard(page, runtime, "Repo");
      await choice(page, "Build repository index");
      await confirm(page, true);
    },
    positiveIndexed,
    "Repo build",
  );
  const repoStatus = await nativeStatus(page, runtime, "Repo", /(?:indexed|索引|files?)/iu);
  const repo = await indexIdentity(runtime, "Repo", repoStatus, runtime.requestedWorkspace);
  assert.notEqual(
    repo.path,
    wiki.path,
    "Wiki and Repo identities must come from their separate actual status results",
  );
  const repoBuilt = await indexSnapshot(runtime);
  assert.deepEqual(only(repoBuilt, wiki), only(wikiBuilt, wiki));
  await repoSearch(
    page,
    runtime,
    values.query,
    "repo-search",
    "NATIVE_REPO_SEARCH_DONE_731",
    "NATIVE_REPO_SENTINEL_731",
    values.code,
  );

  // 哈希变化只算存储证据；新增符号的真实 Repo 命中及 read 原文才证明维护生效。
  await writeFile(paths.code, `${values.code}${values.updatedCode}`);
  await maintenance(
    page,
    runtime,
    async () => {
      await dashboard(page, runtime, "Repo");
      await choice(page, "Update repository index");
    },
    positiveUpdated,
    "Repo update",
  );
  const updatedStatus = await nativeStatus(page, runtime, "Repo", /(?:indexed|索引|files?)/iu);
  const updatedIdentity = await indexIdentity(
    runtime,
    "Repo",
    updatedStatus,
    runtime.requestedWorkspace,
  );
  assert.equal(updatedIdentity.path, repo.path, "Update must retain the exact owned Repo identity");
  const repoUpdated = await indexSnapshot(runtime);
  assert.notDeepEqual(
    only(repoUpdated, repo),
    only(repoBuilt, repo),
    "Updating changed source must change this exact status-bound Repo index",
  );
  assert.deepEqual(
    only(repoUpdated, wiki),
    only(repoBuilt, wiki),
    "Repo update must not rewrite the status-bound Wiki index",
  );
  await repoSearch(
    page,
    runtime,
    "updatedTiming732",
    "repo-updated",
    "NATIVE_REPO_UPDATED_DONE_732",
    "updatedTiming732",
    values.updatedCode,
  );
  await maintenance(
    page,
    runtime,
    async () => {
      await dashboard(page, runtime, "Repo");
      await choice(page, "Rebuild repository index");
      await confirm(page, false);
    },
    null,
    "Repo cancelled rebuild",
  );
  assert.deepEqual(
    await indexSnapshot(runtime),
    repoUpdated,
    "Cancelled rebuild must preserve the complete existing indexes",
  );
  await writeFile(paths.code, values.rebuiltCode);
  await maintenance(
    page,
    runtime,
    async () => {
      await dashboard(page, runtime, "Repo");
      await choice(page, "Rebuild repository index");
      await confirm(page, true);
    },
    positiveRebuilt,
    "Repo rebuild",
  );
  const rebuiltStatus = await nativeStatus(page, runtime, "Repo", /(?:indexed|索引|files?)/iu);
  const rebuiltIdentity = await indexIdentity(
    runtime,
    "Repo",
    rebuiltStatus,
    runtime.requestedWorkspace,
  );
  assert.equal(
    rebuiltIdentity.path,
    repo.path,
    "Rebuild must maintain the actual Repo identity, not an unrelated database",
  );
  assert.deepEqual(only(await indexSnapshot(runtime), wiki), only(repoUpdated, wiki));
  await repoSearch(
    page,
    runtime,
    "rebuiltTiming733",
    "repo-rebuilt",
    "NATIVE_REPO_REBUILT_DONE_733",
    "rebuiltTiming733",
    values.rebuiltCode,
  );
  await repoSearch(
    page,
    runtime,
    "nativeTiming731",
    "repo-removed-original",
    "NATIVE_REPO_OLD_REMOVED_731",
    noMatches,
  );
  await repoSearch(
    page,
    runtime,
    "updatedTiming732",
    "repo-removed-updated",
    "NATIVE_REPO_UPDATED_REMOVED_732",
    noMatches,
  );
  return [wiki, rebuiltIdentity];
}

export async function deleteIndexes(page, runtime, identities, isolationTask) {
  // 新建隔离会话会启动独立的 RepoLifecycle Git discovery；模型 idle / Team yield
  // 不等待该所有者，后续仍会把 fixture 路径写入 pending。必须先等其真实完成收据，
  // 再采集全部索引的取消基线，不能以数据库稳定或固定延时冒充后台维护完成。
  await repositoryDiscoveryComplete(runtime, isolationTask);
  for (const identity of identities) {
    const { kind } = identity;
    const built = await indexSnapshot(runtime);
    assert.equal(
      only(built, identity).length,
      1,
      `${kind} delete must target its actual status-bound database`,
    );
    const sources =
      kind === "Wiki"
        ? await Promise.all(
            (await readdir(identity.source)).sort().map(async (name) => ({
              path: join(identity.source, name),
              content: await readFile(join(identity.source, name), "utf8"),
            })),
          )
        : [];
    if (kind === "Wiki") assert.equal(sources.length, identity.documentCount);
    await maintenance(
      page,
      runtime,
      async () => {
        await dashboard(page, runtime, kind);
        await choice(page, kind === "Wiki" ? "Delete document index" : "Delete repository index");
        if (kind === "Wiki") await choice(page, `1. ${identity.name}`);
        await confirm(page, false);
      },
      null,
      `${kind} cancelled delete`,
    );
    assert.deepEqual(
      await indexSnapshot(runtime),
      built,
      `${kind} destructive cancel must preserve data`,
    );
    await maintenance(
      page,
      runtime,
      async () => {
        await dashboard(page, runtime, kind);
        await choice(page, kind === "Wiki" ? "Delete document index" : "Delete repository index");
        if (kind === "Wiki") await choice(page, `1. ${identity.name}`);
        await confirm(page, true);
      },
      positiveDeleted,
      `${kind} confirmed delete`,
    );
    await nativeStatus(page, runtime, kind, unavailable);
    const removed = await indexSnapshot(runtime);
    assert.notDeepEqual(
      only(removed, identity),
      only(built, identity),
      `${kind} delete must change its own actual index storage`,
    );
    if (kind === "Wiki") {
      const db = new DatabaseSync(join(runtime.runRoot, identity.path), { readOnly: true });
      try {
        assert.equal(
          db
            .prepare("SELECT count(*) count FROM doc_indexes WHERE id=? OR name=?")
            .get(identity.indexId, identity.name).count,
          0,
        );
        assert.equal(
          db.prepare("SELECT count(*) count FROM documents WHERE index_id=?").get(identity.indexId)
            .count,
          0,
        );
        assert.equal(
          db.prepare("SELECT count(*) count FROM sections WHERE index_id=?").get(identity.indexId)
            .count,
          0,
        );
      } finally {
        db.close();
      }
      for (const source of sources)
        assert.equal(
          await readFile(source.path, "utf8"),
          source.content,
          "Wiki delete must preserve every original source file",
        );
    }
    for (const other of identities.filter((item) => item.path !== identity.path))
      assert.deepEqual(
        only(removed, other),
        only(built, other),
        `Deleting ${kind} may not rewrite the other index`,
      );
  }
}
