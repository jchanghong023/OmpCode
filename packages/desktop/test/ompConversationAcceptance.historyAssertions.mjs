// 从 ompConversationAcceptance.assertions.mjs 机械迁移（文件超 400 行拆分）；断言逻辑零变更。
import assert from "node:assert/strict";
import { C, promptOf, textOf } from "./ompConversationAcceptance.fixture.mjs";
import { assertPersistedTools } from "./ompConversationAcceptance.tools.mjs";

export function assertPersistedHistory(saved, manifest, continued = false) {
  const { records } = saved;
  const assistants = records.filter((record) => record.role === "assistant");
  const users = records.filter((record) => record.role === "user");
  const combined = (message) => textOf(message.content);
  for (const marker of [
    "STREAM_PREFIX_VISIBLE",
    "STREAM_BODY_GREW_BEFORE_TERMINAL",
    "STREAM_DONE",
    "AFTER_STOP_SAME_SESSION_DONE",
    "GUIDE_INPUT_1_DONE",
    "GUIDE_INPUT_2_DONE",
    "GUIDE_INPUT_3_DONE",
    "GUIDE_INPUT_CONSUMED",
    "HELLO_1_DONE",
    "HELLO_2_DONE",
    "HELLO_3_DONE",
    "AFTER_QUEUE_STOP_DONE",
    "AFTER_QUEUE_FAIL_DONE",
    "ATTACHMENTS_BYTES_ORDER_CONFIRMED",
    "PDF_RETAINED_DRAFT_SENT",
    "CONVERSATION_CHAIN_COMPLETE",
    "CONVERSATION_REAL_TOOL_FAILURE_CONFIRMED",
    "CONVERSATION_LIVE_COMPLETE",
  ]) {
    assert.equal(
      assistants.filter((message) => combined(message).includes(marker)).length,
      1,
      `Persist ${marker} exactly once`,
    );
  }
  assert.equal(users.filter((message) => promptOf(message.content) === "hello").length, 3);
  const guides = users.filter((message) => promptOf(message.content) === C.guideInput);
  assert.equal(guides.length, 3, "Persist all three independent guide inputs exactly once");
  assert.ok(
    guides.every((message) => message.steering === true),
    "Preserve native guide identity",
  );
  for (const marker of [
    "STOP_LATE_MUST_NOT_REVIVE",
    "QUEUE_STOP_LATE_MUST_NOT_REVIVE",
    "PDF_MUST_NOT_REACH_MODEL",
  ])
    assert.equal(
      records.some((message) => combined(message).includes(marker)),
      false,
    );
  for (const prefix of ["STOP_PREFIX_VISIBLE", "QUEUE_STOP_PREFIX"]) {
    const stopped = assistants.filter((message) => combined(message).includes(prefix));
    assert.equal(stopped.length, 1);
    assert.equal(
      stopped[0].stopReason,
      "aborted",
      "Stopping must persist an interrupted, not successful turn",
    );
  }
  const failed = assistants.filter((message) => combined(message).includes("QUEUE_FAIL_PREFIX"));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stopReason, "error");
  assert.match(failed[0].errorMessage, /CONVERSATION_QUEUE_PROVIDER_FAILURE/u);
  assertPersistedTools(records, manifest);
  assert.equal(
    users.filter((message) => promptOf(message.content) === C.chain).length,
    1,
    "Three dependent tools must originate from exactly one GUI user submission",
  );
  assert.equal(
    users.filter((message) => promptOf(message.content) === C.pdfDraft).length,
    1,
    "Rejected PDF submit must not create a phantom user turn before the retained draft is resubmitted",
  );
  assert.equal(
    users.filter((message) => promptOf(message.content) === C.recovery).length,
    continued ? 1 : 0,
  );
  assert.equal(
    assistants.filter((message) =>
      combined(message).includes("CONVERSATION_COLD_CONTINUATION_DONE"),
    ).length,
    continued ? 1 : 0,
  );
}
