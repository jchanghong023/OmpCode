// 只读取本启动器隔离workspace对应的OMP测试桶，提取测试marker的事实字段。
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

export async function collectInteractionSourceEvidence(runRoot, expectedBodies) {
  assert.ok(isAbsolute(runRoot), "Read only the launcher's absolute isolated run root");
  const sessionRoot = join(runRoot, "home/.omp/agent/sessions");
  const buckets = (await readdir(sessionRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.includes(basename(runRoot)),
  );
  assert.equal(buckets.length, 1, "Only read the unique test workspace bucket");
  const bucketRoot = join(sessionRoot, buckets[0].name);
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
      const ancestry = relative(bucketRoot, path).split(sep).slice(1);
      if (ancestry.length) ancestry[ancestry.length - 1] = basename(entry.name, ".jsonl");
      const parentAgentId = ancestry.join("/") || "main";
      const children = new Set();
      const recordTerminal = (row, agentId, status, field) => {
        if (
          children.has(agentId) &&
          ["completed", "success", "failed", "cancelled", "aborted"].includes(status)
        )
          terminalAgents.push({
            file: entry.name,
            path,
            entryId: row.id,
            parentAgentId,
            agentId,
            status,
            field,
            timestamp: Date.parse(row.timestamp),
          });
      };
      for (const row of entries) {
        if (row.type === "model_change") models.push({ file: entry.name, model: row.model });
        // 修复：原生后台结果直接落在 custom_message，不在 row.message 中；
        // jobs 证明任务身份，匹配的 task-result 包装才证明终态，不能读提示语猜完成。
        if (row.type === "custom_message" && row.customType === "async-result") {
          const content =
            typeof row.content === "string"
              ? row.content
              : Array.isArray(row.content)
                ? row.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
                : "";
          const results = [...content.matchAll(/<task-result\b([^>]*)>[\s\S]*?<\/task-result>/gu)];
          for (const [index, job] of (row.details?.jobs ?? []).entries()) {
            if (job.type !== "task") continue;
            const agentId = job.agentUrlId ?? job.jobId;
            if (job.status !== undefined) {
              recordTerminal(row, agentId, job.status, `details.jobs[${index}].status`);
              continue;
            }
            for (const result of results) {
              const id = /\bid="([^"]+)"/u.exec(result[1])?.[1];
              const status = /\bstatus="([^"]+)"/u.exec(result[1])?.[1];
              if (id === job.jobId || id === agentId)
                recordTerminal(
                  row,
                  agentId,
                  status,
                  `content.task-result[id="${id}"].status (details.jobs[${index}])`,
                );
            }
          }
        }
        const message = row.message;
        if (!message) continue;
        if (message.role === "toolResult" && message.toolName === "task")
          for (const key of ["progress", "results"])
            for (const [index, state] of (message.details?.[key] ?? []).entries()) {
              if (typeof state.id !== "string" || !state.id) continue;
              children.add(state.id);
              recordTerminal(
                row,
                state.id,
                state.status,
                `message.details.${key}[${index}].status`,
              );
            }
        if (message.role === "toolResult" && message.toolName === "wait")
          for (const [index, state] of (message.details?.jobs ?? []).entries())
            if (state.type === "task")
              recordTerminal(
                row,
                state.agentUrlId ?? state.id,
                state.status,
                `message.details.jobs[${index}].status`,
              );
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
  await visit(bucketRoot);
  return { source, models, terminalAgents };
}
