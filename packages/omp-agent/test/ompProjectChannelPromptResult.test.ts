// A1 接线的 channel 级 UT（ompProjectChannel 的 prompt_result 透传分支）：status 透传、
// error 对象 {message} → 字符串扁平化、contextResult 命中短路；既有测试绕过 channel 层
// 直达 tracker/引擎，本文件用最小 fake 进程直接构造 OmpProjectSessionChannel 补齐通道边界。

import assert from "node:assert/strict";
import test from "node:test";
import { OmpProjectSessionChannel } from "../src/adapters/ompProjectChannel.js";
import type { OmpProjectProcess } from "../src/adapters/ompProjectProcess.js";
import type { OmpSessionProcessHandlers } from "../src/app/ports.js";
import type { OmpPromptResultFrame, OmpSessionEventFrame } from "../src/domain/ompFrames.js";

interface ChannelHarness {
  channel: OmpProjectSessionChannel;
  promptResults: OmpPromptResultFrame[];
  events: OmpSessionEventFrame[];
}

/** 最小 fake 项目进程：只实现 channel 用到的表面（请求 id 预留/请求/UI 应答/会话命令）。 */
function createChannel(): ChannelHarness {
  const promptResults: OmpPromptResultFrame[] = [];
  const events: OmpSessionEventFrame[] = [];
  const handlers: OmpSessionProcessHandlers = {
    onEvent: (event) => {
      events.push(event);
    },
    onUiRequest: () => {},
    onPermissionRequest: () => {},
    onAskRequest: () => {},
    onExit: () => {},
    onPromptResult: (frame) => {
      promptResults.push(frame);
    },
  };
  const fakeProcess = {
    reserveRequestId: () => "ctx-req-1",
    // /context 侧信道的 execute_command 请求在测试期内保持未结算（短路断言足够）。
    request: () => new Promise(() => {}),
    respondUi() {},
    detachSession() {},
    sendSessionCommand: () => Promise.resolve({ success: true }),
  } as unknown as OmpProjectProcess;
  const channel = new OmpProjectSessionChannel(fakeProcess, "session-1", handlers);
  return { channel, promptResults, events };
}

test("channel prompt_result：登记 id 的 aborted+agentInvoked:true 帧透传 status，未登记 id 不上抛", () => {
  const { channel, promptResults } = createChannel();
  // response 先登记 pending id（command=prompt、success、响应无 data → agentInvoked 未知）。
  channel.handleFrame({ type: "response", id: "p-1", command: "prompt", success: true });
  channel.handleFrame({ type: "prompt_result", id: "p-1", agentInvoked: true, status: "aborted" });
  assert.equal(promptResults.length, 1);
  assert.deepEqual(promptResults[0], {
    type: "prompt_result",
    id: "p-1",
    agentInvoked: true,
    status: "aborted",
  });
  // 未登记 id 的终态帧不上抛（tracker 的 id 关联语义在通道层同样成立）。
  channel.handleFrame({
    type: "prompt_result",
    id: "unregistered",
    agentInvoked: true,
    status: "aborted",
  });
  assert.equal(promptResults.length, 1);
});

test("channel prompt_result：error 对象 {message} 扁平化为字符串，字符串形态原样透传", () => {
  const { channel, promptResults } = createChannel();
  // execute_command 的本地命令同样登记（严格分发的本地命令可能异步收口）。
  channel.handleFrame({ type: "response", id: "p-2", command: "execute_command", success: true });
  channel.handleFrame({
    type: "prompt_result",
    id: "p-2",
    agentInvoked: true,
    status: "error",
    error: { message: "x", retryable: false },
  });
  assert.equal(promptResults.length, 1);
  assert.equal(promptResults[0]!.status, "error");
  assert.equal(promptResults[0]!.error, "x");

  channel.handleFrame({ type: "response", id: "p-3", command: "prompt", success: true });
  channel.handleFrame({
    type: "prompt_result",
    id: "p-3",
    agentInvoked: true,
    status: "error",
    error: "y",
  });
  assert.equal(promptResults[1]!.error, "y");
});

test("channel prompt_result：contextResult 命中短路不上抛，其它登记 id 的透传不受影响", () => {
  const { channel, promptResults } = createChannel();
  // /context 侧信道在途：readContextReport 同步登记 contextResult（reserveRequestId 的 id）。
  void channel.readContextReport();
  // 命中 contextResult.id 的 prompt_result 只结算侧信道，不上抛 onPromptResult。
  channel.handleFrame({ type: "prompt_result", id: "ctx-req-1", agentInvoked: false });
  assert.equal(promptResults.length, 0);
  // 短路只针对 contextResult.id：其它登记 id 的终态照常透传。
  channel.handleFrame({ type: "response", id: "p-4", command: "prompt", success: true });
  channel.handleFrame({ type: "prompt_result", id: "p-4", agentInvoked: true, status: "aborted" });
  assert.equal(promptResults.length, 1);
  assert.equal(promptResults[0]!.id, "p-4");
});
