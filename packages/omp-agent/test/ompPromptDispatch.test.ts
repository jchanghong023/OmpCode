import { test } from "node:test";
import assert from "node:assert/strict";
import type { OmpCommandFrame } from "../src/domain/ompFrames.js";
import type { OmpCommandOutcome, OmpSessionProcess } from "../src/app/ports.js";
import { dispatchOmpText } from "../src/app/ompPromptDispatch.js";

const IMAGE = { type: "image" as const, data: "AQID", mimeType: "image/png" };

/** 记录 send 调用的 stub 进程；只覆盖 dispatchOmpText 依赖的最小端口面。 */
class StubProcess implements OmpSessionProcess {
  readonly ompSessionFile: string | null = null;
  readonly projectMode: boolean;
  readonly sent: OmpCommandFrame[] = [];
  constructor(
    projectMode: boolean,
    private readonly outcome: OmpCommandOutcome = { success: true },
  ) {
    this.projectMode = projectMode;
  }
  async start(): Promise<void> {}
  async send(command: OmpCommandFrame): Promise<OmpCommandOutcome> {
    this.sent.push(command);
    return this.outcome;
  }
  respondUi(): void {}
  async refreshState(): Promise<null> {
    return null;
  }
  async readContextReport(): Promise<null> {
    return null;
  }
  async dispose(): Promise<void> {}
}

function dispatch(
  process: StubProcess,
  overrides: Partial<Parameters<typeof dispatchOmpText>[0]> = {},
) {
  return dispatchOmpText({
    process,
    text: "/help",
    images: [],
    streaming: false,
    followupMode: "queue",
    currentConfig: { provider: "p", model: "m", thought: "" },
    ...overrides,
  });
}

test("项目模式 + 斜杠命令 + 无附件 → execute_command 且 text 原样", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, { text: "/compact" });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], { type: "execute_command", text: "/compact" });
});

test("项目模式 + 斜杠命令 + 带图片 → 不发送并明确失败（omp_command_attachments_unsupported）", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, { text: "/compact", images: [IMAGE] });
  assert.equal(process.sent.length, 0);
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.match(outcome.error ?? "", /斜杠命令暂不支持同时发送图片附件/);
});

test("项目模式 + 普通文本 → prompt 携带 inputMode text 与 images", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, { text: "总结一下", images: [IMAGE] });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], {
    type: "prompt",
    message: "总结一下",
    images: [IMAGE],
    inputMode: "text",
  });
});

test("非项目模式 + 斜杠文本 → prompt 且不带 inputMode 字段", async () => {
  const process = new StubProcess(false);
  const outcome = await dispatch(process, { text: "/help" });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  const command = process.sent[0];
  assert.equal(command.type, "prompt");
  assert.deepEqual(command, { type: "prompt", message: "/help" });
});

test("流式 + guide → steer 携带文本与附件", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, {
    text: "改成英文",
    images: [IMAGE],
    streaming: true,
    followupMode: "guide",
  });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], { type: "steer", message: "改成英文", images: [IMAGE] });
});

test("流式 + queue → follow_up 入队（G14）", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, {
    text: "排队补充",
    streaming: true,
    followupMode: "queue",
  });
  assert.equal(outcome.success, true);
  // 修复（G15）：成功结果不携带失败 code。
  assert.equal(outcome.code, undefined);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], { type: "follow_up", message: "排队补充" });
});

test("提供 modelSelection 时先发 set_model 再发命令（G14）", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, {
    text: "/compact",
    modelSelection: { provider: "p2", model: "m2" },
  });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 2);
  assert.deepEqual(process.sent[0], { type: "set_model", provider: "p2", modelId: "m2" });
  assert.deepEqual(process.sent[1], { type: "execute_command", text: "/compact" });
});

test("被拒输入（斜杠+附件）不得先改写会话模型（G9）", async () => {
  const process = new StubProcess(true);
  const outcome = await dispatch(process, {
    text: "/compact",
    images: [IMAGE],
    modelSelection: { provider: "p2", model: "m2" },
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.equal(process.sent.length, 0);
});

test("execute_command 失败 → code omp_command_failed（G14）", async () => {
  const process = new StubProcess(true, { success: false, error: "Unknown command: /nope" });
  const outcome = await dispatch(process, { text: "/nope" });
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_failed");
  assert.match(outcome.error ?? "", /Unknown command/);
});

test("prompt 失败 → code omp_prompt_failed（G14）", async () => {
  const process = new StubProcess(true, { success: false, error: "omp busy" });
  const outcome = await dispatch(process, { text: "你好" });
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_prompt_failed");
});
