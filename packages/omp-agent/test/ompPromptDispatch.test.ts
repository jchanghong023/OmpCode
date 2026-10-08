import { test } from "node:test";
import assert from "node:assert/strict";
import type { OmpCommandFrame } from "../src/domain/ompFrames.js";
import type { OmpCommandOutcome, OmpSessionProcess } from "../src/app/ports.js";
import { dispatchOmpText, type SlashCommandResolution } from "../src/app/ompPromptDispatch.js";

const IMAGE = { type: "image" as const, data: "AQID", mimeType: "image/png" };

/** 记录 send 调用的 stub 进程；只覆盖 dispatchOmpText 依赖的最小端口面。 */
class StubProcess implements OmpSessionProcess {
  readonly ompSessionFile: string | null = null;
  readonly sent: OmpCommandFrame[] = [];
  constructor(private readonly outcome: OmpCommandOutcome = { success: true }) {}
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

/** 固定解析结果的 resolver：默认放行（dispatch）。 */
function resolverOf(resolution: SlashCommandResolution | "dispatch" = "dispatch") {
  const value: SlashCommandResolution =
    resolution === "dispatch" ? { kind: "dispatch" } : resolution;
  return () => Promise.resolve(value);
}

test("斜杠命令（目录内）→ 以 prompt 文本发送（omp 本地执行路径）", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, { text: "/compact", resolveSlashCommand: resolverOf() });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], { type: "prompt", message: "/compact" });
});

test("未知斜杠命令 → 本地拒绝 omp_command_unknown，绝不发给模型", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: "/bogus",
    resolveSlashCommand: resolverOf({ kind: "reject", reason: "unknown", commandName: "bogus" }),
  });
  assert.equal(process.sent.length, 0);
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_unknown");
  assert.match(outcome.error ?? "", /未知命令：bogus/);
});

test("tui_only 斜杠命令 → 本地拒绝 omp_command_tui_only", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: "/security scan",
    resolveSlashCommand: resolverOf({
      kind: "reject",
      reason: "tui_only",
      commandName: "security",
    }),
  });
  assert.equal(process.sent.length, 0);
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_tui_only");
  assert.match(outcome.error ?? "", /终端运行时/);
});

test("无 resolver（目录不可用等）→ 斜杠文本按普通 prompt 发送（宽松路径）", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, { text: "/help" });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], { type: "prompt", message: "/help" });
});

test("斜杠命令 + 带图片 → 不发送并明确失败（omp_command_attachments_unsupported）", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: "/compact",
    images: [IMAGE],
    resolveSlashCommand: resolverOf(),
  });
  assert.equal(process.sent.length, 0);
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.match(outcome.error ?? "", /斜杠命令暂不支持同时发送图片附件/);
});

// A6：文本附件由 ompAttachmentInput 拼进 prompt 文本，"/xxx"+文本附件的
// <attached_file> 块会污染命令文本；dispatch 层按拼接标记识别并拒绝（错误码沿用图片版）。
const SLASH_WITH_TEXT_ATTACHMENT = [
  "/compact",
  `<attached_file name="notes.md" mime="text/markdown">`,
  "内容",
  "</attached_file>",
].join("\n\n");

test("斜杠命令 + 拼接文本附件 → 拒绝（omp_command_attachments_unsupported）", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: SLASH_WITH_TEXT_ATTACHMENT,
    resolveSlashCommand: resolverOf(),
  });
  assert.equal(process.sent.length, 0);
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.match(outcome.error ?? "", /斜杠命令暂不支持同时发送文本附件/);
});

test("普通消息 + 拼接文本附件 → 照常作为 prompt 文本发送", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: `总结一下\n\n<attached_file name="a.txt" mime="text/plain">\nx\n</attached_file>`,
  });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.equal(process.sent[0]?.type, "prompt");
});

