import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  choice,
  dashboard,
  diagnostics,
  eventually,
  idle,
  indexSnapshot,
  nativeInput,
} from "./ompNativeAcceptance.helpers.mjs";
import { commandRows } from "./ompNativeAcceptance.commandRows.mjs";
import { indexIdentity } from "./ompNativeAcceptance.indexIdentity.mjs";
import { commandOperation, commandOutput, nativeStatus } from "./ompNativeAcceptance.history.mjs";

const normalized = (value) => value.replaceAll("\\", "/");
const sections = (page) => page.getByRole("listbox", { name: "Document sections", exact: true });

async function fragment(page, runtime, label, document, matchKind) {
  const lines = document.content
    .trim()
    .split("\n")
    .map((line) => line.replace(/^#+ /u, ""));
  const complete = (row) => lines.every((line) => row.text.includes(line));
  const before = new Set((await commandRows(page)).map((row) => row.id));
  await choice(page, label);
  const rows = await eventually(
    () => commandRows(page),
    (items) => items.some((row) => !before.has(row.id) && complete(row)),
    `Wiki real fragment ${document.title}`,
  );
  const added = rows.filter((row) => !before.has(row.id) && complete(row));
  assert.equal(added.length, 1, "One new complete original Wiki fragment, not the query echo");
  const text = normalized(added[0].text);
  assert.ok(text.includes(document.title));
  assert.ok(
    text.includes(normalized(document.path)) ||
      text.includes(normalized(relative(runtime.requestedWorkspace, document.path))) ||
      text.includes(normalized(relative(dirname(document.path), document.path))),
    "Wiki fragment must identify its actual source file",
  );
  assert.match(text, new RegExp(`^\\[${matchKind}\\]`, "u"));
  assert.ok(
    text.startsWith(normalized(label.replace(/^\d+\. /u, ""))),
    "Fragment header must preserve the exact selected index, source, line span and heading",
  );
  assert.ok(text.includes(`sha256=${createHash("sha256").update(document.content).digest("hex")}`));
  assert.match(text, /sectionId=\d+/u);
  await sections(page).waitFor({ state: "visible" });
}

async function resultPage(page, total, start, count, more) {
  const list = sections(page);
  await list.waitFor({ state: "visible" });
  await list
    .getByRole("option")
    .filter({
      has: page.getByText(new RegExp(`^${start}\\. \\[`, "u")),
    })
    .waitFor({ state: "visible" });
  const options = list.getByRole("option");
  // Read the core label span, not the renderer's additional ordinal or accessible-name prefix.
  const labels = await options.locator(":scope > span > span:first-child").allTextContents();
  assert.equal(
    labels.length,
    await options.count(),
    "Every real source/paging option must expose one original label",
  );
  const hits = labels.flatMap((text) => {
    const match = /\d+\. \[([^\]]+)\] \[([^\]]+)\] ([^\r\n]+?\.md):\d+-\d+ ([^\r\n]+)/u.exec(text);
    return match
      ? [
          {
            label: match[0],
            mode: match[1],
            index: match[2],
            source: normalized(match[3]),
            heading: match[4],
          },
        ]
      : [];
  });
  assert.equal(hits.length, count, `Wiki page must contain exactly ${count} real source options`);
  assert.ok(count <= 20, "RPC Wiki page limit is 20");
  assert.equal(
    labels.length,
    count + (more ? 2 : 1),
    "Only source hits and actual paging controls are allowed",
  );
  assert.equal(
    await options.filter({ has: page.getByText("Next page", { exact: true }) }).count(),
    more ? 1 : 0,
  );
  assert.equal(
    await options.filter({ has: page.getByText("Done browsing", { exact: true }) }).count(),
    1,
  );
  const output = (await commandRows(page))
    .filter((row) => row.text.startsWith("Section hits:"))
    .at(-1);
  assert.ok(output, "Each page must produce a real OMP result summary");
  // OMP joins summary lines with "\n"; Markdown soft breaks render as spaces in innerText.
  assert.match(
    output.text,
    new RegExp(`^Section hits: ${total} · showing ${start}-${start + count - 1}(?:\\r?\\n| )`, "u"),
  );
  assert.ok(
    output.text.includes(
      more ? "More results available. Select Next page to continue." : "Results exhausted.",
    ),
  );
  return hits;
}

