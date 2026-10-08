// 只读取本启动器隔离workspace对应的OMP测试桶，提取测试marker的事实字段。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export async function collectInteractionSourceEvidence(runRoot, expectedBodies) {
  const sessionRoot = join(homedir(), ".omp/agent/sessions");
  const buckets = (await readdir(sessionRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.includes(basename(runRoot)),
  );
  assert.equal(buckets.length, 1, "Only read the unique test workspace bucket");
  const source = expectedBodies.map((body) => ({
    body,
    sends: [],
    durableMessages: [],
    wrappers: [],
  }));
  const models = [];
  const terminalAgents = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const text = await readFile(path, "utf8");
      if (!expectedBodies.some((body) => text.includes(body))) continue;
      const entries = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const calls = new Map();
      for (const row of entries) {
        if (row.type === "model_change") models.push({ file: entry.name, model: row.model });
        const message = row.message;
        if (!message) continue;
        for (const state of [
          ...(message.details?.jobs ?? []),
          ...(message.details?.results ?? []),
          ...(message.details?.progress ?? []),
        ])
          if (["completed", "success", "failed", "cancelled", "aborted"].includes(state.status))
            terminalAgents.push({
              file: entry.name,
              entryId: row.id,
              agentId: state.agentUrlId ?? state.id,
              status: state.status,
            });
        if (Array.isArray(message.content))
          for (const part of message.content) {
            if (part.type === "toolCall" && part.name === "write")
              calls.set(part.id, part.arguments);
          }
        if (message.role === "toolResult" && message.toolName === "write") {
          const call = calls.get(message.toolCallId);
          const item = source.find(({ body }) => body === call?.content);
          if (item && message.details?.message)
            item.sends.push({
              file: entry.name,
              callId: message.toolCallId,
              entryId: row.id,
              from: message.details.message.from,
              to: message.details.message.to,
              timestamp: Date.parse(row.timestamp),
              hasMessageId: typeof message.details.message.id === "string",
              hasSentTimestamp: typeof message.details.message.ts === "number",
            });
        }
        const waited = message.details?.waited;
        const item = source.find(({ body }) => body === waited?.body);
        if (item && waited.id && typeof waited.ts === "number")
          item.durableMessages.push({
            file: entry.name,
            entryId: row.id,
            messageId: waited.id,
            from: waited.from,
            to: waited.to,
            timestamp: waited.ts,
          });
        if (message.role === "user" && typeof message.content === "string")
          for (const item of source)
            if (message.content.includes(item.body) && message.content.includes("<irc "))
              item.wrappers.push({
                file: entry.name,
                entryId: row.id,
                timestamp: Date.parse(row.timestamp),
                contentType: "string",
                hasMessageId: Boolean(message.details?.id),
                hasSentTimestamp: typeof message.details?.ts === "number",
              });
      }
    }
  }
  await visit(join(sessionRoot, buckets[0].name));
  return { source, models, terminalAgents };
}
