import assert from "node:assert/strict";
import { textOf } from "./ompAgentsAcceptance.protocol.mjs";

const recordTime = (source) =>
  source.type === "message" ? (source.message.timestamp ?? source.timestamp) : source.timestamp;

/**
 * 父级 steering 信封（prompts/steering/parent-irc.md）：`[Wait interrupted by message]` +
 * `<irc from="parent" agent="<真实父 ID>">正文</irc>`。只有真实 steering 消息能给出 agent 属性，
 * 因此仅凭该形式即可证明接收端确实收到这条父通信。
 */
function parentSteerEnvelope(entry) {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const text = textOf(entry.message.content);
  if (!text.includes("[Wait interrupted by message]")) return undefined;
  const block = /<irc\b([^>]*)>([\s\S]*?)<\/irc>/u.exec(text);
  const from = /\bagent="([A-Za-z0-9_-]+)"/u.exec(block?.[1] ?? "")?.[1];
  if (!from) return undefined;
  return { from, body: (block?.[2] ?? "").trim() };
}

function sourceEvent(event, source, timing) {
  assert.ok(source, `Independent source required for ${event.token}`);
  assert.ok(
    typeof source.id === "string" && source.id.length > 0,
    "Source identity must be the actual persisted OMP entry ID",
  );
  const timestamp = timing ? timing.timestamp : recordTime(source);
  const instant =
    timestamp === undefined || timestamp === null
      ? null
      : typeof timestamp === "number"
        ? timestamp
        : Date.parse(timestamp);
  if (instant !== null)
    assert.ok(Number.isFinite(instant), "Source timestamp must be a real instant");
  return {
    ...event,
    sourceId: source.id,
    timestamp: instant,
    timeBasis: instant === null ? "unknown" : (timing?.timeBasis ?? "recorded"),
  };
}

function toolSource(entries, id) {
  const sources = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === id,
  );
  assert.equal(sources.length, 1, `Exactly one actual tool result source for ${id}`);
  return sources[0];
}

function callSource(entries, id) {
  const sources = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "toolCall" && part.id === id),
  );
  assert.equal(sources.length, 1, `Exactly one actual invocation source for ${id}`);
  return sources[0];
}

function dispatchEvent(event, entries, toolId) {
  const call = callSource(entries, toolId);
  return sourceEvent(event, toolSource(entries, toolId), {
    timestamp: recordTime(call),
    timeBasis: "recorded",
  });
}

function sendEvent(event, entries, toolId, receiverEntries) {
  const source = toolSource(entries, toolId);
  const call = callSource(entries, toolId);
  const invocation = call.message.content.find(
    (part) => part.type === "toolCall" && part.id === toolId,
  );
  assert.equal(invocation.name, "write");
  assert.equal(invocation.arguments.content, event.token);
  const details = source.message.details.message;
  assert.equal(details.op, "send");
  assert.equal(details.from, event.sender);
  const receipts = details.receipts.filter((receipt) => receipt.to === event.receiver);
  assert.equal(
    receipts.length,
    1,
    "Each actual send must have exactly one matching recipient receipt",
  );
  const receipt = receipts[0];
  assert.ok(["injected", "woken", "revived"].includes(receipt.outcome));
  assert.ok(
    typeof receipt.id === "string" && receipt.id.length > 0,
    "Require the real bus message ID",
  );
  // 中文原因：同一总线消息以接收端原始 incoming 条目为 sourceId，不与发送回执 ID 混同。
  // 父→正在回合中的子代理走 omp irc-bridge.deliver 的 steering 分支（streaming + fromParent），
  // 接收端不落 irc:incoming 记录，而落父级 steering 用户消息（prompts/steering/parent-irc.md：
  // 角色标签在 from、真实发送者 ID 在 agent、正文原样在信封内）；peer 与空闲投递仍落 irc:incoming。
  // 两种形式都算接收端真实证据，但必须恰好一条。
  const recorded = receiverEntries.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "irc:incoming" &&
      entry.details?.id === receipt.id &&
      entry.details?.from === event.sender &&
      entry.details?.message === event.token,
  );
  const steered = receiverEntries.filter((entry) => {
    const envelope = parentSteerEnvelope(entry);
    return envelope?.from === event.sender && envelope.body === event.token;
  });
  // 中文原因：父级正在 wait 时的子代理回信会由真实 wait 结果持久化为 waited 信封，
  // 而非独立 irc:incoming 记录；仍需按回执 ID、双方身份和正文精确相关。
  const waited = receiverEntries.filter((entry) => {
    const message = entry.type === "message" ? entry.message : undefined;
    const delivery = message?.details?.waited;
    return (
      message?.role === "toolResult" &&
      message.toolName === "wait" &&
      delivery?.id === receipt.id &&
      delivery.from === event.sender &&
      delivery.to === event.receiver &&
      delivery.body === event.token
    );
  });
  assert.equal(
    recorded.length + steered.length + waited.length,
    1,
    "Require the exact independently persisted recipient delivery evidence",
  );
  const incoming = recorded[0] ?? steered[0] ?? waited[0];
  // 中文原因：发送回执携带的 ts 才证明发送时间；旧回执仅有调用时间时明确显示记录时间。
  const sent = receipt.ts !== undefined && receipt.ts !== null;
  return sourceEvent({ ...event, messageId: receipt.id }, incoming, {
    timestamp: sent ? receipt.ts : recordTime(call),
    timeBasis: sent ? "sent" : "recorded",
  });
}

