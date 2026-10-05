export const DURABLE_SUBAGENTS = {
  finished: [
    {
      subagentId: "sa-done",
      name: "scout",
      description: "finished scout",
      task: "scan",
      status: "completed",
      recordReadable: true,
      parentToolCallId: "tc-0",
      lastUpdate: "2026-09-29T00:00:00.000Z",
      availableActions: [],
    },
    // durable 终态还有 parked（完成后驻留，可继续收消息）与 interrupted（崩溃中断）——
    // rpc-project-subagents.buildFinishedSubagentRow 的终态规则；无 status 过滤的合并目录
    // 必须包含它们（E2E 断言 refresh 不会把 durable 终态误标成永不终止的 running 卡片）。
    {
      subagentId: "sa-parked",
      name: "watcher",
      description: "parked watcher",
      task: "watch",
      status: "parked",
      recordReadable: true,
      parentToolCallId: "tc-0",
      lastUpdate: "2026-09-29T01:00:00.000Z",
      availableActions: ["send_message"],
    },
    {
      subagentId: "sa-crashed",
      name: "miner",
      description: "crashed miner",
      task: "mine",
      status: "interrupted",
      recordReadable: false,
      parentToolCallId: "tc-0",
      lastUpdate: "2026-09-29T02:00:00.000Z",
      availableActions: [],
    },
  ],
};

export function createSubagentEntries(facts) {
  return function subagentEntries() {
    // 条目带固定时间戳：真实 omp 记录携带时间戳；缺时间戳会让 rowsFromOmpEntries 回退
    // Date.now()，使全量重读的确定性重建产生 createdAt 漂移（重读即触发全量 upsert）。
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          timestamp: 1727500000000,
          content: [{ type: "text", text: "scan the repo" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1727500000001,
          content: [{ type: "text", text: "scanned 3 files" }],
        },
      },
    ];
    // 同一 subagentId 的第 2+ 轮运行各追加一条尾记录（确定性内容）：驱动子代理详情视图
    // 的实时重读合并断言——重读返回的行数必须随记录增长，且旧行内容保持不变。
    for (let run = 2; run <= (facts.subagentSpawns ?? 0); run += 1) {
      entries.push({
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1727500000000 + run,
          content: [{ type: "text", text: `scanned ${1 + run} files in run ${run}` }],
        },
      });
    }
    return entries;
  };
}

// fake omp 项目模式的 get_subagent_messages 窗口语义实现（从 fakeOmpProjectCatalog.mjs
// 拆出，架构 max-file-lines）。真实语义见 omp rpc-project-subagents.messages：记录序列化
// 为 JSONL，按 [fromByte, fromByte+maxBytes) 切窗，只返回窗口内完整记录 + nextByte/hasMore；
// 游标越界回 0 并置 reset；单条记录超窗返回 recordTooLarge 且游标不动。

export function handleSubagentMessagesCommand({
  id,
  command,
  response,
  facts,
  subagentEntries,
  sessionFileOf,
}) {
  if (process.env.FAKE_OMP_SUBAGENT_MESSAGES_FAIL === "1") {
    // 记录不可用（不存在/已清理）：成功帧携带 success:false，供「记录不可用提示行」用例。
    return response(
      id,
      command.type,
      false,
      undefined,
      `Subagent transcript unavailable: ${command.subagentId}`,
      "not_found",
    );
  }
  // 事实记录：E2E 在 fake 进程退出后读 facts.json，断言适配器的窗口续读（fromByte 推进）。
  facts.subagentMessages.push({
    sessionId: command.sessionId,
    subagentId: command.subagentId,
    fromByte: Number.isFinite(Number(command.fromByte)) ? Math.trunc(Number(command.fromByte)) : 0,
    maxBytes: Number.isFinite(Number(command.maxBytes))
      ? Math.trunc(Number(command.maxBytes))
      : null,
  });
  const entries = subagentEntries();
  const buffer = Buffer.from(
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  const size = buffer.length;
  const windowBytes = Math.max(
    1,
    Math.trunc(Number(process.env.FAKE_OMP_SUBAGENT_WINDOW_BYTES ?? 262144)) || 262144,
  );
  const maxBytes =
    process.env.FAKE_OMP_SUBAGENT_RECORD_TOO_LARGE === "1" ? Math.min(windowBytes, 1) : windowBytes;
  const requested =
    Number.isFinite(Number(command.fromByte)) && Number(command.fromByte) >= 0
      ? Math.trunc(Number(command.fromByte))
      : 0;
  let fromByte = requested;
  let reset = false;
  if (fromByte > size) {
    fromByte = 0;
    reset = true;
  }
  if (fromByte >= size) {
    return response(id, command.type, true, {
      subagentId: command.subagentId,
      sessionFile: sessionFileOf(`${command.sessionId}-${command.subagentId}`),
      fromByte,
      nextByte: fromByte,
      reset,
      hasMore: false,
      entries: [],
      messages: [],
    });
  }
  const chunk = buffer.subarray(fromByte, fromByte + maxBytes);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline >= 0) {
    const windowEntries = chunk
      .subarray(0, lastNewline + 1)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    const nextByte = fromByte + lastNewline + 1;
    return response(id, command.type, true, {
      subagentId: command.subagentId,
      sessionFile: sessionFileOf(`${command.sessionId}-${command.subagentId}`),
      fromByte,
      nextByte,
      reset,
      hasMore: nextByte < size,
      entries: windowEntries,
      messages: windowEntries.map((entry) => entry.message),
    });
  }
  if (fromByte + chunk.length >= size) {
    // EOF 末条无换行：按真实核的 LF 补全语义结束该记录，游标推进到 EOF。
    const text = chunk.toString("utf8").trim();
    const windowEntries = text.length > 0 ? [JSON.parse(text)] : [];
    return response(id, command.type, true, {
      subagentId: command.subagentId,
      sessionFile: sessionFileOf(`${command.sessionId}-${command.subagentId}`),
      fromByte,
      nextByte: fromByte + chunk.length,
      reset,
      hasMore: false,
      entries: windowEntries,
      messages: windowEntries.map((entry) => entry.message),
    });
  }
  // 窗口首条记录超出 maxBytes：报告记录大小，游标不动（不截断成损坏 JSON）。
  let end = buffer.indexOf(0x0a, fromByte);
  if (end < 0) end = size;
  return response(id, command.type, true, {
    subagentId: command.subagentId,
    sessionFile: sessionFileOf(`${command.sessionId}-${command.subagentId}`),
    fromByte,
    nextByte: fromByte,
    reset,
    hasMore: true,
    entries: [],
    messages: [],
    recordTooLarge: { byteLength: end - fromByte + 1 },
  });
}
