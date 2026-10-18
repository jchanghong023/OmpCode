import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promptOf } from "./ompAgentsAcceptance.protocol.mjs";

export async function jsonlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? jsonlFiles(join(directory, entry.name))
          : entry.name.endsWith(".jsonl")
            ? [join(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}
export const readEntries = async (path) =>
  (await readFile(path, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
export const messagesOf = (entries) =>
  entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
export const callsOf = (messages) =>
  messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "toolCall");
export const resultsOf = (messages) => messages.filter((message) => message.role === "toolResult");
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function successful(messages, id, toolName) {
  const calls = callsOf(messages).filter((part) => part.id === id && part.name === toolName);
  assert.equal(calls.length, 1, `${id} must have exactly one actual invocation in its own record`);
  const results = resultsOf(messages).filter(
    (part) => part.toolCallId === id && part.toolName === toolName,
  );
  assert.equal(results.length, 1, `${id} must have exactly one matching persisted tool result`);
  assert.notEqual(results[0].isError, true, `${id} may not hide an actual tool failure`);
  return { call: calls[0], result: results[0] };
}

export function assertOriginalAssignment(entries, parentPath, assignment) {
  assert.equal(
    entries.find((entry) => entry.type === "session")?.parentSession,
    parentPath,
    "The raw child record must belong to this exact canonical parent JSONL",
  );
  const escaped = assignment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const framed = new RegExp(
    `^Complete assignment thoroughly:\\n\\n(?:${escaped}|<workpool pool="[A-Za-z0-9_-]+" batch="[A-Za-z0-9_-]+">\\n(?:(?!AGENTS_CHILD_)[\\s\\S])*\\n## Item 1\\n${escaped}\\n<\\/workpool>)$`,
    "u",
  );
  const originals = messagesOf(entries).filter(
    (message) => message.role === "user" && framed.test(promptOf(message.content)),
  );
  assert.equal(
    originals.length,
    1,
    "The exact complete framed assignment must exist in the independently owned child source",
  );
}
