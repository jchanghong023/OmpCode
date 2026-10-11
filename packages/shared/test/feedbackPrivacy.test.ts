import assert from "node:assert/strict";
import test from "node:test";
import { redactFeedbackText } from "../src/feedbackPrivacy.js";

test("裸认证值和常见密钥不依赖字段名也会脱敏", () => {
  const secrets = [
    "bearer-private-value",
    "dXNlcjpwYXNz",
    "sk-privatekey123456",
    "rk-privatekey123456",
    "pk-privatekey123456",
  ];
  const redacted = redactFeedbackText(
    `connection failed: Bearer ${secrets[0]} Basic ${secrets[1]} ${secrets.slice(2).join(" ")}`,
  );
  assert.match(redacted, /connection failed/);
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /Bearer \[REDACTED\] Basic \[REDACTED\]/);
});

test("诊断模式隐藏输入、审批和原始帧正文，保留关联与失败元数据", () => {
  const bodyKeys = [
    "prompt",
    "body",
    "params",
    "questions",
    "answers",
    "options",
    "selectedOptions",
    "customInput",
    "prefill",
    "attachments",
    "images",
    "preview",
    "rawFrame",
    "frames",
    "originalText",
    "freeText",
  ];
  const record = {
    event: "omp_rpc_failed",
    requestId: "host-7",
    inputId: "input-a",
    success: false,
    elapsedMs: 0,
    code: "ECONNREFUSED",
    nested: Object.fromEntries(bodyKeys.map((key) => [key, { text: "private-user-body" }])),
  };
  const redacted = JSON.parse(redactFeedbackText(JSON.stringify(record), { diagnostic: true }));
  assert.deepEqual({ ...redacted, nested: undefined }, { ...record, nested: undefined });
  for (const key of bodyKeys) assert.equal(redacted.nested[key], "[REDACTED]");
  assert.equal(JSON.stringify(redacted).includes("private-user-body"), false);
});

test("前缀混合日志中的审批正文与截断帧不能逃逸，普通反馈不隐藏非敏感正文", () => {
  const diagnostic = redactFeedbackText(
    'rpc failed {"requestId":"host-8","customInput":"private-custom-body"}\nrawFrame={"value":"private-frame-body"',
    { diagnostic: true },
  );
  assert.match(diagnostic, /host-8/);
  assert.equal(diagnostic.includes("private-custom-body"), false);
  assert.equal(diagnostic.includes("private-frame-body"), false);
  const feedback = JSON.parse(
    redactFeedbackText('{"body":"feedback-detail","authorization":"private-auth"}'),
  );
  assert.equal(feedback.body, "feedback-detail");
  assert.equal(feedback.authorization, "[REDACTED]");
});
