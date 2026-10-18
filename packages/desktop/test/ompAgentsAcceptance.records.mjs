import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertTaskArguments, dispatched, textOf } from "./ompAgentsAcceptance.protocol.mjs";
import {
  assertOriginalAssignment,
  callsOf,
  digest,
  jsonlFiles,
  messagesOf,
  readEntries,
  resultsOf,
  successful,
} from "./ompAgentsAcceptance.recordFiles.mjs";

export { jsonlFiles, readEntries };

export async function taskDispatch(runtime, parentId, toolId) {
  const names = {
    "agents-batch-task": ["a", "b", "c"],
    "agents-failure-task": ["failure"],
    "agents-control-task": ["control"],
  }[toolId];
  assert.ok(names, "Only the requested real acceptance task may supply card identities");
  const files = await jsonlFiles(join(runtime.configRoot, "agent", "sessions"));
  const parents = files.filter((path) => basename(path).endsWith(`_${parentId}.jsonl`));
  assert.equal(parents.length, 1, "The canonical parent must resolve to exactly one real JSONL");
  const entries = await readEntries(parents[0]);
  assert.equal(entries.find((entry) => entry.type === "session")?.id, parentId);
  const task = successful(messagesOf(entries), toolId, "task");
  assertTaskArguments(task.call, names);
  const progress = task.result.details?.progress;
  assert.ok(Array.isArray(progress), "The actual asynchronous task must persist its progress set");
  const identities = names.map((name) => {
    const matches = progress.filter((child) => child.assignment === `AGENTS_CHILD_${name}`);
    assert.equal(
      matches.length,
      1,
      "Pair each child by its complete original assignment, never position",
    );
    return { name, rawId: matches[0].id };
  });
  dispatched(task.result, identities, "async");
  for (const identity of identities) {
    assert.match(identity.rawId, /^[A-Za-z0-9_-]+$/u);
    const path = join(parents[0].slice(0, -6), `${identity.rawId}.jsonl`);
    assert.ok(files.includes(path), "Each actual dispatch child must have its own raw JSONL");
    assertOriginalAssignment(await readEntries(path), parents[0], `AGENTS_CHILD_${identity.name}`);
  }
  return { toolId, parentId, children: progress };
}

