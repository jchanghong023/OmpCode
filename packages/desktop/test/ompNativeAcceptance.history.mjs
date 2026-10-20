import assert from "node:assert/strict";
import { basename } from "node:path";
import { commandRows } from "./ompNativeAcceptance.commandRows.mjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";
import {
  eventually,
  idle,
  journalEvidence,
  dashboard,
  orchestrate,
} from "./ompNativeAcceptance.helpers.mjs";

export async function commandOutput(page, action, expected, label) {
  const before = await commandRows(page);
  const known = new Set(before.map((row) => row.id));
  await action();
  const completed = await eventually(
    () => commandRows(page),
    (rows) => rows.some((row) => !known.has(row.id) && expected.test(row.text)),
    `${label}: new command_output terminal`,
  );
  const added = completed.filter((row) => !known.has(row.id));
  const terminal = added.filter((row) => expected.test(row.text));
  assert.deepEqual(
    completed.slice(0, before.length),
    before,
    "A new native operation may append output, never drop, reorder or rewrite earlier command rows",
  );
  assert.equal(
    terminal.length,
    1,
    `${label} must have one distinct new matching row, not an old indexed/not indexed row`,
  );
  await idle(page);
  return { before, added, terminal: terminal[0] };
}

export async function assertCommandHistory(page, expected) {
  assert.ok(
    expected.length > 0,
    "Native cold history cannot be certified by an empty command list",
  );
  assert.equal(new Set(expected.map((row) => row.id)).size, expected.length);
  assert.deepEqual(
    await commandRows(page),
    expected,
    "Cold command_output IDs, full contents and order must equal live, each exactly once",
  );
}

export async function commandOperation(page, action, expected, label) {
  const result = await commandOutput(page, action, expected, label);
  assert.doesNotMatch(
    result.terminal.text,
    /(?:\bnot\s+(?:yet\s+)?indexed\b|\bnot\s+(?:built|updated|rebuilt|deleted)\b|未.*(?:索引|完成)|(?:^|\n)\s*(?:failed|failure|error|失败|cancelled|canceled)\b)/imu,
    `${label} may not mistake a failure/negative status for success`,
  );
  return result;
}

export async function nativeStatus(page, runtime, kind, expected) {
  const result = await commandOutput(
    page,
    () => dashboard(page, runtime, kind, true),
    expected,
    `${kind} actual status`,
  );
  return result.terminal;
}

export async function goalStatus(page, runtime, expected, objective, budget) {
  const result = await commandOutput(
    page,
    () => orchestrate(page, runtime, "/goal", "查看目标"),
    expected,
    "Goal actual status",
  );
  if (objective)
    assert.ok(
      result.terminal.text.includes(objective),
      "The new status must belong to this actual Goal",
    );
  if (budget !== undefined)
    assert.match(
      result.terminal.text,
      new RegExp(`\\bTokens: \\d+ / ${budget}(?=\\sTime spent:)`, "u"),
      "Real Goal status must expose the exact requested budget",
    );
  return result.terminal;
}
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

