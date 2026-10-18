import assert from "node:assert/strict";
import { test } from "node:test";
import { zcodeSessionEndedSubagentSchema, zcodeSessionRunningSubagentSchema } from "@zcode/shared";
import { runningSubagentSummarySchema, subagentRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjection } from "../src/domain/conversationProjection.js";
import { OmpSubagentBridge } from "../src/app/ompSubagentBridge.js";
import { ompSubagentFrameSchema } from "../src/domain/ompFrames.js";
import { rowsFromOmpEntries, transcriptFromOmpEntries } from "../src/domain/coldHistory.js";

function projection() {
  const value = new ConversationProjection("parent");
  value.beginUserTurn({
    text: "spawn",
    inputId: "input",
    sourceCommandId: "command",
    clientId: "test",
    routing: "startNow",
  });
  return value;
}
function childRow(value: ConversationProjection, id = "A") {
  const row = value
    .buildSnapshot()
    .rows.window.find(
      (candidate) => candidate.kind === "subagent" && candidate.entityId === `omp-subagent:${id}`,
    );
  assert.ok(row?.kind === "subagent");
  return row;
}
function bridgeFor(value: ConversationProjection) {
  const bridge = new OmpSubagentBridge(
    value,
    () => null,
    () => {},
  );
  return {
    bridge,
    frame: (frame: unknown) => bridge.handle(ompSubagentFrameSchema.parse(frame)),
  };
}
function progress(id: string, fields: Record<string, unknown> = {}) {
  return {
    type: "subagent_progress",
    payload: {
      agent: "worker",
      parentToolCallId: `task-${id}`,
      progress: { id, status: "running", ...fields },
    },
  };
}
function event(id: string, event: unknown) {
  return { type: "subagent_event", payload: { id, event } };
}

test("actual models retain provider identity across live rows, running summaries and ended directory", () => {
  const value = projection();
  const { frame } = bridgeFor(value);
  frame(
    progress("A", {
      model: "requested",
      resolvedModel: "fallback-selector",
      resolvedModelIdentity: "provider-a/shared-name",
    }),
  );
  frame(progress("B", { resolvedModelIdentity: "provider-b/shared-name" }));
  const original = childRow(value);
  assert.equal(subagentRowSchema.parse(original).model, "provider-a/shared-name");
  const running = value.stateSnapshot.subagents.running;
  assert.deepEqual(
    running.map((row) => row.model),
    ["provider-a/shared-name", "provider-b/shared-name"],
  );
  assert.equal(runningSubagentSummarySchema.parse(running[0]).model, original.model);
  assert.equal(zcodeSessionRunningSubagentSchema.parse(running[0]).model, original.model);

  frame(progress("A", { recentOutput: ["tool updated"] }));
  assert.equal(childRow(value).model, original.model);
  frame(
    event("A", {
      type: "message_start",
      message: { role: "assistant", provider: "provider-c", model: "next" },
    }),
  );
  assert.equal(childRow(value).model, "provider-c/next");
  assert.equal(childRow(value).rowId, original.rowId);
  assert.equal(childRow(value).parentToolCallId, "task-A");
  assert.equal(value.stateSnapshot.backgroundWorks.length, 0);
  frame(event("A", { type: "model_changed" }));
  frame(event("A", { type: "tool_execution_end", model: "not-a-model-fact" }));
  assert.equal(childRow(value).model, "provider-c/next");
  frame(event("A", { type: "model_changed", provider: "provider-c", model: "changed" }));
  assert.equal(childRow(value).model, "provider-c/changed");
  frame(progress("A", { resolvedModelIdentity: "provider-c/next" }));
  assert.equal(childRow(value).model, "provider-c/next");
  assert.equal(childRow(value, "B").model, "provider-b/shared-name");

  frame({ type: "subagent_lifecycle", payload: { id: "A", agent: "worker", status: "completed" } });
  const endedAt = childRow(value).endedAt;
  frame(
    event("A", {
      type: "message_end",
      message: { role: "assistant", provider: "provider-d", model: "final" },
    }),
  );
  frame(progress("A"));
  assert.equal(childRow(value).status, "success");
  assert.equal(childRow(value).endedAt, endedAt);
  assert.equal(childRow(value).model, "provider-d/final");
  const ended = value.subagentDirectory().ended.items[0];
  assert.equal(zcodeSessionEndedSubagentSchema.parse(ended).model, "provider-d/final");
  assert.equal(value.stateSnapshot.subagents.running.length, 1);
});

test("model events enrich established children without creating lifecycle or control proof", () => {
  const value = projection();
  const { bridge, frame } = bridgeFor(value);
  frame(progress("A", { resolvedModel: "provider/resolved", model: "requested" }));
  const original = childRow(value);
  assert.equal(original.model, "provider/resolved");
  frame(
    event("A", {
      type: "message_update",
      message: { role: "assistant", provider: "provider", model: "stream" },
    }),
  );
  assert.equal(childRow(value).model, "provider/stream");
  assert.equal(childRow(value).rowId, original.rowId);
  assert.equal(childRow(value).status, original.status);
  assert.equal(childRow(value).startedAt, original.startedAt);
  assert.equal(value.stateSnapshot.backgroundWorks.length, 0);
  assert.equal(bridge.observedSubagentStatus("A", null), undefined);
  frame(event("A", { type: "message_end", message: { role: "assistant" } }));
  assert.equal(childRow(value).model, "provider/stream");
  frame(
    event("unknown", { type: "message_end", message: { role: "assistant", model: "unowned" } }),
  );
  assert.equal(value.stateSnapshot.subagents.childSessionIds.length, 1);
});