export async function inspectRecords(runtime, parentId, identities, extras = {}) {
  assert.equal(identities.length, 3, "Do not accept an empty child evidence set");
  const files = await jsonlFiles(join(runtime.configRoot, "agent", "sessions"));
  const parentPath = files.find((path) => basename(path).endsWith(`_${parentId}.jsonl`));
  assert.ok(parentPath, "The stable sidebar parent ID must resolve to its actual JSONL");
  const entries = await readEntries(parentPath);
  assert.equal(entries.find((entry) => entry.type === "session")?.id, parentId);
  const parent = messagesOf(entries);
  const task = successful(parent, "agents-batch-task", "task");
  assertTaskArguments(task.call, ["a", "b", "c"]);
  dispatched(task.result, identities, "async");
  const broadcast = successful(parent, "agents-broadcast", "write");
  assert.deepEqual(broadcast.call.arguments, {
    i: "Broadcasting to actual children",
    path: "agent://all",
    content: "hello",
  });
  assert.ok(
    textOf(broadcast.result.content).length > 0,
    "Real broadcast receipt is required, not just an invocation",
  );
  const waitResults = resultsOf(parent).filter(
    (result) => result.toolName === "wait" && textOf(result.content).includes("AGENTS_DONE_a"),
  );
  assert.equal(
    waitResults.length,
    1,
    "Exactly one explicit wait must retain child a's actual delivered result",
  );
  const wait = successful(parent, waitResults[0].toolCallId, "wait");
  const automatic = entries.filter(
    (entry) => entry.type === "custom_message" && entry.customType === "async-result",
  );
  for (const name of ["b", "c"])
    assert.equal(
      automatic.filter((entry) => textOf(entry.content).includes(`AGENTS_DONE_${name}`)).length,
      1,
      `Require exactly one actual automatic ${name} delivery`,
    );
  const children = [];
  for (const identity of identities) {
    assert.equal(
      identity.canonicalParent,
      parentId,
      "Live and cold views must map to the same parent UUID",
    );
    const path = join(parentPath.slice(0, -6), `${identity.rawId}.jsonl`);
    assert.ok(files.includes(path), `Missing independent child record ${identity.rawId}`);
    const bytes = await readFile(path);
    const childEntries = await readEntries(path);
    const header = childEntries.find((entry) => entry.type === "session");
    assert.ok(header?.id && header.id !== parentId);
    assertOriginalAssignment(childEntries, parentPath, `AGENTS_CHILD_${identity.name}`);
    const messages = messagesOf(childEntries);
    const name = identity.name;
    const prefix = `agents-child-${name}`;
    const write = successful(messages, `${prefix}-write`, "write");
    assert.deepEqual(write.call.arguments, {
      i: `Writing acceptance ${name}`,
      path: name,
      content: name,
    });
    assert.match(
      textOf(write.result.content),
      new RegExp(`Successfully wrote 1 bytes? to (?:[^\\r\\n]*[\\\\/])?${name}$`, "u"),
    );
    const read = successful(messages, `${prefix}-read`, "read");
    assert.deepEqual(read.call.arguments, { i: `Reading acceptance ${name}`, path: name });
    assert.match(
      textOf(read.result.content),
      new RegExp(`(?:^|\\n)(?:\\d+:)?${name}(?:\\n|$)`, "u"),
    );
    const communication = successful(messages, `${prefix}-reply`, "write");
    assert.equal(communication.call.arguments.content, `AGENTS_REPLY_${name}`);
    assert.match(communication.call.arguments.path, /^agent:\/\/[A-Za-z0-9_-]+$/u);
    assert.notEqual(communication.call.arguments.path, "agent://all");
    assert.equal(communication.call.arguments.i, "Replying to actual parent");
    const yielded = successful(messages, `${prefix}-yield`, "yield");
    assert.equal(
      yielded.result.details?.status,
      "success",
      "Successful text cannot replace a real successful yield",
    );
    assert.deepEqual(yielded.call.arguments.data, { result: `AGENTS_DONE_${name}` });
    // 中文原因：父→正在回合中的子代理走 omp irc-bridge.deliver 的 steering 分支（streaming +
    // fromParent），接收端不落 irc:incoming 记录，而落父级 steering 用户消息（prompts/steering/
    // parent-irc.md：角色标签在 from、真实父 ID 在 agent）；peer 与空闲投递仍落 irc:incoming。
    // 两种形式都是真实接收端来源，但广播来源必须恰好一条。
    const broadcast = childEntries.filter((entry) => {
      if (entry.type === "custom_message" && entry.customType === "irc:incoming")
        return textOf(entry.content).includes("hello");
      return (
        entry.type === "message" &&
        entry.message?.role === "user" &&
        /\[Wait interrupted by message\][\s\S]*?<irc\b[^>]*\bagent="[A-Za-z0-9_-]+"[^>]*>\s*hello\s*<\/irc>/u.test(
          textOf(entry.message.content),
        )
      );
    });
    assert.equal(broadcast.length, 1, `Child ${name} needs one actual incoming broadcast source`);
    for (const other of ["a", "b", "c"].filter((candidate) => candidate !== name))
      assert.equal(
        callsOf(messages).some((call) => call.id.startsWith(`agents-child-${other}-`)),
        false,
        "Child records must not cross-contaminate",
      );
    assert.equal(
      (await readFile(join(runtime.requestedWorkspace, name))).equals(Buffer.from(name)),
      true,
      `File ${name} must be exact UTF-8 with no BOM/newline`,
    );
    children.push({
      ...identity,
      parentAgentId: communication.call.arguments.path.slice("agent://".length),
      path,
      sha256: digest(bytes),
      toolIds: callsOf(messages).map((call) => call.id),
      entries: childEntries,
    });
  }
  const parentAgents = new Set(children.map((child) => child.parentAgentId));
  assert.equal(parentAgents.size, 1, "All three real replies target the same actual parent agent");
  const peer = successful(
    messagesOf(children.find((child) => child.name === "a").entries),
    "agents-child-a-peer",
    "write",
  );
  const receiver = children.find((child) => child.name === "b");
  assert.deepEqual(peer.call.arguments, {
    i: "Messaging actual peer",
    path: `agent://${receiver.rawId}`,
    content: "AGENTS_PEER_A_TO_B",
  });
  assert.ok(textOf(peer.result.content).length > 0, "Peer send needs a real receipt");
  const peerIncoming = receiver.entries.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "irc:incoming" &&
      textOf(entry.content).includes("AGENTS_PEER_A_TO_B"),
  );
  assert.equal(
    peerIncoming.length,
    1,
    "Directed peer message must have an independent actual receiver record",
  );
  assert.ok(
    JSON.stringify(peerIncoming[0]).includes(children.find((child) => child.name === "a").rawId),
    "Receiver source must retain the real sender",
  );
  const todoResults = resultsOf(parent).filter((result) => result.toolName === "todo");
  const todoPhase = (name, status, content = name) => ({
    name,
    tasks: [{ content, status }],
  });
  const initialList = [
    { phase: "AGENTS_PRELUDE", items: ["AGENTS_PRELUDE_ITEM"] },
    { phase: "AGENTS_PHASE", items: ["AGENTS_PHASE"] },
  ];
  const prelude = (status) => todoPhase("AGENTS_PRELUDE", status, "AGENTS_PRELUDE_ITEM");
  const replacement = [todoPhase("AGENTS_REPLACEMENT", "completed")];
  // 中文原因：替换和恢复各自经过 init + done，九条调用必须逐条保留真实入参和权威结果。
  const expected = [
    [
      "pending",
      { op: "init", list: initialList },
      [prelude("in_progress"), todoPhase("AGENTS_PHASE", "pending")],
    ],
    [
      "inProgress",
      { op: "done", task: "AGENTS_PRELUDE_ITEM" },
      [prelude("completed"), todoPhase("AGENTS_PHASE", "in_progress")],
    ],
    [
      "completed",
      { op: "done", task: "AGENTS_PHASE" },
      [prelude("completed"), todoPhase("AGENTS_PHASE", "completed")],
    ],
    [
      "replace-init",
      { op: "init", list: [{ phase: "AGENTS_REPLACEMENT", items: ["AGENTS_REPLACEMENT"] }] },
      [todoPhase("AGENTS_REPLACEMENT", "in_progress")],
    ],
    ["replace", { op: "done", task: "AGENTS_REPLACEMENT" }, replacement],
    ["invalid", { op: "done", task: "AGENTS_MISSING_TASK" }, replacement],
    ["clear", { op: "init", list: [] }, []],
    [
      "restore-init",
      { op: "init", list: [{ phase: "AGENTS_PHASE", items: ["AGENTS_PHASE"] }] },
      [todoPhase("AGENTS_PHASE", "in_progress")],
    ],
    ["restore", { op: "done", task: "AGENTS_PHASE" }, [todoPhase("AGENTS_PHASE", "completed")]],
  ];
  const todoCalls = callsOf(parent).filter((call) => call.name === "todo");
  const expectedIds = expected.map(([state]) => `agents-todo-${state}`);
  assert.deepEqual(
    todoCalls.map((call) => call.id),
    expectedIds,
  );
  assert.deepEqual(
    todoResults.map((result) => result.toolCallId),
    expectedIds,
  );
  assert.equal(todoResults.length, 9);
  for (const [index, [state, args, phases]] of expected.entries()) {
    const result = todoResults[index];
    assert.deepEqual(todoCalls[index].arguments, { i: "Updating acceptance todo", ...args });
    assert.equal(
      result.isError === true,
      state === "invalid",
      `Todo ${state} error semantics must be explicit`,
    );
    assert.equal(result.details?.op, args.op);
    assert.equal(result.details?.storage, "session");
    assert.deepEqual(
      result.details?.phases,
      phases,
      `Todo ${state} must persist the exact committed phases and task states`,
    );
    if (state === "invalid") {
      assert.ok(textOf(result.content).includes('Task "AGENTS_MISSING_TASK" not found'));
      assert.equal(result.details.completedTasks, undefined);
    } else if (args.op === "done") {
      const phase = phases.find((item) => item.tasks.some((task) => task.content === args.task));
      assert.deepEqual(result.details.completedTasks, [{ phase: phase.name, content: args.task }]);
    }
  }
  const extraRecords = {};
  for (const [name, identity] of Object.entries(extras)) {
    assert.equal(
      identity.canonicalParent,
      parentId,
      "Failure/control cannot migrate to another parent UUID",
    );
    const spawn = successful(parent, `agents-${name}-task`, "task");
    assertTaskArguments(spawn.call, [name]);
    dispatched(spawn.result, [{ ...identity, name }], "async");
    const path = join(parentPath.slice(0, -6), `${identity.rawId}.jsonl`);
    assert.ok(files.includes(path));
    const childEntries = await readEntries(path);
    assertOriginalAssignment(childEntries, parentPath, `AGENTS_CHILD_${name}`);
    const messages = messagesOf(childEntries);
    if (name === "failure") {
      const yielded = successful(messages, "agents-child-failure-yield", "yield");
      assert.equal(yielded.call.arguments.error, "AGENTS_FAILURE_ACTUAL");
      assert.equal(
        yielded.result.details?.status,
        "aborted",
        "omp yield({error}) persists the genuine unsuccessful child as aborted",
      );
      assert.equal(yielded.result.details?.error, "AGENTS_FAILURE_ACTUAL");
      assert.equal(
        automatic.filter((entry) => textOf(entry.content).includes("AGENTS_FAILURE_ACTUAL")).length,
        1,
      );
    } else {
      assert.equal(name, "control");
      assert.equal(
        messages.filter(
          (message) => message.role === "assistant" && message.stopReason === "aborted",
        ).length,
        1,
        "Stopped control must retain the actual aborted terminal message",
      );
      assert.equal(
        messages.filter(
          (message) =>
            message.role === "user" && textOf(message.content).includes("AGENTS_CONTROL_STEER"),
        ).length,
        1,
      );
      assert.equal(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            textOf(message.content).includes("AGENTS_CONTROL_STEER"),
        ),
        false,
        "Canceled model barrier cannot produce a processed acknowledgment",
      );
    }
    extraRecords[name] = {
      ...identity,
      name,
      path,
      entries: childEntries,
      sha256: digest(await readFile(path)),
      spawn: spawn.result,
    };
  }
  return {
    parentPath,
    parentAgentId: children[0].parentAgentId,
    parent,
    entries,
    children,
    extras: extraRecords,
    dispatch: task.result,
    broadcast: broadcast.result,
    wait: wait.result,
    automatic,
    peerIncoming: peerIncoming[0],
  };
}

export function recordSnapshot(records) {
  return {
    parentEntries: records.entries,
    parentMessages: records.parent,
    children: [...records.children, ...Object.values(records.extras)].map(
      ({ name, rawId, sha256 }) => ({ name, rawId, sha256 }),
    ),
  };
}