export async function assertRepoHistory(page, runtime, evidence, { paths, values }) {
  const started = Date.now();
  const deadline = started + 90_000;
  const remaining = () => {
    assert.ok(Date.now() < deadline, "Native repo history exceeded its shared 90s deadline");
    return Math.max(1, deadline - Date.now());
  };
  const issued = evidence.acceptance.issued.filter((item) => item.key.startsWith("repo-"));
  const completed = evidence.acceptance.completed.filter((item) => item.key.startsWith("repo-"));
  assert.equal(issued.length, 15, "Six device docs/search pairs and three hit-file reads");
  assert.equal(completed.length, issued.length);
  // Independent fixture bytes at each read, never the now-rebuilt file or a product parser.
  const fileVersions = new Map([
    ["repo-search-file", values.code],
    ["repo-updated-file", `${values.code}${values.updatedCode}`],
    ["repo-rebuilt-file", values.rebuiltCode],
  ]);
  assert.deepEqual(
    issued
      .filter((item) => item.name === "read" && item.args.path !== "xd://repo")
      .map((item) => item.key),
    [...fileVersions.keys()],
    "Exactly the original, appended-update and rebuilt file reads, in order",
  );
  const journals = await journalEvidence(runtime);
  let owner;
  let previous = -1;
  for (const item of issued) {
    remaining();
    console.log(`Native repo history: ${item.key} start elapsedMs=${Date.now() - started}`);
    const done = completed.filter((result) => result.id === item.id && result.key === item.key);
    assert.equal(done.length, 1);
    assert.equal(done[0].isError, false);
    const records = journals.filter((journal) =>
      journal.lines.some((entry) => {
        const message = entry.message ?? entry;
        return message.role === "toolResult" && message.toolCallId === item.id;
      }),
    );
    assert.equal(records.length, 1, "Each real device result belongs to one persisted journal");
    owner ??= records[0].path;
    assert.equal(records[0].path, owner, "All panel queries retain their actual session owner");
    const calls = [];
    const results = [];
    for (const [index, entry] of records[0].lines.entries()) {
      const message = entry.message ?? entry;
      for (const call of message.role === "assistant" ? (message.content ?? []) : [])
        if (call.type === "toolCall" && call.id === item.id) calls.push({ call, index });
      if (message.role === "toolResult" && message.toolCallId === item.id)
        results.push({ message, index });
    }
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(calls[0].call.name, item.name);
    assert.deepEqual(calls[0].call.arguments, item.args);
    assert.equal(results[0].message.toolName, item.name);
    assert.equal(results[0].message.isError, false);
    const message = results[0].message;
    const output = textOf(message.content);
    const source = fileVersions.get(item.key);
    if (source !== undefined) {
      assert.equal(item.name, "read");
      assert.equal(item.args.path, paths.code);
      const body = source.replace(/\n$/u, "");
      const lines = body.split("\n");
      assert.deepEqual(
        message.details?.displayContent,
        {
          text: body,
          startLine: 1,
          lineNumbers: lines.map((_, index) => index + 1),
        },
        `Retained complete ${item.key} display body and original line coordinates`,
      );
      assert.deepEqual(message.details.meta?.source, { type: "path", value: paths.code });
      assert.equal(message.details.totalLines, lines.length);
      assert.equal(message.details.fileSize, Buffer.byteLength(source, "utf8"));
      for (const line of lines)
        assert.ok(done[0].output.includes(line), `Original HTTP output contains ${item.key} line`);
      if (output === "[Superseded by a newer read of this file]") {
        assert.deepEqual(message.content, [{ type: "text", text: output }]);
        assert.ok(
          issued
            .slice(issued.indexOf(item) + 1)
            .some(
              (newer) =>
                newer.name === "read" &&
                newer.args.path === item.args.path &&
                completed.some((result) => result.id === newer.id && result.isError === false),
            ),
          "Only an older file read replaced by a later successful same-file read may be superseded",
        );
        assert.ok(Number.isFinite(message.prunedAt) && message.prunedAt >= message.timestamp);
      } else {
        assert.equal(output, done[0].output, "Unpruned file read retains exact model output");
      }
    } else {
      assert.equal(output, done[0].output, "Device docs/results retain exact model output");
    }
    assert.ok(previous < calls[0].index && calls[0].index < results[0].index);
    previous = results[0].index;
    if (item.name === "write") {
      assert.equal(item.args.path, "xd://repo");
      const request = JSON.parse(item.args.content);
      assert.equal(
        item.args.content,
        JSON.stringify(request),
        "Device payload is exactly one JSON line",
      );
      const device = results[0].message.details?.xdev;
      assert.equal(device?.tool, "repo");
      assert.equal(device.mode, "execute");
      assert.deepEqual(device.args, request);
      const missing = item.key === "repo-search-failed";
      assert.equal(device.inner.queryStatus, missing ? "missing" : "ok");
      assert.equal(device.inner.status.exists, !missing);
      assert.equal(device.inner.action, "search");
      if (missing || item.key.startsWith("repo-removed-"))
        assert.deepEqual(device.inner.hits, [], "Unavailable/removed symbols cannot produce hits");
      else {
        assert.ok(device.inner.hits.length > 0);
        assert.ok(device.inner.hits.every((hit) => hit.path === "native-code/timing.mjs"));
        assert.ok(device.inner.hits.every((hit) => hit.snippet.includes(request.query)));
      }
    }
    const continuations = evidence.calls.filter((request) => {
      const last = request.messages.at(-1);
      return (
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.some((part) => part.type === "tool_result" && part.tool_use_id === item.id)
      );
    });
    assert.equal(
      continuations.length,
      1,
      "Each result must return through one actual HTTP continuation",
    );
    const result = continuations[0].messages.at(-1).content;
    assert.equal(result.length, 1);
    assert.equal(result[0].is_error, false);
    assert.equal(textOf(result[0].content), done[0].output);
    const block = page.locator(`[data-tool-call-id="${item.id}"]`);
    await reveal(page, block, undefined, { deadline });
    remaining();
    assert.equal(await block.getAttribute("data-status", { timeout: remaining() }), "completed");
    if (source !== undefined) {
      // 冷恢复复用 live HTTP 证据；GUI 仍走真实控件，但不能为每条历史另开 90s 等待。
      assert.equal(issued.filter((candidate) => candidate.key === item.key).length, 1);
      assert.equal(completed.filter((candidate) => candidate.key === item.key).length, 1);
      assert.equal(done[0].id, item.id);
      const toggle = block.getByTestId(`tool-summary-trigger-${item.id}`);
      if ((await toggle.getAttribute("aria-expanded", { timeout: remaining() })) === "false")
        await toggle.click({ timeout: remaining() });
      assert.ok(
        (await block.innerText({ timeout: remaining() })).includes(basename(item.args.path)),
        `Visible read-file summary for ${item.key}`,
      );
    }
    remaining();
    console.log(`Native repo history: ${item.key} complete elapsedMs=${Date.now() - started}`);
  }
}