export async function exerciseWiki(page, runtime, { paths, values }) {
  const calls = (await diagnostics(runtime)).calls.length;
  await nativeStatus(page, runtime, "Wiki", /^No document indexes\.$/u);
  const empty = await indexSnapshot(runtime);
  await commandOutput(
    page,
    async () => {
      await dashboard(page, runtime, "Wiki");
      await choice(page, "New document index");
      await nativeInput(page, paths.missing, "Markdown directory");
      await nativeInput(page, `${values.wikiIndex}-missing`, "Document index name");
    },
    /(?:does not exist|not found|not a directory|不存在|无效路径)/iu,
    "Wiki missing source",
  );
  assert.deepEqual(
    await indexSnapshot(runtime),
    empty,
    "Invalid Wiki source must not manufacture index facts",
  );

  await dashboard(page, runtime, "Wiki");
  await choice(page, "New document index");
  await nativeInput(page, dirname(paths.document), "Markdown directory");
  const nameRequest = page.getByTestId("v4-user-input-dialog").filter({
    has: page.getByText("Document index name", { exact: true }),
  });
  await nameRequest.getByRole("button", { name: "取消", exact: true }).click();
  await nameRequest.waitFor({ state: "hidden" });
  await idle(page);
  assert.deepEqual(
    await indexSnapshot(runtime),
    empty,
    "Cancelled Wiki creation must preserve all persisted indexes",
  );

  const documents = [
    { path: paths.document, title: "Native timing reference", content: values.document },
    ...values.wikiDocuments,
  ];
  await commandOperation(
    page,
    async () => {
      await dashboard(page, runtime, "Wiki");
      await choice(page, "New document index");
      await nativeInput(page, dirname(paths.document), "Markdown directory");
      await nativeInput(page, values.wikiIndex, "Document index name");
    },
    new RegExp(
      `^Created document index ${values.wikiIndex}: ${documents.length} documents\\.$`,
      "u",
    ),
    "Wiki create",
  );
  const status = await nativeStatus(
    page,
    runtime,
    "Wiki",
    new RegExp(
      `^Document indexes:(?:\\r?\\n| )${values.wikiIndex}: ${documents.length} documents, ${documents.length} sections · `,
      "u",
    ),
  );
  const identity = await indexIdentity(runtime, "Wiki", status, dirname(paths.document));
  assert.equal(identity.name, values.wikiIndex);
  assert.equal(identity.documentCount, documents.length);
  assert.equal(identity.sectionCount, documents.length);
  const built = await indexSnapshot(runtime);
  const db = new DatabaseSync(resolve(runtime.runRoot, identity.path), { readOnly: true });
  try {
    const stored = db
      .prepare(
        "SELECT d.relative_path, d.title, d.sha256, s.raw_markdown FROM documents d JOIN sections s ON s.document_id=d.id WHERE d.index_id=? ORDER BY d.relative_path",
      )
      .all(identity.indexId);
    assert.equal(
      stored.length,
      documents.length,
      "Every fixture document must have exactly one persisted section",
    );
    for (const document of documents) {
      assert.equal(await readFile(document.path, "utf8"), document.content);
      const rows = stored.filter(
        (row) =>
          normalized(row.relative_path) ===
          normalized(relative(dirname(paths.document), document.path)),
      );
      assert.equal(rows.length, 1, "One exact source document/section in the Wiki database");
      assert.equal(rows[0].title, document.title);
      assert.equal(rows[0].sha256, createHash("sha256").update(document.content).digest("hex"));
      assert.equal(rows[0].raw_markdown.trim(), document.content.trim());
    }
  } finally {
    db.close();
  }

  await dashboard(page, runtime, "Wiki");
  await choice(page, "Search document indexes");
  await nativeInput(page, "NATIVE_WIKI_SENTINEL_731", "Search document indexes");
  const exact = await resultPage(page, 1, 1, 1, false);
  assert.equal(exact[0].index, values.wikiIndex);
  await fragment(page, runtime, exact[0].label, documents[0], exact[0].mode);
  await choice(page, "Done browsing");
  await idle(page);

  await dashboard(page, runtime, "Wiki");
  await choice(page, "Grep document indexes");
  await nativeInput(page, values.wikiGrep, "Grep document indexes");
  const grep = await resultPage(page, 2, 1, 2, false);
  const grepDocuments = values.wikiDocuments.filter((document) =>
    /pagination-(?:03|19)\.md$/u.test(document.path),
  );
  assert.deepEqual(
    grep.map((hit) => hit.source).sort(),
    grepDocuments
      .map((document) => normalized(relative(dirname(paths.document), document.path)))
      .sort(),
  );
  for (const hit of grep) {
    assert.equal(hit.mode, "regex");
    assert.equal(hit.index, values.wikiIndex);
    const document = grepDocuments.find(
      (item) => normalized(relative(dirname(paths.document), item.path)) === hit.source,
    );
    await fragment(page, runtime, hit.label, document, "regex");
  }
  await choice(page, "Done browsing");
  await idle(page);

  await dashboard(page, runtime, "Wiki");
  await choice(page, "Search document indexes");
  await nativeInput(page, values.wikiQuery, "Search document indexes");
  const first = await resultPage(page, 22, 1, 20, true);
  await choice(page, "Next page");
  const second = await resultPage(page, 22, 21, 2, false);
  const all = [...first, ...second];
  const sources = all.map((hit) => hit.source);
  assert.equal(
    new Set(sources).size,
    22,
    "Next page must not repeat any source from the first page",
  );
  assert.deepEqual(
    sources.sort(),
    values.wikiDocuments
      .map((document) => normalized(relative(dirname(paths.document), document.path)))
      .sort(),
    "Both pages must contain every actual matching source, without omissions",
  );
  for (const hit of all) {
    assert.equal(hit.index, values.wikiIndex);
    const document = values.wikiDocuments.find(
      (item) => normalized(relative(dirname(paths.document), item.path)) === hit.source,
    );
    assert.equal(hit.heading, document.title);
  }
  const selected = values.wikiDocuments.find(
    (item) => normalized(relative(dirname(paths.document), item.path)) === second[0].source,
  );
  await fragment(page, runtime, second[0].label, selected, second[0].mode);
  await choice(page, "Done browsing");
  await idle(page);
  assert.deepEqual(
    await indexSnapshot(runtime),
    built,
    "Search, Grep and pagination must not rewrite index identity or contents",
  );
  for (const document of documents)
    assert.equal(
      await readFile(document.path, "utf8"),
      document.content,
      "Wiki browsing must preserve every source document",
    );
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    calls,
    "All Wiki GUI maintenance and retrieval must use zero model calls",
  );
  return identity;
}
