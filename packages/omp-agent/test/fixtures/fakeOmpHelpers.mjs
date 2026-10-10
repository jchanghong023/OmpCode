// fake omp 共享辅助（自 fakeOmp.mjs 拆出）：stdout 帧、id 计数、v3 surface、
// 会话级可变状态与 prompt 回合行为脚本，经导出绑定与 fakeOmp.mjs 主文件共享。

import { createV3Surface, PROMPT_SCENARIOS } from "./fakeOmpV3.mjs";
import { emitUnknownSessionFrames } from "./fakeOmpNewCoreFrames.mjs";

export const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let counter = 0;
export const nextId = () => `fake-${++counter}`;

// v3 ready 公告 [1,2,3]；审批使用真实 extension_ui_request/response，
// 不恢复已删除的 permission_request 协议。
export const v3 = createV3Surface({ out, nextId });

// 会话级可变状态（原 fakeOmp.mjs 模块变量，改经 shared 对象共享）。
export const shared = {
  sessionFile: null,
  // HOLD 前缀：进入流式保持态（agent_start + 首段文本，不收口），用于测试 steer/follow_up 路由。
  holding: false,
  // SLOW_TOOL_HOLD：工具在途保持态（tool_execution_start 后不收口），abort 时镜像真实 omp
  // v18.3.5+fork.265 的中断序列（P2 验收 D1）：end(isError) → 尾随 update → agent_end。
  slowToolCallId: null,
  currentModel: { provider: "mock", id: "mock-1" },
  autoCompactionEnabled: true,
  subagents: [],
};
const deniedTools = new Set();

export const pendingUi = new Map();

/** 文本轮：流式 delta（message_update）→ message_end 收口（投影器文本只来自 delta）。 */
function emitTextTurn(text) {
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: { role: "assistant", content: [] },
    },
  });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  out({ type: "agent_end", messages: [], isTerminal: true });
}

export function respond(id, command, success, data) {
  out({
    ...(id ? { id } : {}),
    type: "response",
    command,
    success,
    ...(data !== undefined ? { data } : {}),
  });
}

// omp 原生附件顺序（rpc-session-host textPrefix，S5-8 对齐）：文本附件上下文前置于用户
// 消息。本地命令匹配取末段命令文本（最后一个以 "/" 开头的行起），兼容附件前缀在前/在后
// 两种装配顺序；报告哨兵（image-report/text-report）支持无斜杠形态（斜杠+附件已被适配层
// 严格分发拒绝）；非命令场景标记（HOLD/ABORT_AT_START 等）仍按原始全文匹配。
export function localCommandMessage(message) {
  if (typeof message !== "string") return message;
  const lines = message.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("/")) return lines.slice(i).join("\n");
    if (/^(image-report|text-report) /.test(lines[i])) return lines[i];
  }
  return message;
}

export function runLocalCommand(message) {
  return v3.localReport(message);
}

export async function runPromptTurn(message, promptId) {
  out({ type: "agent_start" });
  if (message === "/failmodel") {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorStatus: 401,
        errorMessage: "401 Model not supported",
      },
    });
    out({ type: "agent_end", messages: [], isTerminal: true });
    out({ type: "prompt_result", id: promptId, agentInvoked: true });
    return;
  }
  if (message === "UNKNOWN_SESSION_FRAMES") {
    // D1 新帧容忍场景：新核未知帧下发与尾随 prompt_result 的行为脚本在
    // fakeOmpNewCoreFrames.mjs（同仓 fixture 内聚抽出）。
    emitUnknownSessionFrames(out, emitTextTurn, promptId);
    return;
  }
  if (typeof message === "string" && message.startsWith("HOLD")) {
    shared.holding = true;
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "holding",
        partial: { role: "assistant", content: [] },
      },
    });
    return;
  }
  if (message === "SLOW_TOOL_HOLD") {
    shared.slowToolCallId = `toolu-${nextId()}`;
    out({
      type: "tool_execution_start",
      toolCallId: shared.slowToolCallId,
      toolName: "bash",
      args: { command: "sleep 60" },
    });
    return;
  }
  if (typeof message === "string" && message.startsWith("FOLLOWEDUP:")) {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: message },
    });
    out({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: message }] },
    });
    out({ type: "agent_end", messages: [], isTerminal: true });
    return;
  }
  const scenario = PROMPT_SCENARIOS[message] ?? PROMPT_SCENARIOS.default;
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const delta of ["Hello", " wor", "ld!"]) {
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: { role: "assistant", content: [] },
      },
    });
  }
  const toolCallId = `toolu-${nextId()}`;
  if (!shared.sessionFile) {
    shared.sessionFile = `${process.cwd()}/.fake-omp-sessions/session-1.jsonl`;
  }
  out({
    type: "tool_execution_start",
    toolCallId,
    toolName: scenario.toolName,
    args: scenario.args,
  });
  const approved = await requestApproval(toolCallId, scenario);
  if (approved) {
    out({
      type: "tool_execution_end",
      toolCallId,
      toolName: scenario.toolName,
      result: { content: [{ type: "text", text: "wrote 2 lines" }] },
      isError: false,
    });
    out({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: " Done.",
        partial: { role: "assistant", content: [] },
      },
    });
  } else {
    out({
      type: "tool_execution_end",
      toolCallId,
      toolName: scenario.toolName,
      result: { content: [{ type: "text", text: "denied by user" }] },
      isError: true,
    });
    deniedTools.add(toolCallId);
  }
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world! Done." }],
      usage: { input: 120, output: 30 },
    },
  });
  out({ type: "agent_end", messages: [], isTerminal: true });
}

function requestApproval(toolCallId, scenario) {
  if (v3.isV3()) {
    return v3.requestApproval(toolCallId, scenario);
  }
  return requestLegacyApproval(toolCallId);
}

function requestLegacyApproval(toolCallId) {
  return new Promise((resolve) => {
    const id = nextId();
    pendingUi.set(id, (cmd) => resolve(cmd.value === "Approve"));
    out({
      type: "extension_ui_request",
      id,
      method: "select",
      title: "Tool approval",
      message: `Approve write to greeting.txt? (toolCallId=${toolCallId})`,
      options: ["Approve", "Deny"],
    });
  });
}