export function sourceEvents(records, parentId) {
  assert.ok(
    parentId && records.parentAgentId,
    "Use actual parent communication identity, not a guessed UUID",
  );
  const main = records.parentAgentId;
  const events = [];
  for (const child of records.children) {
    // 中文原因：wait 可能只消费 peer 回信；完成来源必须是实际携带完成结果的唯一记录。
    // inspectRecords 已严格校验投递与子身份，此处仍精确选择一条，不接受候选 ID 集合。
    const completions = records.entries.filter((entry) => {
      if (entry.type === "custom_message" && entry.customType === "async-result")
        return (
          textOf(entry.content).includes(`AGENTS_DONE_${child.name}`) &&
          entry.details?.jobs?.some(
            (job) => job.jobId === child.rawId && job.agentId === child.rawId,
          )
        );
      return (
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "wait" &&
        textOf(entry.message.content).includes(`AGENTS_DONE_${child.name}`) &&
        entry.message.details?.jobs?.some((job) => job.id === child.rawId)
      );
    });
    assert.equal(
      completions.length,
      1,
      "Each completion must resolve to one exact persisted source",
    );
    const result = completions[0];
    events.push(
      dispatchEvent(
        {
          kind: "dispatch",
          sender: main,
          receiver: child.rawId,
          token: `AGENTS_CHILD_${child.name}`,
        },
        records.entries,
        "agents-batch-task",
      ),
    );
    events.push(
      sendEvent(
        {
          kind: "communication",
          sender: main,
          receiver: child.rawId,
          token: "hello",
        },
        records.entries,
        "agents-broadcast",
        child.entries,
      ),
    );
    events.push(
      sendEvent(
        {
          kind: "communication",
          sender: child.rawId,
          receiver: main,
          token: `AGENTS_REPLY_${child.name}`,
        },
        child.entries,
        `agents-child-${child.name}-reply`,
        records.entries,
      ),
    );
    events.push(
      sourceEvent(
        {
          kind: "result",
          sender: child.rawId,
          receiver: main,
          token: `AGENTS_DONE_${child.name}`,
        },
        result,
      ),
    );
  }
  events.push(
    sendEvent(
      {
        kind: "communication",
        sender: records.children.find((child) => child.name === "a").rawId,
        receiver: records.children.find((child) => child.name === "b").rawId,
        token: "AGENTS_PEER_A_TO_B",
      },
      records.children.find((child) => child.name === "a").entries,
      "agents-child-a-peer",
      records.children.find((child) => child.name === "b").entries,
    ),
  );
  for (const [name, child] of Object.entries(records.extras)) {
    events.push(
      dispatchEvent(
        {
          kind: "dispatch",
          sender: main,
          receiver: child.rawId,
          token: `AGENTS_CHILD_${name}`,
        },
        records.entries,
        `agents-${name}-task`,
      ),
    );
    if (name === "failure") {
      events.push(
        sourceEvent(
          {
            kind: "result",
            sender: child.rawId,
            receiver: main,
            token: "AGENTS_FAILURE_ACTUAL",
          },
          records.automatic.find((entry) =>
            textOf(entry.content).includes("AGENTS_FAILURE_ACTUAL"),
          ),
        ),
      );
    } else {
      const intervention = child.entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.attribution === "user" &&
          entry.message.synthetic !== true &&
          textOf(entry.message.content).includes("AGENTS_CONTROL_STEER"),
      );
      events.push(
        sourceEvent(
          {
            kind: "intervention",
            sender: "user",
            receiver: child.rawId,
            token: "AGENTS_CONTROL_STEER",
          },
          intervention,
        ),
      );
      assert.ok(
        events.at(-1).sourceId,
        "User intervention must link its actual persisted source ID",
      );
    }
  }
  assert.equal(events.length, 13 + Object.keys(records.extras).length * 2);
  return events;
}
