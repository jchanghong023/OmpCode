import assert from "node:assert/strict";
import { test } from "node:test";
import { OmpInteractionProxy } from "../src/app/ompInteractionProxy.js";

test("rpc-ui editor 自由文本经现有交互路径返回同一请求", async () => {
  const pending: { interactionId: string; payload: unknown }[] = [];
  const resolved: string[] = [];
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput(params) {
        assert.equal(params.prompt, "补充说明");
        return { action: "accept", freeText: "需要保留旧数据" };
      },
    },
    addPendingInteraction: (interaction) => pending.push(interaction),
    resolvePendingInteraction: (id) => resolved.push(id),
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-1", method: "editor", title: "补充说明" },
    respond: (response) => responses.push(response),
  });

  assert.equal(pending.length, 1);
  assert.deepEqual(
    resolved,
    pending.map((interaction) => interaction.interactionId),
  );
  assert.deepEqual(pending[0]?.payload, {
    kind: "userInput",
    prompt: "补充说明",
    freeText: true,
    answerMode: "text",
    allowCustomInput: true,
    questions: [{ question: "补充说明", header: "补充说明", options: [] }],
  });
  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-1", value: "需要保留旧数据" },
  ]);
});

test("rpc-ui select 投影为 ZCode 既有问答题并保留选项说明", async () => {
  let payload: unknown;
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "accept", optionId: "保留" };
      },
    },
    addPendingInteraction(interaction) {
      payload = interaction.payload;
    },
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: {
      id: "omp-ui-choice",
      method: "select",
      title: "数据处理",
      options: ["保留", "删除"],
      optionDetails: [{ description: "原有数据继续可用" }, {}],
    },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(payload, {
    kind: "userInput",
    prompt: "数据处理",
    freeText: false,
    options: [
      { optionId: "保留", label: "保留" },
      { optionId: "删除", label: "删除" },
    ],
    answerMode: "option",
    allowCustomInput: false,
    questions: [
      {
        question: "数据处理",
        header: "数据处理",
        options: [
          { value: "保留", label: "保留", description: "原有数据继续可用" },
          { value: "删除", label: "删除" },
        ],
      },
    ],
  });
  assert.deepEqual(responses, [
    { type: "extension_ui_response", id: "omp-ui-choice", value: "保留" },
  ]);
});

test("rpc-ui editor 取消按取消回执收口", async () => {
  const responses: unknown[] = [];
  const proxy = new OmpInteractionProxy({
    sessionId: "session-1",
    gateway: {
      emitFrame() {},
      async requestUserInput() {
        return { action: "cancel" };
      },
    },
    addPendingInteraction() {},
    resolvePendingInteraction() {},
    scheduleFlush() {},
  });

  await proxy.handle({
    frame: { id: "omp-ui-2", method: "editor", title: "补充说明" },
    respond: (response) => responses.push(response),
  });

  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "omp-ui-2", cancelled: true }]);
});
