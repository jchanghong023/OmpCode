import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeOmpInteractionContent } from "../src/app-shell/ompInteractionContentSummary.js";

test("取消与失败的原因元数据不导致任务摘要泄漏 XML 或恢复提示", () => {
  for (const reason of [
    "<abort-reason>Stopped — the agent is still live with its full context; message it via `write agent://child` to resume instead of redoing the work.</abort-reason>",
    "<error>Execution failed</error>",
  ]) {
    const body = `<system-notice>\nBackground job child has completed. Resume your work using the result below.\n<task-result id="child" agent="task" status="cancelled" duration="389ms">\n${reason}\n<output>\n{"aborted":true,"error":"Actual failure"}\n</output>\n</task-result>\n\nchild was aborted — transcript at history://child\n</system-notice>`;
    const summary = summarizeOmpInteractionContent({ kind: "task_result", body });
    assert.equal(summary.recognized, true);
    assert.equal(summary.structured, true);
    assert.equal(summary.summary, "");
    assert.deepEqual(
      summary.fields.map(({ type, value }) => ({ type, value })),
      [
        { type: "status", value: "cancelled" },
        { type: "duration", value: "389ms" },
        { type: "result", value: "Actual failure" },
      ],
    );
    assert.equal(summary.body, body);
  }
});

test("未知的任务包装子元素不被误认成结构化结果", () => {
  const body =
    '<task-result status="cancelled"><unknown>reason</unknown><output>text</output></task-result>';
  const summary = summarizeOmpInteractionContent({ kind: "task_result", body });
  assert.equal(summary.recognized, false);
  assert.equal(summary.body, body);
});
