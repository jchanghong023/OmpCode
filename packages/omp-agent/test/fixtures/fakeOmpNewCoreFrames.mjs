// 新核专属帧与字段的 fixture 支持（自 fakeOmp.mjs 内聚抽出，供 D1 新帧容忍测试注入）：
// UNKNOWN_SESSION_FRAMES 场景的未知会话事件帧下发、以及 FAKE_OMP_GET_STATE_NEW_FIELDS=1
// 时并入 get_state 响应的新核字段。

/**
 * D1 新帧容忍：模拟新核下发本适配器尚未接入的会话事件帧（goal_updated v18.4.11+
 * fork.282、live voice 的 live_* 帧 v18.6.0+fork.292）；适配器须优雅忽略（不崩、
 * 不误状态），随后的正常事件流照常消费。尾随的 prompt_result 携带新核终态字段
 * （status/sessionSettled），completed+agentInvoked=true 在适配器侧应为 no-op。
 */
export function emitUnknownSessionFrames(out, emitTextTurn, promptId) {
  out({
    type: "goal_updated",
    sessionId: "fake-session-1",
    goal: { text: "goal", status: "active" },
    updatedAt: Date.now(),
  });
  out({ type: "live_voice_state", sessionId: "fake-session-1", voice: { state: "listening" } });
  emitTextTurn("UNKNOWN_FRAMES_TOLERATED");
  out({
    type: "prompt_result",
    id: promptId,
    agentInvoked: true,
    status: "completed",
    sessionSettled: true,
  });
}

/**
 * D1 新帧容忍：新核 get_state 携带队列/goal 等新字段（RpcSessionState.queuedMessages
 * 的 steering/followUp/liveSteered、goal），适配器 schema passthrough 不拒帧，原字段
 * 消费不受影响。FAKE_OMP_GET_STATE_NEW_FIELDS=1 时展开并入响应，否则为空对象。
 */
export function newStateFields() {
  return process.env.FAKE_OMP_GET_STATE_NEW_FIELDS === "1"
    ? {
        queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
        goal: { text: "goal from new core", updatedAt: "2026-10-04T00:00:00.000Z" },
      }
    : {};
}
