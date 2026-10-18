import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { attachmentInput } from "../../omp-agent/test/fixtures/ompAttachmentInput.mjs";
import { C, latestInput, textOf } from "./ompConversationAcceptance.fixture.mjs";
import {
  assertPersistedHistory,
  diagnostics,
  failureOutput,
  failureTool,
  idle,
  poll,
  queued,
  reply,
  sameTask,
  stored,
  submit,
  upload,
} from "./ompConversationAcceptance.assertions.mjs";
import {
  assertChainFiles,
  assertChainRows,
  assertPersistedTools,
  assertProtocolTools,
  chainHttpEvidence,
} from "./ompConversationAcceptance.tools.mjs";

export async function exerciseConversationAttachments({ page, runtime, manifest, screenshot }) {
  await page.getByTestId("v4-composer-input").fill(C.attach);
  await upload(
    page,
    manifest.files.slice(0, 3).map((file) => file.path),
  );
  // 附件 chip 有两种真实形态：图片是缩略图（文件名只落在 <img alt>，chip 内没有可读文本），
  // 普通文件才显示文件名文本。隔离 GUI 实测 first.png/second.jpg 的 chip.innerText 为空，
  // 因此按两种产品真实渲染取并集定位，保证草稿确实携带这三个真实附件。
  const draftAttachments = page
    .getByTestId("v4-composer")
    .locator("[data-composer-attachment-kind]");
  for (const file of manifest.files.slice(0, 3)) {
    const chip = draftAttachments
      .filter({ has: page.getByAltText(file.name, { exact: true }) })
      .or(draftAttachments.filter({ hasText: file.name }));
    await chip.first().waitFor({ state: "visible" });
  }
  await page.getByTestId("v4-composer-send").click();
  await reply(page, "ATTACHMENTS_BYTES_ORDER_CONFIRMED");
  await idle(page);
  const attachmentCalls = (await diagnostics(runtime)).calls.filter(
    (call) => attachmentInput(latestInput(call.messages)?.content).prompt === C.attach,
  );
  assert.equal(attachmentCalls.length, 1);
  const content = latestInput(attachmentCalls[0].messages).content;
  const parsedAttachment = attachmentInput(content);
  assert.deepEqual(
    parsedAttachment.images,
    manifest.files
      .slice(0, 2)
      .map((file) => ({ type: "base64", media_type: file.mime, data: file.base64 })),
  );
  assert.equal(parsedAttachment.prompt, C.attach);
  assert.deepEqual(parsedAttachment.files, [
    { name: "notes.txt", mime: "text/plain", text: manifest.attachedText },
  ]);

  await page.getByTestId("v4-composer-input").fill(C.pdfDraft);
  await upload(page, [manifest.files[3].path]);
  await page.getByText("report.pdf", { exact: true }).waitFor({ state: "visible" });
  const beforePdf = (await diagnostics(runtime)).calls.length;
  await page.getByTestId("v4-composer-send").click();
  // 同 queue-fail 证据：omp 核心拒绝附件后失败投影到 Composer 错误横幅
  // [data-testid="chat-error-banner"]（data-error-code="SEND_FAILED"），
  // 正文为「附件无法发送给 omp：report.pdf: unsupported attachment type application/pdf」；
  // 产品没有 role="alert"，测试按真实 DOM 归属定位，不要求产品为选择器改角色。
  await page
    .getByTestId("chat-error-banner")
    .filter({ hasText: /report\.pdf.*(?:unsupported|不支持|PDF)/iu })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByTestId("v4-composer-input").innerText(),
    C.pdfDraft,
    "Rejected attachment must preserve text draft",
  );
  // 真实移除按钮是附件 chip 内的 [data-composer-attachment-remove]（aria-label 只有
  // 「移除附件」，不带文件名；按钮默认 opacity-0、悬停/焦点后可见），按产品渲染的 DOM 归属定位。
  const removePdf = page
    .locator('[data-composer-attachment-kind="pdf"]')
    .locator("[data-composer-attachment-remove]");
  assert.equal(await removePdf.count(), 1, "Rejected PDF must remain a removable draft attachment");
  assert.equal(await removePdf.isVisible(), true);
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    beforePdf,
    "PDF rejection must happen before any model dispatch",
  );
  await screenshot("pdf-rejected-draft-retained");
  await removePdf.click();
  assert.equal(await page.getByTestId("v4-composer-input").innerText(), C.pdfDraft);
  await page.getByTestId("v4-composer-send").click();
  await reply(page, "PDF_RETAINED_DRAFT_SENT");
  await idle(page);

  await submit(page, C.chain);
  await reply(page, "CONVERSATION_CHAIN_COMPLETE");
  await idle(page);
  await assertChainFiles(manifest);
  await submit(page, C.toolFail);
  await reply(page, "CONVERSATION_REAL_TOOL_FAILURE_CONFIRMED");
  await idle(page);
  const state = await diagnostics(runtime);
  await failureTool(page, manifest.toolIds.read, failureOutput(state, manifest.toolIds.read));
  await assert.rejects(readFile(manifest.missingPath), { code: "ENOENT" });
  const outputs = chainHttpEvidence(state, manifest);
  await assertChainRows(page, manifest, outputs);
  await screenshot("continuous-write-read-write-real-results");
  return { outputs, files: await assertChainFiles(manifest) };
}