test("普通文本 → prompt 携带 images（无 inputMode 字段）", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, { text: "总结一下", images: [IMAGE] });
  assert.equal(outcome.success, true);
  assert.equal(process.sent.length, 1);
  assert.deepEqual(process.sent[0], {
    type: "prompt",
    message: "总结一下",
    images: [IMAGE],
  });
});

for (const followupMode of ["queue", "guide"] as const) {
  test(`流式 ${followupMode} 补充保留合并文本和图片，不降级为 prompt`, async () => {
    const process = new StubProcess();
    const text =
      '改成英文\n\n<attached_file name="a.txt" mime="text/plain">\n完整附件正文\n</attached_file>';
    const outcome = await dispatch(process, {
      text,
      originalText: "改成英文",
      images: [IMAGE],
      streaming: true,
      followupMode,
    });
    assert.equal(outcome.success, true);
    assert.deepEqual(process.sent, [
      {
        type: followupMode === "guide" ? "steer" : "follow_up",
        message: text,
        images: [IMAGE],
      },
    ]);
  });
}

for (const followupMode of ["queue", "guide"] as const) {
  test(`busy 原生命令仍走 prompt 并保留 ${followupMode} 的模型输入策略`, async () => {
    const process = new StubProcess();
    const message = "/compact soft  保留接口\n与验收\n";
    const outcome = await dispatch(process, {
      text: message,
      streaming: true,
      followupMode,
      resolveSlashCommand: resolverOf(),
    });
    assert.equal(outcome.success, true);
    assert.deepEqual(process.sent, [
      {
        type: "prompt",
        message,
        streamingBehavior: followupMode === "guide" ? "steer" : "followUp",
      },
    ]);
  });
}

test("busy 未知命令、TUI-only 与附件先拒绝，不能进入模型队列或修改模型", async () => {
  for (const reason of ["unknown", "tui_only"] as const) {
    const process = new StubProcess();
    const outcome = await dispatch(process, {
      text: "/blocked",
      streaming: true,
      modelSelection: { provider: "other", model: "other" },
      resolveSlashCommand: resolverOf({ kind: "reject", reason, commandName: "blocked" }),
    });
    assert.equal(outcome.code, `omp_command_${reason}`);
    assert.deepEqual(process.sent, []);
  }
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: "/wiki",
    images: [IMAGE],
    streaming: true,
    modelSelection: { provider: "other", model: "other" },
    resolveSlashCommand: resolverOf(),
  });
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.deepEqual(process.sent, []);
});

test("附件块前置仍按原始 slash 拒绝，且不得先修改模型", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: '<attached_file name="a.txt" mime="text/plain">\nx\n</attached_file>\n\n/compact',
    originalText: "/compact",
    modelSelection: { provider: "other", model: "other-model", thought: "high" },
    resolveSlashCommand: resolverOf(),
  });
  assert.equal(outcome.code, "omp_command_attachments_unsupported");
  assert.equal(outcome.success, false);
  assert.deepEqual(process.sent, []);
});

test("未知命令带模型选择也先拒绝，不产生 set_model 副作用", async () => {
  const process = new StubProcess();
  const outcome = await dispatch(process, {
    text: "  /bogus",
    modelSelection: { provider: "other", model: "other-model" },
    resolveSlashCommand: resolverOf({ kind: "reject", reason: "unknown", commandName: "bogus" }),
  });
  assert.equal(outcome.code, "omp_command_unknown");
  assert.deepEqual(process.sent, []);
});

test("模型相同但思考档位被核心拒绝时不发送 prompt", async () => {
  const process = new StubProcess({ success: false, error: "thinking unavailable" });
  const outcome = await dispatch(process, {
    text: "hello",
    modelSelection: { provider: "p", model: "m", thought: "high" },
  });
  assert.equal(outcome.success, false);
  assert.equal(outcome.code, "omp_set_thinking_level_failed");
  assert.deepEqual(process.sent, [{ type: "set_thinking_level", level: "high" }]);
});
