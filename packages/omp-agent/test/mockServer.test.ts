import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MOCK_MODEL_ID,
  MOCK_MODEL_SELECTOR,
  MOCK_PROVIDER,
  startMockModelServer,
} from "./fixtures/ompMockServer.mjs";

type WireMessage = { role: string; content: unknown };
type WireFrame = {
  type: string;
  index: number;
  delta: {
    type: string;
    text: string;
    thinking: string;
    signature: string;
    partial_json: string;
    stop_reason: string;
  };
  content_block: { type: string; id: string; name: string; input: unknown };
  message: { id: string };
  usage: Record<string, number>;
  error: { type: string; message: string };
};
async function request(baseUrl: string, messages: WireMessage[], extra = {}) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MOCK_MODEL_ID, messages, stream: true, ...extra }),
  });
}
async function frames(response: Response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const wire = await response.text();
  return wire
    .trim()
    .split("\n\n")
    .map((frame) => {
      const lines = frame.split("\n");
      const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const value: WireFrame = JSON.parse(
        lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null",
      );
      assert.equal(value.type, name);
      return value;
    });
}
function output(events: WireFrame[]) {
  return events
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");
}
function frameAt(events: WireFrame[], index: number, type: string): WireFrame {
  const event = events.at(index);
  assert.ok(event, `HTTP response must contain ${type} at index ${index}`);
  assert.equal(event.type, type);
  return event;
}
function toolCall(events: WireFrame[]) {
  const start = events.find((event) => event.content_block?.type === "tool_use");
  assert.ok(start, "HTTP response must issue a tool");
  const args = events
    .filter((event) => event.index === start.index && event.delta?.type === "input_json_delta")
    .map((event) => event.delta.partial_json)
    .join("");
  return { ...start.content_block, input: JSON.parse(args) };
}
function user(prompt: string): WireMessage {
  return { role: "user", content: prompt };
}
function assistant(call: unknown): WireMessage {
  return { role: "assistant", content: [call] };
}
function result(id: string, content: string, isError = false): WireMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }],
  };
}

// Exact runtime-owned template from OMP's prompts/system/date-cwd-reminder.md.
// Array text blocks flatten to the observed single-newline write request;
// string content uses the injector's two-newline separator.
const OMP_REMINDER =
  "<system-reminder>\nToday: 2026-10-18; current working directory: 'F:/Temp/User/zcode-real-e2e-g5C8Ag/workspace'. Do not repeat this information in your reply.\n</system-reminder>";

test("HTTP SSE preserves text/thinking/signature/tool IDs/JSON, response headers, usage and length terminal", async () => {
  const server = await startMockModelServer({
    responses: [
      {
        responseId: "msg_explicit",
        responseHeaders: { "X-Mock": "metadata" },
        responseRequestId: "request-explicit",
        content: [
          "text",
          { type: "thinking", thinking: "reasoning", thinkingSignature: "signature" },
          { type: "toolCall", id: "tool-fixed", name: "read", arguments: { path: "x" } },
          { type: "toolCall", name: "write", arguments: '{"path":"y"}' },
        ],
        stopReason: "length",
        usage: { input: 7, output: 11, cacheRead: 3, cacheWrite: 5 },
      },
    ],
  });
  try {
    const response = await request(server.baseUrl, [user("custom")]);
    assert.equal(response.headers.get("x-mock"), "metadata");
    assert.equal(response.headers.get("request-id"), "request-explicit");
    const events = await frames(response);
    assert.equal(frameAt(events, 0, "message_start").message.id, "msg_explicit");
    assert.equal(output(events), "text");
    const thinking = events.find((event) => event.delta?.type === "thinking_delta");
    assert.ok(thinking, "HTTP response must contain a thinking delta");
    assert.equal(thinking.delta.thinking, "reasoning");
    const signature = events.find((event) => event.delta?.type === "signature_delta");
    assert.ok(signature, "HTTP response must contain a signature delta");
    assert.equal(signature.delta.signature, "signature");
    assert.deepEqual(
      events
        .filter((event) => event.content_block?.type === "tool_use")
        .map((event) => event.content_block.id),
      ["tool-fixed", "mock-tc-1"],
    );
    assert.deepEqual(toolCall(events).input, { path: "x" });
    assert.ok(events.some((event) => event.delta?.partial_json === '{"path":"y"}'));
    const terminal = frameAt(events, -2, "message_delta");
    assert.deepEqual(terminal.usage, {
      input_tokens: 7,
      output_tokens: 11,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
    });
    assert.equal(terminal.delta.stop_reason, "max_tokens");
    frameAt(events, -1, "message_stop");
    assert.equal(server.calls[0].context.messages[0].content, "custom");
    server.assertHealthy();
  } finally {
    await server.close();
  }
});

