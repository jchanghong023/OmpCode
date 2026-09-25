import assert from "node:assert/strict";
import test from "node:test";
import { parseOmpContextReport } from "../src/domain/ompContextReport.js";
import { ConversationProjection } from "../src/domain/conversationProjection.js";

test("解析 omp /context 的 ANSI 文本、真实 token 分项和容量", () => {
  const report = parseOmpContextReport(`Context window: 1000000 tokens (58% used)
  System prompt    [\u001b[38;5;241m░░░░\u001b[39m] 0%  4500 tokens
  System tools     [░░░░] 1%  11000 tokens
  Messages         [████] 56%  563000 tokens
  Free             [████] 27%  266000 tokens
  Auto-compact buf [████] 15%  150000 tokens`);
  assert.deepEqual(report, {
    contextWindow: 1_000_000,
    entries: [
      { label: "System prompt", tokens: 4500 },
      { label: "System tools", tokens: 11000 },
      { label: "Messages", tokens: 563000 },
      { label: "Free", tokens: 266000 },
      { label: "Auto-compact buf", tokens: 150000 },
    ],
  });
});

test("无法识别或没有分项的输出不冒充上下文报告", () => {
  assert.equal(parseOmpContextReport("Fake help output"), null);
  assert.equal(parseOmpContextReport("Context window: 1000000 tokens (0% used)"), null);
});

test("旧容量分项不能混入新模型总量；新总量替换会清除旧分项", () => {
  const projection = new ConversationProjection("context-session");
  const report = { contextWindow: 200_000, entries: [{ label: "Messages", tokens: 500 }] };
  projection.setContextWindow(500, 1_000_000, report);
  assert.equal(projection.stateSnapshot.usage.contextWindow?.details, undefined);
  projection.setContextWindow(500, 200_000, report);
  assert.deepEqual(projection.stateSnapshot.usage.contextWindow?.details?.entries, report.entries);
  projection.setContextWindow(600, 200_000);
  assert.equal(projection.stateSnapshot.usage.contextWindow?.details, undefined);
});
