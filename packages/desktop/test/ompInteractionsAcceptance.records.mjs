import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readMockRequests } from "./ompMockInteractions.assertions.mjs";
import { schemaOf } from "./ompAgentsAcceptance.protocol.mjs";
import {
  LIVE_CASES,
  QUESTION,
  UI_TOOL,
  askArguments,
  askTimeout,
  assertAskModelResult,
  callIdFor,
  hash,
  markerFor,
  normalizedPrompt,
  probeArguments,
  probeResult,
  probeSpec,
  promptFor,
  richAnswers,
  textOf,
} from "./ompInteractionsAcceptance.contract.mjs";

export function advertisedAskEvidence(diagnostics, name, nonce) {
  const requests = diagnostics.calls.filter((call) => {
    const last = call.messages.at(-1);
    return last?.role === "user" && normalizedPrompt(last.content) === promptFor(name, nonce);
  });
  assert.equal(requests.length, 1, `Exactly one real HTTP request must advertise ${name}'s schema`);
  const schema = schemaOf(requests[0], "ask");
  return { schema, arguments: askArguments(name, nonce, schema) };
}

async function jsonlFiles(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) paths.push(...(await jsonlFiles(path)));
    else if (entry.name.endsWith(".jsonl")) paths.push(path);
  }
  return paths;
}

export async function readInteractionRecords(runtime, taskTestId, originalAskEvidence) {
  const uuid = taskTestId.slice("task-item-".length);
  const files = await jsonlFiles(join(runtime.runRoot, "omp", "agent", "sessions"));
  const matched = files.filter((path) => basename(path).endsWith(`_${uuid}.jsonl`));
  assert.equal(matched.length, 1, "A stable GUI UUID must resolve to one real OMP session file");
  const entries = (await readFile(matched[0], "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(entries.find((entry) => entry.type === "session")?.id, uuid);
  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  const nonce = runtime.acceptance.nonce;
  const diagnostics = originalAskEvidence ? undefined : await readMockRequests(runtime);
  const askEvidence =
    originalAskEvidence ??
    Object.fromEntries(
      LIVE_CASES.filter((name) => name.startsWith("ask-")).map((name) => [
        name,
        advertisedAskEvidence(diagnostics, name, nonce),
      ]),
    );
  assert.deepEqual(
    Object.keys(askEvidence),
    LIVE_CASES.filter((name) => name.startsWith("ask-")),
  );
  const calls = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "toolCall");
  assert.deepEqual(
    calls.map((call) => call.id),
    LIVE_CASES.map((name) => callIdFor(name, nonce)),
  );
  const results = [];
  for (const name of LIVE_CASES) {
    const id = callIdFor(name, nonce);
    const tool = name.startsWith("ask-") ? "ask" : UI_TOOL;
    const call = calls.find((candidate) => candidate.id === id);
    assert.equal(call.name, tool);
    const expectedArguments =
      tool === "ask" ? askArguments(name, nonce, askEvidence[name].schema) : probeArguments(name);
    if (tool === "ask") assert.deepEqual(askEvidence[name].arguments, expectedArguments);
    assert.deepEqual(
      call.arguments,
      expectedArguments,
      "Persisted intent must match the legal real advertised tool arguments",
    );
    const matchedResults = messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId === id,
    );
    assert.equal(matchedResults.length, 1, "One actual persisted result per issued identity");
    const result = matchedResults[0];
    assert.equal(result.toolName, tool);
    if (name.startsWith("ask-")) assertAskModelResult(name, textOf(result.content), nonce);
    if (name === "ask-rich") {
      assert.equal(result.isError, false);
      assert.equal(result.details.results.length, 2);
      assert.deepEqual(
        result.details.results.map((answer) => ({
          id: answer.id,
          selectedOptions: answer.selectedOptions,
          customInput: answer.customInput,
        })),
        richAnswers(nonce),
      );
      for (const answer of result.details.results) {
        assert.equal(answer.question, QUESTION);
        assert.equal(answer.multi, true);
        assert.deepEqual(answer.options, ["Postgres", "SQLite"]);
      }
    } else if (name === "ask-timeout") {
      assert.equal(result.isError, false);
      const answer = result.details.results ? result.details.results[0] : result.details;
      if (result.details.results) assert.equal(result.details.results.length, 1);
      assert.equal(answer.timedOut, true);
      assert.deepEqual(answer.selectedOptions, ["SQLite"]);
      assert.equal(answer.customInput, undefined);
      assert.equal(answer.question, `Timeout recommendation ${nonce}`);
    } else if (name === "ask-cancel") {
      assert.equal(result.isError, true, "Native ask cancellation must remain an error result");
      const terminal = messages[messages.indexOf(result) + 1];
      assert.equal(terminal?.role, "assistant");
      assert.equal(
        terminal.stopReason,
        "aborted",
        "Cancelling rich ask must retain the real adjacent aborted core terminal",
      );
      assert.equal(
        textOf(terminal.content),
        "",
        "An aborted ask cannot invent an assistant answer",
      );
      const answers =
        result.details?.results ?? (result.details?.selectedOptions ? [result.details] : []);
      assert.equal(
        answers.filter((answer) => answer.selectedOptions?.length || answer.customInput).length,
        0,
        "No partially filled answer survives whole-request cancellation",
      );
    } else {
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(textOf(result.content)), probeResult(probeSpec(name, nonce)));
      assert.deepEqual(
        result.details,
        probeResult(probeSpec(name, nonce)),
        "The durable extension details must preserve the actual UI cancellation/digest result",
      );
    }
    assert.equal(
      messages.filter(
        (message) =>
          message.role === "assistant" && textOf(message.content) === markerFor(name, nonce),
      ).length,
      name === "ask-cancel" ? 0 : 1,
    );
    results.push({ name, id, outputHash: hash(textOf(result.content)), isError: result.isError });
  }
  return {
    path: matched[0],
    uuid,
    messages,
    results,
    askEvidence,
    messageHash: hash(JSON.stringify(messages)),
  };
}

