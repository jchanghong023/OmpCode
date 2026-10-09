import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOmpInteractionContent } from "../src/app-shell/ompInteractionContentSummary.js";

// 真实隔离 GLM 冷恢复任务结果的原始格式；技术标记只在 fixture 原文中存在。
const screenshotBody = `<task-result id="InteractionAlpha" agent="interaction-test" status="completed" duration="35.2s">

<output>
{
  "gamma_received_marker": "OMP_INTERACTIONS_20261008_9f930df7_V3_GAMMA_TO_ALPHA",
  "gamma_result": "GAMMA_DONE",
  "messages_sent": [
    "OMP_INTERACTIONS_20261008_9f930df7_V3_ALPHA_TO_MAIN -> agent://Main (delivered)",
    "OMP_INTERACTIONS_20261008_9f930df7_V3_ALPHA_TO_BETA -> agent://InteractionBeta (delivered)"
  ],
  "main_received_marker": "OMP_INTERACTIONS_20261008_9f930df7_V3_MAIN_TO_ALPHA",
  "status": "ALPHA_DONE"
}
</output>
</task-result>

InteractionAlpha is now idle — message it via \`write agent://InteractionAlpha\` to follow up; transcript at history://InteractionAlpha`;

test("自动送达与 wait 的 meta 包装默认只显示结果字段，原始协调提示仍可展开", () => {
  const wrapped =
    '<task-result id="Alpha" status="completed" duration="2s">\n<meta lines="1" size="20B" />\n<output>{"result":"ready"}</output>\n</task-result>';
  const body = `<system-notice>\nBackground job Alpha has completed. Resume your work using the result below.\n${wrapped}\n\nAlpha is now idle — message it via agent://Alpha\n</system-notice>`;
  for (const input of [wrapped, body]) {
    const summary = summarizeOmpInteractionContent({ kind: "task_result", body: input });
    assert.equal(summary.body, input);
    assert.equal(summary.summary, "");
    assert.deepEqual(
      summary.fields.map(({ type, value }) => ({ type, value })),
      [
        { type: "status", value: "completed" },
        { type: "duration", value: "2s" },
        { type: "result", value: "ready" },
      ],
    );
    assert.doesNotMatch(JSON.stringify(summary.fields), /Resume your work|agent:\/\/|<meta/u);
  }
});

