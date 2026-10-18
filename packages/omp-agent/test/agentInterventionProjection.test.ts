import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeAgentInteractionCoverage } from "@zcode/shared";
import { buildInteractionSnapshot } from "../src/domain/OmpAgentInteractionSnapshot.js";
import type {
  InteractionChild,
  InteractionSource,
} from "../src/domain/OmpAgentInteractionRecords.js";

type Issue = ZCodeAgentInteractionCoverage["issues"][number];
const worker: InteractionChild = {
  id: "Worker",
  rawId: "Worker",
  label: "Worker",
  parentAgentId: "main",
  ancestry: ["Worker"],
  known: true,
};
const source = (
  agentId: string,
  entries: readonly unknown[],
  origin: "history" | "live" = "history",
): InteractionSource => ({ agentId, entries, source: origin, key: `${origin}:${agentId}` });
const user = (id: string, fields: Record<string, unknown> = {}) => ({
  type: "message",
  id,
  message: {
    role: "user",
    attribution: "user",
    content: [{ type: "text", text: "Use the same instruction again." }],
    timestamp: 100,
    ...fields,
  },
});
function snapshot(
  history: InteractionSource[],
  live: InteractionSource[] = [],
  agents: InteractionChild[] = [worker],
) {
  return buildInteractionSnapshot({
    rootSessionId: "root-session",
    revision: 1,
    children: new Map(agents.map((agent) => [agent.id, agent])),
    observedStatuses: new Map(),
    terminalStatuses: new Set(["completed", "failed", "cancelled"]),
    directory: undefined,
    history,
    live,
    issues: new Set<Issue>(),
  });
}

test("explicit parent steering in a proven child is communication, not user intervention", () => {
  const result = snapshot([
    source("main", [user("root-prompt")]),
    source("Unproven", [user("unowned-prompt")]),
    source("Worker", [
      user("initial-task", { attribution: "agent" }),
      user("parent-irc-steer", {
        attribution: "agent",
        steering: true,
        content: [
          {
            type: "text",
            text: '[Wait interrupted by message]\n<irc from="parent" agent="Main">Parent update.</irc>',
          },
        ],
      }),
      user("legacy-role-only", { attribution: undefined, steering: true }),
      user("synthetic", { synthetic: true, steering: true }),
      user("operator-idle"),
      user("operator-streaming", { steering: true }),
    ]),
  ]);
  // OMP irc-bridge.ts 对运行中子代理调用 agent.steer，不追加 irc:incoming；
  // 需求 agent-interactions.md 将该记录投影为通信。相同时间的事件不承诺原始条目顺序。
  assert.deepEqual(result.events.map((event) => event.sourceId).sort(), [
    "operator-idle",
    "operator-streaming",
    "parent-irc-steer",
  ]);
  const parentMessage = result.events.find((event) => event.sourceId === "parent-irc-steer")!;
  const interventions = result.events.filter((event) => event.kind === "user_intervention");
  assert.equal(parentMessage.kind, "message");
  assert.equal(parentMessage.fromAgentId, "main");
  assert.equal(parentMessage.toAgentId, "Worker");
  assert.equal(parentMessage.body, "Parent update.");
  assert.equal(parentMessage.delivery, "observed");
  assert.equal(parentMessage.timeBasis, "recorded");
  assert.deepEqual(
    interventions.map((event) => event.kind),
    ["user_intervention", "user_intervention"],
  );
  assert.ok(
    interventions.every(
      (event) => event.fromAgentId === "user:operator" && event.toAgentId === "Worker",
    ),
  );
  assert.equal(parentMessage.messageId, undefined);
  assert.ok(
    interventions.every((event) => event.delivery === undefined && event.messageId === undefined),
  );
  assert.ok(result.coverage.issues.includes("legacy_history_gaps"));
});

test("same text with independent journal IDs stays distinct and duplicate observations are idempotent", () => {
  const entries = [user("first"), user("second")];
  const cold = snapshot([source("Worker", entries)]);
  const combined = snapshot([source("Worker", entries)], [source("Worker", entries, "live")]);
  assert.equal(combined.events.length, 2);
  assert.deepEqual(
    combined.events.map((event) => event.eventId),
    cold.events.map((event) => event.eventId),
  );
  assert.deepEqual(
    combined.events.map((event) => event.sourceId),
    ["first", "second"],
  );
  assert.ok(combined.events.every((event) => event.source === "live_and_history"));
  assert.deepEqual(combined.agents, cold.agents);
});

test("cold user identity cannot collide with raw or nested child IDs and unknown facts stay unknown", () => {
  const parent: InteractionChild = {
    ...worker,
    id: "user",
    rawId: "user",
    label: "user",
    ancestry: ["user"],
  };
  const child: InteractionChild = {
    ...worker,
    id: "user/operator",
    rawId: "operator",
    label: "operator",
    parentAgentId: "user",
    ancestry: ["user", "operator"],
  };
  assert.deepEqual(
    snapshot([], [], []).agents.map((agent) => agent.id),
    ["main"],
  );
  const result = snapshot(
    [source(child.id, [user("entry-without-time", { timestamp: undefined })])],
    [],
    [parent, child],
  );
  assert.deepEqual(
    result.agents.map((agent) => agent.id),
    ["main", "user", "user/operator", "user:operator"],
  );
  const event = result.events[0]!;
  assert.equal(event.toAgentId, child.id);
  assert.equal(event.timestamp, undefined);
  assert.equal(event.timeBasis, "unknown");
  assert.equal(event.delivery, undefined);
  assert.equal(result.coverage.status, "partial");
  assert.ok(result.coverage.issues.includes("missing_timestamp"));
  const userAgent = result.agents.find((agent) => agent.id === event.fromAgentId)!;
  assert.equal(userAgent.parentAgentId, undefined);
  assert.equal(userAgent.status, undefined);
});