export async function recoverConversationEvidence({
  page,
  runtime,
  manifest,
  receiptPath,
  runId,
  screenshot,
  notRevived,
}) {
  const saved = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(saved.runId, runId);
  assert.equal(saved.runRoot, runtime.runRoot);
  assert.notEqual(saved.launcherPid, runtime.launcherPid);
  assert.notEqual(saved.electronPid, runtime.electronPid);
  await sameTask(page, saved.taskId);
  await page.getByTestId(saved.taskId).click();
  for (const marker of [
    "STREAM_DONE",
    "GUIDE_INPUT_CONSUMED",
    "HELLO_1_DONE",
    "HELLO_2_DONE",
    "HELLO_3_DONE",
    "CONVERSATION_CHAIN_COMPLETE",
    "CONVERSATION_REAL_TOOL_FAILURE_CONFIRMED",
    "CONVERSATION_LIVE_COMPLETE",
  ])
    await reply(page, marker);
  await queued(page, 0, []);
  await idle(page);
  await assertChainFiles(manifest, saved.toolEvidence.files);
  await assertChainRows(page, manifest, saved.toolEvidence.outputs);
  await failureTool(page, manifest.toolIds.read, saved.toolEvidence.outputs[3]);
  await notRevived();
  const recovered = await stored(runtime, saved.taskId, saved.history);
  assertPersistedHistory(recovered, manifest);
  assert.deepEqual(assertPersistedTools(recovered.records, manifest), saved.toolEvidence.outputs);
  assert.equal(
    (await diagnostics(runtime)).calls.length,
    0,
    "Cold replay must never re-run a model, successful chain, failed read, or queue",
  );
  await screenshot("cold-history-before-new-input");
  await submit(page, C.recovery);
  await reply(page, "CONVERSATION_COLD_CONTINUATION_DONE");
  await idle(page);
  await sameTask(page, saved.taskId);
  const continued = await diagnostics(runtime);
  assert.equal(
    continued.calls.length,
    1,
    "Only the explicit new Composer submission may invoke the model",
  );
  assert.equal(continued.acceptance.cursor, 1);
  assert.deepEqual(
    assertProtocolTools(continued.calls[0].messages, manifest, 3, true),
    saved.toolEvidence.outputs,
    "The explicit cold continuation must carry every original exact tool result",
  );
  const history = await poll(
    () => stored(runtime, saved.taskId),
    (value) =>
      value.records.some(
        (record) =>
          record.role === "assistant" &&
          textOf(record.content).includes("CONVERSATION_COLD_CONTINUATION_DONE"),
      ),
    "cold continuation persisted",
  );
  assert.deepEqual(
    history.records.slice(0, saved.history.records.length),
    saved.history.records,
    "Continuation must append, not duplicate or rewrite the original history",
  );
  assert.equal(
    history.records.length,
    saved.history.records.length + 2,
    "One cold submission appends exactly one user and one assistant record",
  );
  assertPersistedHistory(history, manifest, true);
  await assertChainFiles(manifest, saved.toolEvidence.files);
  await notRevived();
}
