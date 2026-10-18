import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexSnapshot } from "./ompNativeAcceptance.helpers.mjs";

const normalize = (value) => value.replaceAll("\\", "/").toLowerCase();

async function ownedSnapshot(runtime, path, kind) {
  const snapshot = (await indexSnapshot(runtime)).filter(
    (item) => resolve(runtime.runRoot, item.path) === resolve(path),
  );
  assert.equal(snapshot.length, 1, `${kind} must resolve to its exact owned SQLite database`);
  return snapshot[0];
}

async function wikiIdentity(runtime, status, source) {
  // DocsService exposes name/root/count, not the database path. Keep all three tied to its row.
  const path = join(runtime.configRoot, "agent", "docs.db");
  const snapshot = await ownedSnapshot(runtime, path, "Wiki");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const indexes = db
      .prepare(
        "SELECT i.id, i.name, i.root_path, " +
          "(SELECT count(*) FROM documents d WHERE d.index_id=i.id) document_count, " +
          "(SELECT count(*) FROM sections s WHERE s.index_id=i.id) section_count FROM doc_indexes i",
      )
      .all()
      .filter((index) => normalize(resolve(index.root_path)) === normalize(resolve(source)));
    assert.equal(indexes.length, 1, "One persisted Wiki index must own the displayed source root");
    const index = indexes[0];
    assert.ok(
      status.text
        .replaceAll("\\", "/")
        .includes(
          `${index.name}: ${index.document_count} documents, ${index.section_count} sections · ${index.root_path.replaceAll("\\", "/")}`,
        ),
      "Wiki GUI name, root and exact document/section counts must equal its persisted identity",
    );
    return {
      path: snapshot.path,
      name: index.name,
      indexId: index.id,
      documentCount: index.document_count,
      sectionCount: index.section_count,
    };
  } finally {
    db.close();
  }
}

async function repoIdentity(runtime, status, source) {
  // OMP tools/repo.ts formatRepoStatusLines exposes only root/generation/counts as identity.
  // Markdown may render soft line breaks as spaces; field delimiters remain authoritative.
  const roots = [...status.text.matchAll(/(?:^|\s)Root: (.+?)(?=\s+Index:)/gu)];
  const indexes = [
    ...status.text.matchAll(
      /(?:^|\s)Index: generation ([^;\r\n]+); (\d+) files; (\d+) symbols(?=\s+Coverage:)/gu,
    ),
  ];
  assert.equal(roots.length, 1, "Repo status must display exactly one complete root");
  assert.equal(indexes.length, 1, "Repo status must display one built generation and exact counts");
  const root = roots[0][1];
  assert.equal(
    normalize(resolve(root)),
    normalize(await realpath(source)),
    "Repo displayed root must equal the actual source root",
  );
  const [, generation, files, symbols] = indexes[0];
  // RepoStorage.repoIndexPath hashes the exact canonical root, not a normalized path or DB guess.
  const hash = createHash("sha256").update(root).digest("hex");
  const path = join(runtime.configRoot, "agent", "repo", `${hash}.db`);
  const snapshot = await ownedSnapshot(runtime, path, "Repo");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const states = db.prepare("SELECT id, generation FROM state").all();
    assert.equal(states.length, 1, "Repo must have exactly one persisted state owner");
    assert.equal(states[0].id, 1, "Repo state must be the RepoStorage singleton");
    assert.equal(
      states[0].generation,
      generation,
      "Repo GUI generation must equal persisted state",
    );
    // RepoService.status counts files and joined symbols only in the active generation.
    const counts = db
      .prepare(
        "SELECT (SELECT count(*) FROM files WHERE generation=?) files, " +
          "(SELECT count(*) FROM symbols s JOIN files f ON f.id=s.file_id WHERE f.generation=?) symbols",
      )
      .get(generation, generation);
    assert.ok(counts.files > 0, "A built fixture Repo must contain active-generation files");
    // OMP 仅为 .py 提取符号；本套 .mjs 语料合法为 0，仍与实际 GUI 计数严格相等。
    assert.equal(
      counts.files,
      Number(files),
      "Repo GUI file count must exactly equal its generation",
    );
    assert.equal(
      counts.symbols,
      Number(symbols),
      "Repo GUI symbol count must exactly equal its generation",
    );
    return {
      path: snapshot.path,
      generation,
      fileCount: counts.files,
      symbolCount: counts.symbols,
    };
  } finally {
    db.close();
  }
}

export async function indexIdentity(runtime, kind, status, source) {
  assert.ok(
    status?.id?.startsWith("omp-command-output:"),
    `${kind} identity must originate in this operation's actual status row`,
  );
  assert.ok(kind === "Wiki" || kind === "Repo", `Unsupported index kind ${kind}`);
  const text = normalize(status.text);
  const full = normalize(resolve(source));
  let hasSource = false;
  for (let at = text.indexOf(full); at !== -1; at = text.indexOf(full, at + full.length)) {
    const before = text[at - 1];
    const after = text[at + full.length];
    if (
      (before === undefined || " \t\r\n\"'`=:([{>".includes(before)) &&
      (after === undefined || " \t\r\n\"'`),;]}".includes(after) || after === "/")
    )
      hasSource = true;
  }
  assert.ok(hasSource, `${kind} status must identify its actual source directory`);
  const identity = await (kind === "Wiki"
    ? wikiIdentity(runtime, status, source)
    : repoIdentity(runtime, status, source));
  return {
    kind,
    ...identity,
    source: resolve(source),
    statusId: status.id,
    statusText: status.text,
  };
}
