import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  barrier,
  blocksOf,
  checkedArgs,
  incomingSender,
  promptOf,
  schemaOf,
  taskArgs,
  textOf,
  todoArgs,
} from "./ompAgentsAcceptance.protocol.mjs";
import { createChildHandlers } from "./ompAgentsAcceptance.children.mjs";
import { createPanelStopModel } from "./ompAgentsAcceptance.panelStop.mjs";

const marker = (name) => `AGENTS_DONE_${name}`;
const reply = (name) => `AGENTS_REPLY_${name}`;
function assignmentName(text) {
  const plain = /^Complete assignment thoroughly:\n\nAGENTS_CHILD_(a|b|c|control|failure)$/u.exec(
    text,
  );
  if (plain) return plain[1];
  const pooled =
    /^Complete assignment thoroughly:\n\n<workpool pool="[A-Za-z0-9_-]+" batch="[A-Za-z0-9_-]+">\n(?:(?!AGENTS_CHILD_)[\s\S])*\n## Item 1\nAGENTS_CHILD_(a|b|c|control|failure)\n<\/workpool>$/u.exec(
      text,
    );
  return pooled?.[1];
}
export async function prepareSuite({ root, workspace, configRoot, phase }) {
  assert.ok(["live", "recovery"].includes(phase));
  const panelStop = createPanelStopModel();
  const issued = new Map();
  const consumed = new Set();
  const labels = new Set();
  const dispatched = new Map();
  let effortCalls = 0;
  const observed = { children: {}, completed: [], todo: [], parent: [], controlSteer: false };
  const gates = new Map();
  for (const name of ["start", "parent", "a", "b", "c", "failure", "control-steer"]) {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(name, { promise, release, released: false });
  }
  function call(context, id, name, args, expectedError = false) {
    assert.ok(!issued.has(id), `Duplicate issuance ${id}`);
    checkedArgs(schemaOf(context, name), args);
    issued.set(id, { name, args, expectedError });
    return { content: [{ type: "toolCall", id, name, arguments: args }] };
  }
  function results(context) {
    // 中文原因：OMP 可在同一轮请求尾部追加真实后台通知；工具回执不一定是最后一条 user。
    // 仅检查最近 assistant 之后的本轮消息，历史回执仍由 consumed 拒绝重复消费。
    const tail = context.messages.slice(
      context.messages.findLastIndex((message) => message.role === "assistant") + 1,
    );
    const values = blocksOf(tail, "user", "tool_result");
    const calls = blocksOf(context.messages, "assistant", "tool_use");
    for (const result of values) {
      const issuedCall = issued.get(result.tool_use_id);
      assert.ok(issuedCall, `Never accept foreign tool result ${result.tool_use_id}`);
      assert.equal(
        calls.filter((tool) => tool.id === result.tool_use_id && tool.name === issuedCall.name)
          .length,
        1,
      );
      // 中文原因：真实 peer 信封可在 wait 执行前抢占；跳过是中断事实，不是完成结果。
      const peerInterrupted =
        issuedCall.name === "wait" &&
        result.is_error === true &&
        textOf(result.content) ===
          "Skipped due to pending peer interrupt. Do not count this skipped result as completed work or verification. After the interrupt is handled on the next step, retry the skipped tool if it is still needed." &&
        ["a", "b", "c"].some((name) =>
          tail.some(
            (message) =>
              message.role === "user" &&
              incomingSender(textOf(message.content), reply(name)) ===
                dispatched.get("agents-batch-task")?.[name],
          ),
        );
      assert.equal(
        result.is_error,
        peerInterrupted || issuedCall.expectedError,
        `Unexpected ${issuedCall.name} result: ${textOf(result.content)}`,
      );
      assert.ok(
        !consumed.has(result.tool_use_id),
        `Extra callback after consumed result ${result.tool_use_id}`,
      );
      consumed.add(result.tool_use_id);
    }
    return values;
  }
  const output = (value) => ({ content: [value] });
  const hasResult = (context, id) =>
    blocksOf(context.messages, "user", "tool_result").some((part) => part.tool_use_id === id);
  const hold = async (name, options) => barrier(gates.get(name).promise, options.signal);
  const { child, observePublicDispatch } = createChildHandlers({
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
  });
  async function handler(context, options) {
    assert.equal(phase, "live", "Cold recovery and read-only tabs must never execute a model");
    assert.equal(
      options.modelId,
      "scripted",
      "All parent/child requests must stay on the isolated model",
    );
    const panelResponse = await panelStop.handler(context, options);
    if (panelResponse !== undefined) return panelResponse;
    const received = results(context);
    const users = context.messages.filter((message) => message.role === "user");
    const lastPrompt = promptOf(users.at(-1)?.content);
    const allPrompts = users.map((message) => promptOf(message.content));
    const label = /^<user>\nAGENTS_CHILD_(a|b|c|control|failure)\n<\/user>$/u.exec(lastPrompt);
    if (label) {
      assert.ok(
        issued.has(
          label[1] === "control"
            ? "agents-control-task"
            : label[1] === "failure"
              ? "agents-failure-task"
              : "agents-batch-task",
        ),
      );
      assert.equal(labels.has(label[1]), false, "Task labels may not replay or count as execution");
      labels.add(label[1]);
      return output(`<title>Acceptance ${label[1]}</title>`);
    }
    const effort =
      "State:\n<solution_space>One exact assignment: use the specified real tools and yield the correlated result.</solution_space>\n\nAnswer with exactly one of: `low`, `medium`, `high`, `xhigh`.\nDo not execute this state; judge it only.";
    if (lastPrompt === effort) {
      assert.ok(
        ["agents-batch-task", "agents-control-task", "agents-failure-task"].some((id) =>
          issued.has(id),
        ),
      );
      effortCalls++;
      const limit = issued.has("agents-control-task")
        ? 5
        : issued.has("agents-failure-task")
          ? 4
          : 3;
      assert.ok(effortCalls <= limit, "Reject additional unconfigured effort-judgment calls");
      return output("low");
    }
    const childName = allPrompts.map(assignmentName).find(Boolean);
    if (childName) return child(context, options, childName, lastPrompt);
    const todo = allPrompts
      .map((text) =>
        /^AGENTS_TODO_(pending|inProgress|completed|replace|invalid|clear|restore)$/u.exec(text),
      )
      .filter(Boolean)
      .at(-1)?.[1];
    if (
      todo &&
      (
        allPrompts.findLast((text) => /^AGENTS_(?:TODO|PARALLEL|CONTROL)/u.test(text)) ?? ""
      ).startsWith("AGENTS_TODO_")
    ) {
      // 中文原因：init 自动启动首条 pending；用前置阶段保留目标条目的真实 pending 状态。
      const initial = [
        { phase: "AGENTS_PRELUDE", items: ["AGENTS_PRELUDE_ITEM"] },
        { phase: "AGENTS_PHASE", items: ["AGENTS_PHASE"] },
      ];
      const title = todo === "replace" ? "AGENTS_REPLACEMENT" : "AGENTS_PHASE";
      const steps = {
        pending: [{ op: "init", list: initial }],
        inProgress: [{ op: "done", task: "AGENTS_PRELUDE_ITEM" }],
        completed: [{ op: "done", task: "AGENTS_PHASE" }],
        replace: [
          { op: "init", list: [{ phase: title, items: [title] }] },
          { op: "done", task: title },
        ],
        // 合法公开入参指向不存在的任务，取得真实业务失败；不绕过 checkedArgs。
        invalid: [{ op: "done", task: "AGENTS_MISSING_TASK" }],
        clear: [{ op: "init", list: [] }],
        restore: [
          { op: "init", list: [{ phase: title, items: [title] }] },
          { op: "done", task: title },
        ],
      }[todo];
      for (const [index, { op, ...fields }] of steps.entries()) {
        const id = `agents-todo-${todo}${index === steps.length - 1 ? "" : "-init"}`;
        if (!issued.has(id))
          return call(context, id, "todo", todoArgs(context, op, fields), todo === "invalid");
        assert.ok(
          hasResult(context, id),
          `Todo ${todo} step ${index} requires its exact actual result`,
        );
      }
      assert.ok(
        received.some((result) => result.tool_use_id === `agents-todo-${todo}`),
        "Todo completion requires its exact final actual result",
      );
      observed.todo.push(todo);
      // 中文原因：未完成状态留给真实 GUI 用户观察和推进，不关闭 OMP 原生停止提醒。
      const next = ["pending", "inProgress"].includes(todo)
        ? "\n\nPlease inspect the todo panel. Are you ready to continue to the next todo state?"
        : "";
      return output(`AGENTS_TODO_ACK_${todo}${next}`);
    }
    for (const result of received.filter((part) =>
      ["agents-batch-task", "agents-control-task", "agents-failure-task"].includes(
        part.tool_use_id,
      ),
    )) {
      const names = issued
        .get(result.tool_use_id)
        .args.tasks.map((task) => task.task.slice("AGENTS_CHILD_".length));
      assert.equal(dispatched.has(result.tool_use_id), false);
      dispatched.set(result.tool_use_id, await observePublicDispatch(result, names));
    }
    const scenario = allPrompts.findLast((text) =>
      ["AGENTS_PARALLEL", "AGENTS_CONTROL_PARENT", "AGENTS_FAILURE_PARENT"].includes(text),
    );
    if (scenario === "AGENTS_FAILURE_PARENT") {
      if (!issued.has("agents-failure-task"))
        return call(context, "agents-failure-task", "task", taskArgs(context, ["failure"]));
      if (received.some((result) => result.tool_use_id === "agents-failure-task"))
        return output("AGENTS_FAILURE_READY");
      assert.ok(
        observed.children.failure?.yielded && lastPrompt.includes("AGENTS_FAILURE_ACTUAL"),
        "Only a genuine failure result may wake the parent",
      );
      assert.equal(
        observed.parent.includes("failure-result"),
        false,
        "Reject duplicate failure-result callbacks",
      );
      observed.parent.push("failure-result");
      return output("AGENTS_FAILURE_RECEIVED");
    }
    if (scenario === "AGENTS_CONTROL_PARENT") {
      if (!issued.has("agents-control-task"))
        return call(context, "agents-control-task", "task", taskArgs(context, ["control"]));
      if (received.some((result) => result.tool_use_id === "agents-control-task"))
        return output("AGENTS_CONTROL_READY");
      const controlledId = dispatched.get("agents-control-task")?.control;
      assert.ok(
        observed.controlSteer &&
          controlledId &&
          lastPrompt.includes(controlledId) &&
          /abort|cancel|stop/iu.test(lastPrompt),
        "Require the actual stopped raw child identity and stop delivery after genuine user intervention",
      );
      assert.equal(
        observed.parent.includes("control-stop"),
        false,
        "Reject duplicate stopped-child callbacks",
      );
      observed.parent.push("control-stop");
      return output("AGENTS_CONTROL_STOPPED");
    }
    assert.equal(
      scenario,
      "AGENTS_PARALLEL",
      `Unknown agents model input: ${JSON.stringify(lastPrompt)}`,
    );
    if (!issued.has("agents-batch-task"))
      return call(context, "agents-batch-task", "task", taskArgs(context, ["a", "b", "c"]));
    if (!issued.has("agents-broadcast")) {
      assert.ok(received.some((result) => result.tool_use_id === "agents-batch-task"));
      await hold("parent", options);
      return call(context, "agents-broadcast", "write", {
        i: "Broadcasting to actual children",
        path: "agent://all",
        content: "hello",
      });
    }
    const waits = [...issued.keys()].filter((id) => id.startsWith("agents-wait-"));
    const delivered = received.find((result) => result.tool_use_id.startsWith("agents-wait-"));
    const completedA =
      textOf(delivered?.content).includes(marker("a")) ||
      (lastPrompt.includes(`<task-result id="${dispatched.get("agents-batch-task")?.a}"`) &&
        lastPrompt.includes(marker("a")));
    // 中文原因：同批 async-result 不属于 wait 正文；只允许真实成功 wait 的结果，
    // 或正常消息中断加同回合独立完成通知，跳过的错误回执不能证明消费成功。
    const waitReceipt = blocksOf(context.messages, "user", "tool_result").find(
      (result) =>
        result.tool_use_id.startsWith("agents-wait-") &&
        result.is_error !== true &&
        (textOf(result.content).includes(reply("a")) ||
          textOf(result.content).includes(marker("a")) ||
          (result === delivered &&
            textOf(result.content) === "Wait interrupted by message." &&
            completedA)),
    );
    if (completedA) {
      assert.ok(
        waitReceipt,
        "Completion requires a real successful wait receipt correlated with a",
      );
      assert.ok(observed.children.a?.yielded, "Wait must follow actual a yield");
      observed.parent.push("wait-a");
      return output("AGENTS_WAIT_A_RECEIVED");
    }
    if (!observed.parent.includes("wait-a")) {
      const first = received.some((result) => result.tool_use_id === "agents-broadcast");
      const interrupted = /AGENTS_REPLY_(a|b|c)/u.test(lastPrompt + textOf(delivered?.content));
      assert.ok(
        first || interrupted,
        "Wait may resume only for a genuine broadcast receipt or actual child reply",
      );
      assert.ok(waits.length < 5, "Reject an unbounded wait retry loop");
      if (first) observed.parent.push("broadcast");
      return call(context, `agents-wait-${waits.length}`, "wait", {});
    }
    const newlyDelivered = ["b", "c"].filter(
      (name) => lastPrompt.includes(marker(name)) && !observed.completed.includes(name),
    );
    // 中文原因：真实子代理回信走 irc:incoming 模板（`<irc>` + “Incoming IRC message from agent …”），
    // 父级 steering 的 `<irc … from=…>` 只用于父→子方向，所以按信封正文识别，并要求发送者就是
    // 本次公开派发回执里的真实子代理 ID（伪造文本给不出真实 ID）。
    const replied = ["b", "c"].find(
      (candidate) =>
        incomingSender(lastPrompt, `AGENTS_REPLY_${candidate}`) ===
        dispatched.get("agents-batch-task")?.[candidate],
    );
    if (replied && newlyDelivered.length === 0) {
      observed.parent.push(`reply-${replied}`);
      assert.equal(
        observed.parent.filter((item) => item === `reply-${replied}`).length,
        1,
        "Duplicate communication callback",
      );
      return output(`AGENTS_COMMUNICATION_${replied}_RECEIVED`);
    }
    assert.ok(
      newlyDelivered.length > 0,
      `Unexpected or duplicate background delivery: ${JSON.stringify(lastPrompt)}`,
    );
    for (const name of newlyDelivered) {
      assert.ok(
        observed.children[name]?.yielded,
        `Auto delivery cannot precede genuine ${name} yield`,
      );
      observed.completed.push(name);
    }
    return output(
      observed.completed.length === 2
        ? "AGENTS_ALL_COMPLETED"
        : `AGENTS_AUTO_${newlyDelivered.join("_")}`,
    );
  }
  return {
    handler,
    async prepare() {
      if (phase !== "live") return;
      const path = join(configRoot, "agent", "config.yml");
      const config = JSON.parse(await readFile(path, "utf8"));
      config.async = { ...config.async, enabled: true };
      config.task = { ...config.task, batch: true, structured: true };
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    },
    control(action) {
      assert.equal(action?.type, "release");
      assert.ok(gates.has(action.gate), "Only declared model barriers may be released");
      const gate = gates.get(action.gate);
      assert.equal(gate.released, false, `Barrier ${action.gate} already released`);
      gate.released = true;
      gate.release();
      return { released: action.gate };
    },
    snapshot: () => ({
      ...observed,
      panelStop: panelStop.snapshot(),
      issued: [...issued.keys()],
      consumed: [...consumed],
      dispatched: Object.fromEntries(dispatched),
    }),
    manifest: {
      root,
      workspace,
      files: ["a", "b", "c"],
      finalContents: { a: "a", b: "b", c: "c" },
    },
  };
}