function parentEntries(results: unknown[]) {
  return [
    { type: "model_change", model: "parent/never-inherit", timestamp: 1 },
    { type: "message", message: { role: "user", content: "spawn", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        model: "parent-model",
        provider: "parent",
        timestamp: 2,
        content: [{ type: "toolCall", id: "task-parent", name: "task", arguments: {} }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "task",
        toolCallId: "task-parent",
        timestamp: 100,
        content: "spawned",
        details: { results },
      },
    },
  ];
}

test("cold recovery uses newest owned child model independently of terminal status and never inherits parent model", () => {
  const entries = parentEntries([
    {
      id: "A",
      agent: "worker",
      status: "completed",
      resolvedModelIdentity: "provider/parent-result",
      resolvedModel: "selector",
    },
    {
      id: "B",
      agent: "worker",
      status: "completed",
      resolvedModel: "provider/newer-result",
      model: "requested-only",
    },
    { id: "C", agent: "worker", status: "pending", model: "requested-only", modelRole: "slow" },
    { id: "D", agent: "worker", status: "pending" },
  ]);
  const records = new Map<string, readonly unknown[]>([
    [
      "A",
      [
        { type: "model_change", model: "provider/old", timestamp: 50 },
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "provider",
            model: "actual",
            timestamp: 110,
            stopReason: "stop",
          },
        },
        { type: "model_change", model: "role/ignored", role: "smol", timestamp: 120 },
      ],
    ],
    [
      "B",
      [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "provider",
            model: "stale",
            timestamp: 90,
            stopReason: "stop",
          },
        },
      ],
    ],
    ["D", [{ type: "model_change", model: "provider/child-record", timestamp: 10 }]],
    ["unowned", [{ type: "model_change", model: "provider/unowned", timestamp: 999 }]],
  ]);
  const value = new ConversationProjection("cold-parent");
  value.hydrateRows(rowsFromOmpEntries(entries, new Map(), records));
  assert.equal(childRow(value).model, "provider/actual");
  assert.equal(childRow(value, "B").model, "provider/newer-result");
  assert.equal(childRow(value, "C").model, undefined);
  assert.equal(childRow(value, "C").status, "unknown");
  assert.equal(childRow(value, "D").model, "provider/child-record");
  assert.equal(childRow(value, "D").status, "unknown");
  assert.equal(value.stateSnapshot.subagents.childSessionIds.length, 4);
  assert.equal(value.stateSnapshot.subagents.running.length, 0);
  assert.equal(
    value.subagentDirectory().ended.items.find((item) => item.agentId === "A")?.model,
    "provider/actual",
  );
});

test("missing later task model fields preserve confirmed execution identity and requested-only remains unknown", () => {
  const entries = parentEntries([
    { id: "A", agent: "worker", status: "pending", resolvedModelIdentity: "provider/confirmed" },
  ]);
  entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "task",
      toolCallId: "task-parent",
      timestamp: 200,
      content: "done",
      details: { results: [{ id: "A", agent: "worker", status: "completed", model: "requested" }] },
    },
  });
  const value = new ConversationProjection("cold");
  value.hydrateRows(rowsFromOmpEntries(entries));
  assert.equal(childRow(value).model, "provider/confirmed");
  assert.equal(childRow(value).status, "success");
});

test("cold transcript model enrichment preserves terminal child identity and status", () => {
  const entries = parentEntries([{ id: "A", agent: "worker", status: "completed" }]);
  const records = new Map<string, readonly unknown[]>([
    [
      "A",
      [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "provider",
            model: "transcript",
            // 成功终态必须来自 OMP 的 stopReason，正文“finished”不能证明成功。
            stopReason: "stop",
            content: [{ type: "text", text: "finished" }],
            timestamp: 110,
          },
        },
        { type: "model_change", model: "provider/latest", timestamp: 120 },
      ],
    ],
  ]);
  const value = new ConversationProjection("cold");
  const transcripts = new Map(
    [...records].map(([id, childEntries]) => [id, transcriptFromOmpEntries(childEntries)]),
  );
  value.hydrateRows(rowsFromOmpEntries(entries, transcripts, records));
  const row = childRow(value);
  assert.equal(row.model, "provider/latest");
  assert.equal(row.status, "success");
  assert.equal(row.parentToolCallId, "task-parent");
  assert.equal(value.stateSnapshot.subagents.running.length, 0);
  assert.match(row.transcriptText ?? "", /finished/);
  assert.equal(value.subagentDirectory().ended.items[0]?.model, "provider/latest");
});