test("real task-result extracts execution status, duration, result, child result and reported send count", () => {
  const view = summarizeOmpInteractionContent({ kind: "task_result", body: screenshotBody });
  assert.equal(view.body, screenshotBody);
  assert.equal(view.recognized, true);
  assert.equal(view.structured, true);
  assert.equal(view.summary, "");
  assert.deepEqual(
    view.fields.map(({ type, value }) => ({ type, value })),
    [
      { type: "status", value: "completed" },
      { type: "duration", value: "35.2s" },
      { type: "result", value: "ALPHA_DONE" },
      { type: "child_result", value: "GAMMA_DONE" },
      { type: "reported_message_count", value: "2" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(view.fields),
    /OMP_INTERACTIONS|agent:\/\/|history:\/\/|delivered/u,
  );
});

test("extraction follows generic keys and never special-cases particular test marker content", () => {
  const first = summarizeOmpInteractionContent({ kind: "task_result", body: screenshotBody });
  const changed = summarizeOmpInteractionContent({
    kind: "task_result",
    body: screenshotBody.replaceAll(/OMP_INTERACTIONS[^"\n]*/gu, "a different arbitrary trace"),
  });
  assert.deepEqual(changed.fields, first.fields);
  const other = summarizeOmpInteractionContent({
    kind: "task_result",
    body: JSON.stringify({
      result: "ready",
      delta_result: "verified",
      id: "hidden",
      trace: "hidden",
      arbitrary_marker: "hidden",
      messages_sent: 3,
    }),
  });
  assert.deepEqual(
    other.fields.map(({ type, value }) => ({ type, value })),
    [
      { type: "result", value: "ready" },
      { type: "child_result", value: "verified" },
      { type: "reported_message_count", value: "3" },
    ],
  );
});

test("standard summary/result/output is deterministic, prioritizes summary and does not repeat it", () => {
  for (const data of [
    { summary: "concise", result: "later", output: "last" },
    { result: { output: "concise" } },
    { output: "concise" },
  ]) {
    const view = summarizeOmpInteractionContent({ kind: "message", body: JSON.stringify(data) });
    assert.equal(view.fields.find((field) => field.type === "result")?.value, "concise");
    assert.equal(view.summary, "");
    assert.equal(view.recognized, true);
  }
});

test("unknown JSON has a field-count hint without exposing technical payload or inventing meaning", () => {
  const body = '{"trace_id":"hidden","marker":"hidden","arbitrary":{"value":99}}';
  const view = summarizeOmpInteractionContent({ kind: "task_result", body });
  assert.equal(view.recognized, false);
  assert.equal(view.structured, true);
  assert.equal(view.summary, "");
  assert.equal(view.body, body);
  assert.deepEqual(
    view.fields.map(({ type, value }) => ({ type, value })),
    [{ type: "structured_count", value: "3" }],
  );
  const wrapped = summarizeOmpInteractionContent({
    kind: "task_result",
    body: `<task-result status="completed" duration="1s"><output>${body}</output></task-result>`,
  });
  assert.equal(wrapped.fields.find((field) => field.type === "structured_count")?.value, "3");
});

test("ordinary short messages remain exact while long Unicode text is bounded and expandable", () => {
  const short = "  结果已核对。\n下一步请处理边界。  ";
  const view = summarizeOmpInteractionContent({ kind: "message", body: short });
  assert.equal(view.summary, short);
  assert.equal(view.truncated, false);
  assert.deepEqual(view.fields, []);
  const body = "🌟长正文".repeat(100);
  const long = summarizeOmpInteractionContent({ kind: "message", body });
  assert.ok(Array.from(long.summary).length <= 240);
  assert.ok(long.summary.endsWith("…"));
  assert.equal(long.truncated, true);
  assert.equal(long.body, body);
});

test("wrapped failed JSON exposes the real reason before a generic summary and keeps ordinary priorities", () => {
  const data = {
    summary: "读取未完成",
    message: "文件不存在",
    error: "ENOENT: no such file or directory",
  };
  const body = `<task-result status="failed" duration="0.2s"><output>${JSON.stringify(data)}</output></task-result>`;
  const view = summarizeOmpInteractionContent({ kind: "task_result", body });
  assert.equal(view.fields.find((field) => field.type === "result")?.value, data.error);
  assert.equal(view.fields.find((field) => field.type === "status")?.value, "failed");
  assert.equal(view.body, body);
  assert.equal(
    summarizeOmpInteractionContent({ kind: "message", body: JSON.stringify(data) }).fields.find(
      (field) => field.type === "result",
    )?.value,
    data.summary,
  );
  const messageOnly = summarizeOmpInteractionContent({
    kind: "task_result",
    body: '<task-result status="failed"><output>{"message":"文件不存在"}</output></task-result>',
  });
  assert.equal(messageOnly.fields.find((field) => field.type === "result")?.value, "文件不存在");
});

test("unknown wrapped JSON retains an output field-count hint in addition to status and duration", () => {
  const body =
    '<task-result status="completed" duration="2s"><output>{"unrecognized":{"count":42},"trace_id":"hidden"}</output></task-result>';
  const view = summarizeOmpInteractionContent({ kind: "task_result", body });
  assert.deepEqual(
    view.fields.map(({ type, value }) => ({ type, value })),
    [
      { type: "status", value: "completed" },
      { type: "duration", value: "2s" },
      { type: "structured_count", value: "2" },
    ],
  );
  assert.equal(view.summary, "");
  assert.equal(view.body, body);
});

test("malformed wrapper and JSON fall back to safe literal text with no inferred metadata", () => {
  for (const body of [
    '<task-result status="completed"><output>{broken</task-result>',
    '<task-result status="completed" status="failed"><output>ok</output></task-result>',
    '{"result":not-json}',
    '<task-result duration="35.2s"><output>unclosed',
  ]) {
    const view = summarizeOmpInteractionContent({ kind: "task_result", body });
    assert.equal(view.body, body);
    assert.equal(view.recognized, false);
    assert.equal(view.summary, body);
    assert.deepEqual(view.fields, []);
  }
});

test("plain wrapped output drops tool footer and bounds all field values without altering original", () => {
  const body =
    '<task-result status="completed" duration="2.1s"><output>已完成读取和核对。</output></task-result>\nwrite agent://Worker';
  const view = summarizeOmpInteractionContent({ kind: "task_result", body });
  assert.equal(view.summary, "已完成读取和核对。");
  assert.equal(view.body, body);
  const long = summarizeOmpInteractionContent({
    kind: "task_result",
    body: JSON.stringify({
      result: "x".repeat(500),
      messages_sent: ["one"],
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`child${i}_result`, "result"])),
    }),
  });
  assert.ok(long.fields.length <= 5);
  assert.ok(long.fields.every((field) => Array.from(field.value).length <= 160));
  assert.equal(long.fields.find((field) => field.type === "result")?.truncated, true);
  assert.equal(long.fields.find((field) => field.type === "reported_message_count")?.value, "1");
});

test("scripts and XML entities remain text and are never interpreted during extraction", () => {
  const literal = "<script>globalThis.ompSummaryShouldNeverExecute = true</script>";
  const view = summarizeOmpInteractionContent({ kind: "message", body: literal });
  assert.equal(view.summary, literal);
  const wrapped = summarizeOmpInteractionContent({
    kind: "task_result",
    body: `<task-result status="completed"><output>${JSON.stringify({ result: literal })}</output></task-result>`,
  });
  assert.equal(wrapped.fields.find((field) => field.type === "result")?.value, literal);
  assert.equal("ompSummaryShouldNeverExecute" in globalThis, false);
  const entities = summarizeOmpInteractionContent({
    kind: "task_result",
    body: '<task-result status="completed"><output>&lt;script&gt;literal&lt;/script&gt;</output></task-result>',
  });
  assert.equal(entities.summary, "&lt;script&gt;literal&lt;/script&gt;");
});