test("HTTP scripts support sync/async iterables and asynchronous context handlers without shared instance state", async () => {
  const first = await startMockModelServer({
    responses: (function* () {
      yield { content: ["array-like-1"] };
      yield { content: ["array-like-2"] };
    })(),
    handler: async (context: { messages: WireMessage[] }) => ({
      content: [`fallback:${context.messages[0].content}`],
    }),
  });
  const second = await startMockModelServer({
    responses: (async function* () {
      yield { content: ["isolated"] };
    })(),
  });
  try {
    assert.notEqual(first.baseUrl, second.baseUrl);
    assert.equal(output(await frames(await request(first.baseUrl, [user("A")]))), "array-like-1");
    assert.equal(output(await frames(await request(second.baseUrl, [user("B")]))), "isolated");
    assert.equal(output(await frames(await request(first.baseUrl, [user("C")]))), "array-like-2");
    assert.equal(output(await frames(await request(first.baseUrl, [user("D")]))), "fallback:D");
    assert.equal(first.calls.length, 3);
    assert.equal(second.calls.length, 1);
    first.assertHealthy();
    second.assertHealthy();
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("OMP-framed WRITE completes only after the matching successful HTTP tool_result; fixture never writes workspace output", async () => {
  const server = await startMockModelServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-mock-config-"));
  try {
    const prompt: WireMessage = {
      role: "user",
      content: [
        { type: "text", text: OMP_REMINDER },
        { type: "text", text: "ZCODE_MOCK_WRITE greeting-real.txt" },
      ],
    };
    const events = await frames(await request(server.baseUrl, [prompt]));
    const call = toolCall(events);
    assert.equal(call.name, "write");
    assert.deepEqual(call.input, { path: "greeting-real.txt", content: "real omp wrote this\n" });
    assert.equal(output(events), "");
    assert.equal(frameAt(events, -2, "message_delta").delta.stop_reason, "tool_use");
    // Transport unit test supplies a wire tool result. Actual execution/disk and
    // approval evidence belongs to real-omp.e2e and the hidden GUI consumer.
    const done = await frames(
      await request(server.baseUrl, [
        prompt,
        assistant(call),
        result(
          call.id,
          "[greeting-real.txt#DDD0]\nSuccessfully wrote 20 bytes to greeting-real.txt",
        ),
      ]),
    );
    assert.equal(output(done), "OMP_MOCK_WRITE_DONE");
    await server.writeConfig(root);
    assert.deepEqual((await readdir(root)).sort(), ["agent"]);
    const models = JSON.parse(await readFile(path.join(root, "agent", "models.yml"), "utf8"));
    assert.equal(models.providers[MOCK_PROVIDER].baseUrl, server.baseUrl);
    assert.equal(models.providers[MOCK_PROVIDER].compat.requiresToolResultId, true);
    const config = JSON.parse(await readFile(path.join(root, "agent", "config.yml"), "utf8"));
    assert.ok(Object.values(config.modelRoles).every((value) => value === MOCK_MODEL_SELECTOR));
    assert.equal(config.task.agentModelOverrides.task, MOCK_MODEL_SELECTOR);
    assert.equal(config.async.enabled, false);
    assert.equal(config.task.batch, false);
    assert.equal(config.task.structured, false);
    assert.equal(config.advisor.enabled, false);
    assert.deepEqual(config.goal.continuationModes, []);
    await server.writeConfig(root, { defaultModel: "zcode-missing/absent-model" });
    const missing = JSON.parse(await readFile(path.join(root, "agent", "config.yml"), "utf8"));
    assert.equal(missing.modelRoles.default, "zcode-missing/absent-model");
    assert.equal(missing.modelRoles.task, MOCK_MODEL_SELECTOR);
    server.assertHealthy();
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OMP-framed ASK and TASK distinguish the observed task-label envelope from genuine child execution", async () => {
  const server = await startMockModelServer();
  try {
    const ask = user(`${OMP_REMINDER}\n\nZCODE_MOCK_ASK ASK1`);
    const askCall = toolCall(await frames(await request(server.baseUrl, [ask])));
    assert.equal(askCall.name, "ask");
    assert.deepEqual(askCall.input.questions, [
      {
        id: "mock-answer",
        question: "Choose the mock answer for ASK1",
        options: [{ label: "Mock answer A" }, { label: "Mock answer B" }],
      },
    ]);
    assert.equal(
      output(
        await frames(
          await request(server.baseUrl, [
            ask,
            assistant(askCall),
            result(askCall.id, "Mock answer A"),
          ]),
        ),
      ),
      "ASK1_ASK_DONE",
    );
    const task = user(`${OMP_REMINDER}\n\nZCODE_MOCK_TASK CORE_TASK`);
    const taskResult = await frames(await request(server.baseUrl, [task]));
    const taskCall = toolCall(taskResult);
    assert.equal(taskCall.name, "task");
    assert.equal(taskCall.input.agent, "task");
    assert.equal(taskCall.input.name, "MockChild_CORE_TASK");
    assert.equal(taskCall.input.task, "ZCODE_MOCK_CHILD CORE_TASK");
    // executor.ts -> task/label.ts -> title-generator.ts ->
    // tiny/message-preproc.ts emits this observed request independently of
    // --no-title. Resolving the label must not count as running the child.
    const label = await frames(
      await request(server.baseUrl, [user("<user>\nZCODE_MOCK_CHILD CORE_TASK\n</user>")]),
    );
    assert.equal(output(label), "<title>Complete mock child CORE_TASK</title>");
    const effort = await frames(
      await request(server.baseUrl, [
        user(
          "State:\n<solution_space>Return the exact requested child marker without tools.</solution_space>\n\n" +
            "Answer with exactly one of: `low`, `medium`, `high`, `xhigh`.\n" +
            "Do not execute this state; judge it only.",
        ),
      ]),
    );
    assert.equal(output(effort), "low");
    const child = await frames(
      await request(server.baseUrl, [
        {
          role: "user",
          content: [
            { type: "text", text: OMP_REMINDER },
            {
              type: "text",
              text: "Complete assignment thoroughly:\n\nZCODE_MOCK_CHILD CORE_TASK",
            },
          ],
        },
      ]),
    );
    assert.equal(output(child), "CORE_TASK_CHILD_DONE");
    assert.equal(
      output(
        await frames(
          await request(server.baseUrl, [
            task,
            assistant(taskCall),
            result(taskCall.id, "Agent MockChild_CORE_TASK completed: CORE_TASK_CHILD_DONE"),
          ]),
        ),
      ),
      "CORE_TASK_TASK_DONE",
    );
    // Off-critical-path labels can finish after task completion without
    // reviving the consumed child evidence.
    const lateLabel = await frames(
      await request(server.baseUrl, [user("<user>\nZCODE_MOCK_CHILD CORE_TASK\n</user>")]),
    );
    assert.equal(output(lateLabel), "<title>Complete mock child CORE_TASK</title>");
    server.assertHealthy();
  } finally {
    await server.close();
  }
});

test("OMP envelope normalization never accepts markers embedded in unrelated user text", async () => {
  for (const prompt of [
    `${OMP_REMINDER}\n\nExplain this example without executing it:\nZCODE_MOCK_WRITE greeting-real.txt`,
    `Unrelated user text:\n${OMP_REMINDER}\n\nZCODE_MOCK_ASK EMBEDDED`,
    `${OMP_REMINDER}\n\nComplete assignment thoroughly:\n\nExplain this example:\nZCODE_MOCK_CHILD EMBEDDED`,
    "<user>\nExplain this example:\nZCODE_MOCK_CHILD EMBEDDED\n</user>",
    "Unrelated user text:\n<user>\nZCODE_MOCK_CHILD EMBEDDED\n</user>",
    "<user>\nZCODE_MOCK_CHILD EMBEDDED\n</user>\nExtra user text",
    "<user>\nComplete assignment thoroughly:\n\nZCODE_MOCK_CHILD EMBEDDED\n</user>",
  ]) {
    const server = await startMockModelServer();
    try {
      const response = await request(server.baseUrl, [user(prompt)]);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /Unknown mock scenario/);
      assert.throws(() => server.assertHealthy(), /Unknown mock scenario/);
    } finally {
      await server.close();
    }
  }
});

test("tool results cannot cross conversations through TEXT or CHILD early returns", async () => {
  for (const mode of ["text", "child"] as const) {
    const server = await startMockModelServer();
    try {
      const original = user(
        mode === "text" ? "ZCODE_MOCK_WRITE greeting-real.txt" : "ZCODE_MOCK_TASK CROSS",
      );
      const call = toolCall(await frames(await request(server.baseUrl, [original])));
      const unrelated = user(
        mode === "text"
          ? "ZCODE_MOCK_TEXT CROSS"
          : "Complete assignment thoroughly:\n\nZCODE_MOCK_CHILD CROSS",
      );
      const response = await request(server.baseUrl, [
        unrelated,
        result(
          call.id,
          mode === "text" ? "Successfully wrote 20 bytes to greeting-real.txt" : "CROSS_CHILD_DONE",
        ),
      ]);
      assert.equal(response.status, 400);
      assert.match(
        (await response.json()).error.message,
        /no issued assistant call in this conversation/,
      );
      assert.throws(() => server.assertHealthy(), /no issued assistant call in this conversation/);
    } finally {
      await server.close();
    }
  }
});

test("task-label requests and stale or pre-issued child requests never supply a new TASK invocation's evidence", async () => {
  for (const mode of ["label-only", "pre-issued", "stale", "overlapping"] as const) {
    const server = await startMockModelServer();
    try {
      const prompt = user("ZCODE_MOCK_TASK REUSED");
      const child = user(
        `${OMP_REMINDER}\n\nComplete assignment thoroughly:\n\nZCODE_MOCK_CHILD REUSED`,
      );
      if (mode === "pre-issued") {
        const response = await request(server.baseUrl, [child]);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error.message, /lacks outstanding task/);
      }
      let call = toolCall(await frames(await request(server.baseUrl, [prompt])));
      if (mode === "overlapping") {
        const response = await request(server.baseUrl, [prompt]);
        assert.equal(response.status, 400);
        assert.match(
          (await response.json()).error.message,
          /already has an outstanding invocation/,
        );
        assert.throws(() => server.assertHealthy(), /already has an outstanding invocation/);
        continue;
      }
      if (mode === "label-only") {
        const label = await frames(
          await request(server.baseUrl, [user("<user>\nZCODE_MOCK_CHILD REUSED\n</user>")]),
        );
        assert.equal(output(label), "<title>Complete mock child REUSED</title>");
      }
      if (mode === "stale") {
        assert.equal(
          output(await frames(await request(server.baseUrl, [child]))),
          "REUSED_CHILD_DONE",
        );
        const completed = await frames(
          await request(server.baseUrl, [
            prompt,
            assistant(call),
            result(call.id, "Agent MockChild_REUSED completed: REUSED_CHILD_DONE"),
          ]),
        );
        assert.equal(output(completed), "REUSED_TASK_DONE");
        const stale = await request(server.baseUrl, [child]);
        assert.equal(stale.status, 400);
        assert.match((await stale.json()).error.message, /lacks outstanding task/);
        call = toolCall(await frames(await request(server.baseUrl, [prompt])));
      }
      const response = await request(server.baseUrl, [
        prompt,
        assistant(call),
        result(call.id, "Agent MockChild_REUSED completed: REUSED_CHILD_DONE"),
      ]);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /lacks observed real child completion/);
      assert.throws(() => server.assertHealthy(), /lacks observed real child completion/);
    } finally {
      await server.close();
    }
  }
});

test("WRITE success records require the exact target filename, allowing directory prefixes only", async () => {
  for (const target of [
    "greeting-real.txt",
    "/workspace/greeting-real.txt",
    "C:\\workspace\\greeting-real.txt",
    "greeting-real.txt.bak",
    "/workspace/not-greeting-real.txt",
    "/workspace/greeting-real.txt\nunrelated output",
  ]) {
    const server = await startMockModelServer();
    try {
      const prompt = user("ZCODE_MOCK_WRITE greeting-real.txt");
      const call = toolCall(await frames(await request(server.baseUrl, [prompt])));
      const response = await request(server.baseUrl, [
        prompt,
        assistant(call),
        result(call.id, `Successfully wrote 20 bytes to ${target}`),
      ]);
      if (
        [
          "greeting-real.txt",
          "/workspace/greeting-real.txt",
          "C:\\workspace\\greeting-real.txt",
        ].includes(target)
      ) {
        assert.equal(output(await frames(response)), "OMP_MOCK_WRITE_DONE");
        server.assertHealthy();
      } else {
        assert.equal(response.status, 400);
        assert.match((await response.json()).error.message, /Invalid write tool_result/);
        assert.throws(() => server.assertHealthy(), /Invalid write tool_result/);
      }
    } finally {
      await server.close();
    }
  }
});

test("WRITE snapshot headers must identify exactly the success line's target", async () => {
  for (const [snapshot, target, accepted] of [
    ["greeting-real.txt#DDD0", "greeting-real.txt", true],
    ["/workspace/greeting-real.txt#DDD0", "/workspace/greeting-real.txt", true],
    ["C:\\workspace\\greeting-real.txt#DDD0", "C:\\workspace\\greeting-real.txt", true],
    ["greeting-real.txt.bak#DDD0", "greeting-real.txt", false],
    ["/workspace/not-greeting-real.txt#DDD0", "greeting-real.txt", false],
    ["greeting-real.txt#DDD0", "greeting-real.txt.bak", false],
    ["greeting-real.txt#DDD0", "/workspace/not-greeting-real.txt", false],
    ["/other/greeting-real.txt#DDD0", "/workspace/greeting-real.txt", false],
    ["greeting-real.txt#DDD", "greeting-real.txt", false],
    ["greeting-real.txt#GGGG", "greeting-real.txt", false],
    ["greeting-real.txt#DDD0", "greeting-real.txt\n", false],
    ["greeting-real.txt#DDD0", "greeting-real.txt\nunrelated output", false],
  ] as const) {
    const server = await startMockModelServer();
    try {
      const prompt = user("ZCODE_MOCK_WRITE greeting-real.txt");
      const call = toolCall(await frames(await request(server.baseUrl, [prompt])));
      const response = await request(server.baseUrl, [
        prompt,
        assistant(call),
        result(call.id, `[${snapshot}]\nSuccessfully wrote 20 bytes to ${target}`),
      ]);
      if (accepted) {
        assert.equal(output(await frames(response)), "OMP_MOCK_WRITE_DONE");
        server.assertHealthy();
      } else {
        assert.equal(response.status, 400);
        assert.match((await response.json()).error.message, /Invalid write tool_result/);
        assert.throws(() => server.assertHealthy(), /Invalid write tool_result/);
      }
    } finally {
      await server.close();
    }
  }
});

test("strict unknown/unsupported/exhausted/error requests fail over real HTTP and remain visible to owner", async () => {
  for (const mode of [
    "unknown",
    "unsupported",
    "exhausted",
    "handler",
    "iterator",
    "endpoint",
  ] as const) {
    const server = await startMockModelServer(
      mode === "exhausted"
        ? { responses: [] }
        : mode === "handler"
          ? {
              handler() {
                throw new Error("handler exploded");
              },
            }
          : mode === "iterator"
            ? {
                responses: {
                  [Symbol.asyncIterator]() {
                    return {
                      async next() {
                        throw new Error("iterator exploded");
                      },
                    };
                  },
                },
              }
            : {},
    );
    try {
      const response =
        mode === "endpoint"
          ? await fetch(`${server.baseUrl}/not-messages`)
          : await request(
              server.baseUrl,
              [user(mode === "unknown" ? "unknown request" : "ZCODE_MOCK_TEXT X")],
              mode === "unsupported" ? { model: "external-model" } : {},
            );
      assert.equal(response.status, 400);
      const error = await response.json();
      assert.equal(error.type, "error");
      assert.match(
        error.error.message,
        /Unknown mock scenario|Unsupported mock|no response or handler|exploded/,
      );
      assert.throws(() => server.assertHealthy());
    } finally {
      await server.close();
    }
  }
});

test("missing/unmatched/failed tool results, wrong ask answers and forged child completion cannot succeed", async () => {
  for (const mode of [
    "missing",
    "unmatched",
    "failed",
    "write-output",
    "ask-answer",
    "child-unobserved",
  ] as const) {
    const server = await startMockModelServer();
    try {
      const prompt = user(
        mode === "ask-answer"
          ? "ZCODE_MOCK_ASK BAD"
          : mode === "child-unobserved"
            ? "ZCODE_MOCK_TASK BAD"
            : "ZCODE_MOCK_WRITE greeting-real.txt",
      );
      const call = toolCall(await frames(await request(server.baseUrl, [prompt])));
      const messages = [prompt, assistant(call)];
      if (mode !== "missing")
        messages.push(
          result(
            mode === "unmatched" ? "unknown-id" : call.id,
            mode === "ask-answer"
              ? "Mock answer B"
              : mode === "child-unobserved"
                ? "BAD_CHILD_DONE"
                : mode === "write-output"
                  ? "not written"
                  : "Successfully wrote 20 bytes to greeting-real.txt",
            mode === "failed",
          ),
        );
      const response = await request(server.baseUrl, messages);
      assert.equal(response.status, 400);
      assert.match(
        (await response.json()).error.message,
        /Missing matching|Unmatched|Failed write|Invalid write|Invalid ask|lacks observed real child/,
      );
      assert.throws(() => server.assertHealthy());
    } finally {
      await server.close();
    }
  }
});

test("HTTP transports explicit stop/error/aborted and throw outcomes without converting failures to successful message_stop", async () => {
  for (const reason of ["stop", "toolUse", "error", "aborted", "throw"] as const) {
    const server = await startMockModelServer({
      handler:
        reason === "throw"
          ? { throw: new Error("script exploded") }
          : { content: ["partial"], stopReason: reason, errorMessage: "terminal problem" },
    });
    try {
      const events = await frames(await request(server.baseUrl, [user("custom")]));
      if (reason === "error" || reason === "aborted" || reason === "throw") {
        const terminal = frameAt(events, -1, "error");
        assert.equal(
          events.some((event) => event.type === "message_stop"),
          false,
        );
        assert.match(terminal.error.message, /terminal problem|script exploded/);
        assert.equal(terminal.error.type, reason === "aborted" ? "request_aborted" : "api_error");
      } else {
        assert.equal(
          frameAt(events, -2, "message_delta").delta.stop_reason,
          reason === "toolUse" ? "tool_use" : "end_turn",
        );
        frameAt(events, -1, "message_stop");
      }
      server.assertHealthy();
    } finally {
      await server.close();
    }
  }
});

test("disconnect during delayed HTTP response aborts copied engine; close owns active connections", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const server = await startMockModelServer({
    handler(_context: unknown, options: { signal: AbortSignal }) {
      entered.resolve(options.signal);
      return { delayMs: 60_000, content: ["must not complete"] };
    },
  });
  const controller = new AbortController();
  try {
    const pending = fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ model: MOCK_MODEL_ID, messages: [user("cancel")], stream: true }),
    });
    const signal = await entered.promise;
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await aborted;
    assert.equal(signal.aborted, true);
    server.assertHealthy();
  } finally {
    await server.close();
  }
  // A new instance is isolated from the cancelled response/script queue.
  const fresh = await startMockModelServer({ responses: [{ content: ["fresh"] }] });
  try {
    assert.equal(output(await frames(await request(fresh.baseUrl, [user("new")]))), "fresh");
    fresh.assertHealthy();
  } finally {
    await fresh.close();
  }
});

