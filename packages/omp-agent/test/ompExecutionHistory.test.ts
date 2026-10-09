import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { rowsFromOmpEntries } from "../src/domain/coldHistory.js";
import { ompHistoryOutcome } from "../src/domain/OmpSubagentHistory.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { mergeOmpCommandOutputHistory } from "../src/domain/OmpCommandOutputHistory.js";
import { TurnFileFacts } from "../src/domain/fileFacts.js";

const message = (value: Record<string, unknown>) => ({ type: "message", message: value });
const terminal = (stopReason = "stop", timestamp = 1100) =>
  message({
    role: "assistant",
    stopReason,
    timestamp,
    content: [{ type: "text", text: "result" }],
  });
const task = message({
  role: "toolResult",
  toolCallId: "spawn",
  toolName: "task",
  timestamp: 1000,
  content: [],
  details: {
    progress: ["A", "B", "C"].map((id) => ({
      id,
      agent: "task",
      status: "pending",
      assignment: `create ${id}`,
    })),
  },
});

test("广播与进程控制不计入文件变更，真实工作区文件写入仍保留", () => {
  const facts = new TurnFileFacts();
  for (const path of ["agent://all", "agent://Main", "proc://worker/kill"])
    facts.recordToolResult({ toolName: "write", input: { path, content: "hello" } });
  assert.deepEqual(facts.summary(), { files: 0, additions: 0, deletions: 0 });
  facts.recordToolResult({ toolName: "write", input: { path: "a", content: "a" } });
  assert.deepEqual(facts.summary(), { files: 1, additions: 1, deletions: 0 });
});

test("三个代理中 wait 接收和后台自动送达使用相同持久终态，冷快照不再显示运行", () => {
  const entries = [
    message({ role: "user", content: "start", timestamp: 900 }),
    task,
    message({
      role: "toolResult",
      toolName: "wait",
      toolCallId: "wait",
      timestamp: 1200,
      details: { jobs: [{ id: "B", type: "task", status: "completed" }] },
    }),
    {
      type: "custom_message",
      customType: "async-result",
      display: true,
      content: "model-only delivery guidance",
      details: {
        jobs: [
          { jobId: "A", type: "task" },
          { jobId: "C", type: "task" },
        ],
      },
      timestamp: 1201,
    },
    terminal("stop", 1300),
  ];
  const records = new Map(["A", "B", "C"].map((id) => [id, [terminal()]]));
  const rows = rowsFromOmpEntries(entries, new Map(), records);
  assert.deepEqual(
    rows.filter((row) => row.kind === "subagent").map((row) => row.status),
    ["success", "success", "success"],
  );
  assert.ok(!rows.some((row) => row.kind === "assistantText" && row.text.includes("model-only")));
  const projection = new ConversationProjection("history");
  projection.hydrateRows(rows);
  const snapshot = projection.buildSnapshot();
  assert.equal(snapshot.subagents.running.length, 0);
  assert.equal(snapshot.subagents.endedTotal, 3);
  conversationSnapshotSchema.parse(snapshot);
});

test("缺失子记录不伪造终态；有明确 wait 终态仍保留，失败和中断按核心 stopReason", () => {
  const rows = rowsFromOmpEntries(
    [task],
    new Map(),
    new Map([
      ["B", [terminal("error")]],
      ["C", [terminal("aborted")]],
    ]),
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "subagent").map((row) => row.status),
    ["unknown", "failed", "cancelled"],
  );
  const projection = new ConversationProjection("partial-history");
  projection.hydrateRows(rows);
  assert.equal(projection.buildSnapshot().subagents.running.length, 0);
  assert.equal(projection.subagentDirectory().ended.items[0]?.status, "unknown");
});

test("新一次唤醒或未结束工具调用使旧 yield 失效，不通过最终文本中的完成字样推断状态", () => {
  const yielded = message({
    role: "toolResult",
    toolName: "yield",
    timestamp: 1000,
    details: { type: "result", status: "success", data: { message: "complete" } },
  });
  assert.equal(ompHistoryOutcome([yielded]).status, "success");
  assert.equal(
    ompHistoryOutcome([
      yielded,
      { type: "custom_message", customType: "irc:incoming", timestamp: 1001 },
    ]).status,
    "unknown",
  );
  assert.equal(
    ompHistoryOutcome([
      terminal(),
      message({ role: "assistant", stopReason: "toolUse", timestamp: 1101, content: [] }),
    ]).status,
    "unknown",
  );
  assert.equal(
    ompHistoryOutcome([
      message({ role: "assistant", content: [{ type: "text", text: "complete" }] }),
    ]).status,
    "unknown",
  );
});

test("原生 yield 无 type 和字符串 type 均结束，数组增量及工具失败不能冒充完成", () => {
  const yielded = (details: Record<string, unknown>, isError = false) =>
    message({ role: "toolResult", toolName: "yield", timestamp: 1100, details, isError });
  for (const type of [undefined, null, "report", "result"])
    assert.equal(
      ompHistoryOutcome([yielded({ status: "success", type, data: { message: "hello" } })]).status,
      "success",
    );
  assert.equal(
    ompHistoryOutcome([yielded({ status: "success", type: ["findings"], data: "partial" })]).status,
    "unknown",
  );
  assert.equal(
    ompHistoryOutcome([yielded({ status: "success", type: ["findings"], complete: true })]).status,
    "success",
  );
  assert.equal(
    ompHistoryOutcome([yielded({ status: "aborted", type: ["findings"], error: "stopped" })])
      .status,
    "cancelled",
  );
  assert.equal(
    ompHistoryOutcome([yielded({ status: "success", type: "result" }, true)]).status,
    "unknown",
  );
  const rows = rowsFromOmpEntries(
    [task],
    new Map(),
    new Map(
      ["A", "B", "C"].map((id) => [
        id,
        [yielded({ status: "success", data: { message: "hello" } })],
      ]),
    ),
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "subagent").map((row) => row.status),
    ["success", "success", "success"],
  );
});

test("模型协调提示不污染执行正文和旧派生输出，普通扩展及用户正文保持可见", () => {
  const wrapper = '[Wait interrupted by message]\n<irc from="parent" agent="Main">\nhello\n</irc>';
  const entries = [
    message({
      role: "user",
      attribution: "user",
      steering: true,
      content: wrapper,
      timestamp: 1000,
    }),
    message({
      role: "user",
      attribution: "agent",
      steering: true,
      content: wrapper,
      timestamp: 1001,
    }),
    {
      type: "custom_message",
      customType: "irc:incoming",
      display: true,
      content: "internal reply guidance",
      timestamp: 1002,
    },
    {
      type: "custom_message",
      customType: "ordinary-extension",
      display: true,
      content: "extension result",
      timestamp: 1003,
    },
  ];
  const rows = mergeOmpCommandOutputHistory(
    rowsFromOmpEntries(entries),
    [{ id: "old", customType: "irc:incoming", text: "old cached reply guidance", createdAt: 1002 }],
    entries,
  );
  const inputs = rows.filter((row) => row.kind === "userInput");
  assert.equal(inputs[0]?.text, wrapper);
  assert.equal(inputs[1]?.text, "hello");
  assert.equal(inputs[1]?.origin, "mailbox");
  assert.equal(inputs[1]?.originMeta?.senderLabel, "Main");
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    ["extension result"],
  );
});
