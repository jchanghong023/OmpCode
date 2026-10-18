import assert from "node:assert/strict";
import { join } from "node:path";
import {
  blocksOf,
  failureYieldArgs,
  incomingSender,
  promptOf,
  publicDispatchIds,
  textOf,
  yieldArgs,
} from "./ompAgentsAcceptance.protocol.mjs";
import { jsonlFiles, readEntries } from "./ompAgentsAcceptance.records.mjs";

export function createChildHandlers({
  configRoot,
  issued,
  observed,
  dispatched,
  assignmentName,
  marker,
  reply,
  call,
  output,
  hasResult,
  hold,
}) {
  async function observePublicDispatch(result, names) {
    // 只读本次真实执行记录：不能制造派发事实，且独立 ID 必须同时存在于实际 HTTP tool_result。
    const sources = [];
    const files = await jsonlFiles(join(configRoot, "agent", "sessions"));
    for (const path of files) {
      const entries = await readEntries(path);
      const results = entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "task" &&
          entry.message.toolCallId === result.tool_use_id,
      );
      if (results.length) sources.push({ path, entries, results });
    }
    assert.equal(
      sources.length,
      1,
      "A model callback must have exactly one actual persisted task owner",
    );
    const source = sources[0];
    assert.equal(source.results.length, 1);
    const invocations = source.entries
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .flatMap((entry) => (Array.isArray(entry.message.content) ? entry.message.content : []))
      .filter(
        (part) =>
          part.type === "toolCall" && part.id === result.tool_use_id && part.name === "task",
      );
    assert.equal(invocations.length, 1);
    assert.deepEqual(
      invocations[0].arguments,
      issued.get(result.tool_use_id).args,
      "Observe only this callback's own exact dispatch",
    );
    const persisted = source.results[0].message;
    assert.notEqual(persisted.isError, true);
    assert.ok(
      Array.isArray(persisted.details?.progress),
      "Configured asynchronous dispatch must expose progress, not synchronous results",
    );
    assert.equal(persisted.details.progress.length, names.length);
    const identities = [];
    for (const child of persisted.details.progress) {
      assert.equal(typeof child.id, "string");
      assert.ok(child.id.length > 0);
      assert.equal(child.agent, child.assignment === "AGENTS_CHILD_b" ? "sonic" : "task");
      assert.ok(
        ["pending", "running"].includes(child.status),
        "Observe a real unfinished asynchronous dispatch, never a substituted synchronous completion",
      );
      const path = join(source.path.slice(0, -6), `${child.id}.jsonl`);
      let entries = [];
      let assignments = [];
      const deadline = Date.now() + 30_000;
      do {
        const currentFiles = await jsonlFiles(join(configRoot, "agent", "sessions"));
        if (currentFiles.includes(path)) {
          entries = await readEntries(path);
          assignments = [
            ...new Set(
              entries
                .filter((entry) => entry.type === "message" && entry.message.role === "user")
                .map((entry) => assignmentName(promptOf(entry.message.content)))
                .filter(Boolean),
            ),
          ];
          if (assignments.length) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.equal(
        entries.find((entry) => entry.type === "session")?.parentSession,
        source.path,
        "Each dispatch must acquire a genuine same-parent child record, not a fixture-created assignment",
      );
      assert.equal(
        assignments.length,
        1,
        "Map names by the real child's original framed assignment, never ID spelling or arrival order",
      );
      assert.equal(child.assignment, `AGENTS_CHILD_${assignments[0]}`);
      identities.push({ name: assignments[0], rawId: child.id });
    }
    return publicDispatchIds(result, identities, names);
  }
  async function child(context, options, name, incoming) {
    const owner =
      name === "control"
        ? "agents-control-task"
        : name === "failure"
          ? "agents-failure-task"
          : "agents-batch-task";
    assert.ok(issued.has(owner), "Child cannot precede a genuine task");
    observed.children[name] ??= {
      assignment: false,
      model: `zcode-mock/${options.modelId}`,
      hello: false,
      writes: false,
      read: false,
      yielded: false,
    };
    const state = observed.children[name];
    assert.equal(
      state.model,
      `zcode-mock/${options.modelId}`,
      `Child ${name} must keep its actual HTTP model identity across callbacks`,
    );
    const messages = context.messages
      .filter((message) => message.role === "user")
      .map((message) => promptOf(message.content));
    const assignment = messages.some((text) => assignmentName(text) === name);
    assert.ok(
      assignment,
      `No actual framed assignment for ${name}; label requests are not child execution`,
    );
    state.assignment = true;
    if (name === "failure") {
      assert.equal(state.yielded, false);
      await hold("failure", options);
      state.yielded = true;
      return call(
        context,
        "agents-child-failure-yield",
        "yield",
        failureYieldArgs(context, "AGENTS_FAILURE_ACTUAL"),
      );
    }
    if (name === "control") {
      state.started = true;
      if (incoming.includes("AGENTS_CONTROL_STEER")) {
        assert.equal(observed.controlSteer, false, "Unexpected repeated detail send");
        observed.controlSteer = true;
        await hold("control-steer", options);
        assert.fail("Control child must be stopped through the actual detail button");
      }
      // 中文原因：结构化子代理的无工具调用回合会进入 yield 阶梯；真实、立即完成的 write
      // 让下一模型轮继续运行，既不阻塞 steering 投递，也让 Stop 有真实在飞请求可取消。
      const index = state.heartbeat ?? 0;
      state.heartbeat = index + 1;
      return call(context, `agents-control-heartbeat-${index}`, "write", {
        i: "Keeping control child active",
        path: "agents-control-scratch",
        content: `control-${index}`,
      });
    }
    const prefix = `agents-child-${name}`;
    if (!state.ready) {
      await hold("start", options);
      state.ready = true;
      return output(`AGENTS_READY_${name}`);
    }
    const allText = messages.join("\n");
    // 中文原因：真实入站信封可能落在 user（父级 steering）或自定义记录（peer/空闲投递）里，
    // 因此按全部模型可见文本解析信封，发送者 ID 只取真实信封字段，不猜文本。
    const wireText = context.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) =>
                [part.text, part.content].filter((value) => typeof value === "string").join("\n"),
              )
              .join("\n"),
      )
      .join("\n");
    const parent = incomingSender(wireText, "hello");
    // 中文原因：omp 对结构化子代理（task.structured 默认开）在“无工具调用的回合”之后必然补发
    // subagent-yield-reminder（executor.runYieldLadder；MAX_YIELD_RETRIES=3，最后一条强制 yield），
    // 且子代理始终处于回合中，父广播按 irc-bridge 的 streaming 分支渲染成父级 steering 消息。
    // 所以“hello 先到”只能在开始真实工作的那一回合要求：等待回合保持真实在飞，由测试在父广播
    // 真实投递之后释放各自闸门；释放后返回等待文本，由携带真实广播的下一回合开始工作。
    if (!parent) {
      assert.ok(
        /Last turn had no tool call[\s\S]{0,16}session idle\. Reminder \d+ of \d+\./u.test(allText),
        `Child ${name} requires the genuine incoming hello with actual parent ID, preceded only by the genuine structured yield reminder`,
      );
      await hold(name, options);
      return output(`AGENTS_WAITING_${name}`);
    }
    state.hello = true;
    if (name === "a" && !hasResult(context, `${prefix}-peer`)) {
      await hold(name, options);
      const peers = dispatched.get("agents-batch-task");
      assert.ok(peers?.b, "Peer destination must come from the real public task receipt");
      return call(context, `${prefix}-peer`, "write", {
        i: "Messaging actual peer",
        path: `agent://${peers.b}`,
        content: "AGENTS_PEER_A_TO_B",
      });
    }
    if (name === "b") {
      const peers = dispatched.get("agents-batch-task");
      assert.ok(peers?.a);
      const peer = incomingSender(wireText, "AGENTS_PEER_A_TO_B") === peers.a;
      if (!peer) {
        // 中文原因：只有 a 的真实定向投递才允许 b 继续。等待不能用纯文本回合反复空转——产品会把
        // 无工具调用的回合当空闲逐条消耗 yield 提醒（第三条强制 yield），b 会在收到 peer 前被迫
        // 结束。所以这一回合保持真实在飞，直到测试在定向投递之后释放 b 闸门；peerReceived 仍只由
        // 模型输入中真的出现 peer 消息的回合置位。
        state.waitingForPeer = true;
        await hold(name, options);
        return output("AGENTS_B_WAITING_FOR_PEER");
      }
      state.peerReceived = true;
    }
    if (!hasResult(context, `${prefix}-reply`)) {
      await hold(name, options);
      return call(context, `${prefix}-reply`, "write", {
        i: "Replying to actual parent",
        // 中文原因：steering 模板的 from 是角色标签，只有 agent 属性是真实父代理 ID；发给
        // 不存在的 ID 会得到真实投递失败，把真实子代理流程打断。
        path: `agent://${parent}`,
        content: reply(name),
      });
    }
    if (!hasResult(context, `${prefix}-write`))
      return call(context, `${prefix}-write`, "write", {
        i: `Writing acceptance ${name}`,
        path: name,
        content: name,
      });
    state.writes = true;
    if (!hasResult(context, `${prefix}-read`))
      return call(context, `${prefix}-read`, "read", {
        i: `Reading acceptance ${name}`,
        path: name,
      });
    state.read = true;
    const read = blocksOf(context.messages, "user", "tool_result").find(
      (part) => part.tool_use_id === `${prefix}-read`,
    );
    assert.match(
      textOf(read.content),
      new RegExp(`(?:^|\\n)(?:\\d+:)?${name}(?:\\n|$)`, "u"),
      `Read must verify exact child ${name} content`,
    );
    if (!hasResult(context, `${prefix}-yield`)) {
      state.yielded = true;
      return call(
        context,
        `${prefix}-yield`,
        "yield",
        yieldArgs(context, { result: marker(name) }),
      );
    }
    assert.fail(`Ended child ${name} must not run another model turn`);
  }
  return { child, observePublicDispatch };
}