test("canonical raw source prefers recipient incoming and parent steering over relay and send", () => {
  const body = "An ordinary agent message.";
  const sender = source("main", [
    {
      type: "message",
      id: "call-entry",
      message: {
        role: "assistant",
        timestamp: 100,
        content: [
          {
            type: "toolCall",
            id: "send-call",
            name: "write",
            arguments: { path: "agent://Worker", content: body },
          },
        ],
      },
    },
    {
      type: "message",
      id: "send-entry",
      message: {
        role: "toolResult",
        toolName: "write",
        toolCallId: "send-call",
        timestamp: 200,
        details: {
          message: {
            op: "send",
            from: "$root",
            to: "Worker",
            receipts: [{ id: "bus-id", to: "Worker", outcome: "injected", ts: 150 }],
          },
        },
      },
    },
  ]);
  const incoming = source("Worker", [
    {
      type: "custom_message",
      id: "incoming-entry",
      customType: "irc:incoming",
      timestamp: 190,
      details: { id: "bus-id", from: "$root", to: "Worker", body },
    },
  ]);
  const steering = source("Worker", [
    user("steering-entry", {
      attribution: "agent",
      steering: true,
      timestamp: 155,
      content: [
        {
          type: "text",
          text: `[Wait interrupted by message]\n<irc from="parent" agent="Main">\n${body}\n</irc>`,
        },
      ],
    }),
  ]);
  const relay = source("main", [
    {
      type: "custom_message",
      id: "relay-entry",
      customType: "irc:relay",
      timestamp: 195,
      details: { id: "bus-id", from: "$root", to: "Worker", body },
    },
  ]);
  for (const history of [
    [sender, incoming, steering, relay],
    [relay, incoming, sender, steering],
    [incoming, sender, relay, steering],
  ]) {
    const result = snapshot(history);
    assert.equal(result.events.length, 1);
    const event = result.events[0]!;
    assert.equal(event.kind, "message");
    // 需求 agent-interactions.md：父 steering 与 irc:incoming 都是 incoming 观察；
    // OMP 父 steering 不另写 incoming，但混合实时/历史观察仍按同级 sourceId 稳定选取。
    assert.equal(event.sourceId, "incoming-entry");
    assert.equal(event.messageId, "bus-id");
    assert.equal(event.timestamp, 150);
    assert.equal(event.timeBasis, "sent");
    assert.equal(event.delivery, "injected");
  }
  assert.equal(snapshot([sender, steering, relay]).events[0]!.sourceId, "steering-entry");
  assert.equal(snapshot([sender, relay]).events[0]!.sourceId, "relay-entry");
  assert.equal(snapshot([sender]).events[0]!.sourceId, "send-entry");
});

test("dispatch, synchronous result, wait and automatic result retain their actual carrier entry IDs", () => {
  const result = snapshot([
    source("main", [
      {
        type: "message",
        id: "task-call-entry",
        message: {
          role: "assistant",
          timestamp: 100,
          content: [
            { type: "toolCall", id: "task-call", name: "task", arguments: { task: "assignment" } },
          ],
        },
      },
      {
        type: "message",
        id: "task-result-entry",
        message: {
          role: "toolResult",
          toolName: "task",
          toolCallId: "task-call",
          timestamp: 200,
          details: {
            results: [{ id: "Worker", assignment: "assignment", resultText: "sync result" }],
          },
        },
      },
      {
        type: "message",
        id: "wait-entry",
        message: {
          role: "toolResult",
          toolName: "wait",
          toolCallId: "wait-call",
          timestamp: 300,
          details: {
            jobs: [
              {
                type: "task",
                agentUrlId: "Worker",
                status: "completed",
                resultText: "wait result",
              },
            ],
          },
        },
      },
      {
        type: "custom_message",
        id: "automatic-entry",
        customType: "async-result",
        timestamp: 400,
        details: {
          jobs: [
            { type: "task", jobId: "job", agentUrlId: "Worker", resultText: "background result" },
          ],
        },
      },
    ]),
  ]);
  assert.deepEqual(
    result.events.map((event) => [event.body, event.kind, event.sourceId]),
    [
      ["assignment", "task_dispatch", "task-result-entry"],
      ["sync result", "task_result", "task-result-entry"],
      ["wait result", "task_result", "wait-entry"],
      ["background result", "task_result", "automatic-entry"],
    ],
  );
  assert.equal(result.events[0]!.timestamp, 100);
  assert.equal(result.events[0]!.timeBasis, "recorded");
});