test("server close cancels active delayed requests and is idempotent without leaving a live listener", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const server = await startMockModelServer({
    handler(_context: unknown, options: { signal: AbortSignal }) {
      entered.resolve(options.signal);
      return { delayMs: 60_000, content: ["never"] };
    },
  });
  const pending = request(server.baseUrl, [user("close")]);
  const failed = assert.rejects(pending, /fetch failed|socket|closed/i);
  try {
    const signal = await entered.promise;
    await server.close();
    await failed;
    assert.equal(signal.aborted, true);
    server.assertHealthy();
    await assert.rejects(request(server.baseUrl, [user("after-close")]), /fetch failed|connect/i);
  } finally {
    await server.close();
  }
});

test("default text scenario streams deterministic marker/thinking with observable cancellable initial delay", async () => {
  const server = await startMockModelServer();
  try {
    const started = performance.now();
    const events = await frames(
      await request(server.baseUrl, [user("ZCODE_MOCK_TEXT TEXT_MARKER")]),
    );
    assert.ok(performance.now() - started >= 900);
    assert.equal(output(events), "TEXT_MARKER");
    assert.ok(events.some((event) => event.delta?.type === "thinking_delta"));
    const terminal = frameAt(events, -2, "message_delta");
    assert.equal(terminal.usage.input_tokens, 16);
    assert.equal(terminal.usage.output_tokens, 8);
    server.assertHealthy();
  } finally {
    await server.close();
  }
});