export async function assertLiveModelEvidence(runtime, records, deadline) {
  const diagnostics = await readMockRequests(runtime);
  // ask-cancel 的核心终态是 aborted；没有取消后的模型 HTTP 续轮，其结果由下次提交携带。
  const expectedRequests = LIVE_CASES.length * 2 - 1;
  assert.equal(diagnostics.calls.length, expectedRequests);
  assert.equal(diagnostics.acceptance.requestCount, expectedRequests);
  assert.equal(diagnostics.acceptance.pending, null);
  assert.deepEqual(
    diagnostics.acceptance.issued.map((item) => item.id),
    LIVE_CASES.map((name) => callIdFor(name, runtime.acceptance.nonce)),
  );
  assert.deepEqual(diagnostics.acceptance.verified, records.results);
  for (const name of LIVE_CASES.filter((candidate) => candidate.startsWith("ask-")))
    assert.deepEqual(
      advertisedAskEvidence(diagnostics, name, runtime.acceptance.nonce),
      records.askEvidence[name],
    );
  const timeout = askTimeout(records.askEvidence["ask-timeout"].schema);
  assert.equal(deadline.source, timeout ? "parameter" : "core-default");
  if (timeout)
    assert.deepEqual(
      {
        field: deadline.field,
        unit: deadline.unit,
        value: deadline.value,
        milliseconds: deadline.milliseconds,
      },
      timeout,
    );
  const issued = diagnostics.acceptance.issued.find((item) => item.name === "ask-timeout");
  assert.equal(deadline.intentIssuedAt, issued.intentIssuedAt);
  if (timeout) assert.ok(deadline.hiddenAt >= deadline.intentIssuedAt + timeout.milliseconds - 250);
  assert.ok(deadline.hiddenAt >= deadline.visibleAt);
  for (const call of diagnostics.calls) {
    assert.equal(call.aborted, false);
    assert.equal(call.completed, true);
  }
  return diagnostics.calls.length;
}
