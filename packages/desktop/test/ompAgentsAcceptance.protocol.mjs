import assert from "node:assert/strict";

export const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
export const promptOf = (content) =>
  textOf(content)
    .trim()
    .replace(
      /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
      "",
    );

/**
 * 真实 IRC 入站信封只有上游两种渲染，fixture 只认这两种（伪造文本给不出真实发送者 ID）：
 * - 父级 steering：`<irc from="parent" agent="Main">正文</irc>`（prompts/steering/parent-irc.md）；
 *   `from` 是角色标签，`agent` 才是真实发送者 ID，回信必须指向它。
 * - irc:incoming 记录正文：`<irc>` + “Incoming IRC message from agent \`Acceptance_a\`”
 *   （prompts/system/irc-incoming.md）；空闲投递、peer aside 与子代理回信都是这一种。
 * 返回携带 marker 的信封发送者 ID；没有真实信封时返回 undefined。
 */
export function incomingSender(text, marker) {
  for (const [, attrs, body] of text.matchAll(/<irc\b([^>]*)>([\s\S]*?)<\/irc>/gu)) {
    if (!body.includes(marker)) continue;
    const sender =
      /\bagent="([A-Za-z0-9_-]+)"/u.exec(attrs)?.[1] ??
      /Incoming IRC message from agent `([A-Za-z0-9_-]+)`/u.exec(body)?.[1];
    if (sender) return sender;
  }
  return undefined;
}
export const blocksOf = (messages, role, type) =>
  messages
    .filter((m) => m.role === role)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === type);

export function schemaOf(context, name) {
  const tools = context.tools;
  assert.ok(
    Array.isArray(tools) && tools.length > 0,
    "Real model request must expose public tool schemas",
  );
  const matches = tools.filter((tool) => tool.name === name);
  assert.equal(matches.length, 1, `Require the genuine ${name} tool`);
  const schema = matches[0].input_schema ?? matches[0].parameters;
  assert.ok(schema?.properties, `${name} must expose an object JSON schema`);
  return schema;
}

// Runtime model-visible schemas, not copied product types, define legal tool arguments.
export function checkedArgs(schema, args, path = "tool") {
  if (schema.anyOf || schema.oneOf) {
    const alternatives = schema.anyOf ?? schema.oneOf;
    const failures = [];
    for (const candidate of alternatives) {
      try {
        return checkedArgs(candidate, args, path);
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.fail(`${path} matches no public schema variant: ${failures.join("; ")}`);
  }
  if (schema.enum)
    assert.ok(schema.enum.includes(args), `${path}: invalid enum ${JSON.stringify(args)}`);
  if (schema.const !== undefined) assert.deepEqual(args, schema.const);
  if (schema.type === "object" || schema.properties) {
    assert.ok(args && typeof args === "object" && !Array.isArray(args), `${path}: expected object`);
    for (const key of schema.required ?? [])
      assert.ok(Object.hasOwn(args, key), `${path}: missing ${key}`);
    for (const [key, value] of Object.entries(args)) {
      const field = schema.properties?.[key];
      if (field) checkedArgs(field, value, `${path}.${key}`);
      else {
        // 中文原因：真实 yield.data 显式允许开放对象；未声明开放的工具入参仍逐字段拒绝。
        assert.equal(schema.additionalProperties, true, `${path}: unsupported public field ${key}`);
      }
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(args), `${path}: expected array`);
    if (schema.minItems !== undefined) assert.ok(args.length >= schema.minItems);
    for (const [index, value] of args.entries())
      checkedArgs(schema.items, value, `${path}[${index}]`);
  } else if (schema.type === "integer") assert.ok(Number.isInteger(args), path);
  else if (schema.type === "null") assert.equal(args, null, path);
  else if (schema.type) assert.equal(typeof args, schema.type, path);
  return args;
}

export function todoArgs(context, op, fields = {}) {
  // 中文原因：phases 是真实工具结果，不是入参；写入必须使用公开的 op/list/task 协议。
  return checkedArgs(schemaOf(context, "todo"), {
    i: "Updating acceptance todo",
    op,
    ...fields,
  });
}

export function taskArgs(context, names) {
  const schema = schemaOf(context, "task");
  assert.ok(schema.properties.tasks, "Batch-enabled genuine task schema must expose tasks");
  const items = names.map((name) => ({
    name: `Acceptance_${name}`,
    agent: "task",
    task: `AGENTS_CHILD_${name}`,
    solutionSpace:
      "One exact assignment: use the specified real tools and yield the correlated result.",
  }));
  return checkedArgs(schema, {
    i: "Dispatching acceptance agents",
    context:
      "# Goal\nExecute each exact assigned acceptance task with real tools.\n# Contract\nUse the isolated workspace and report only actual execution results; keep every child identity and message distinct.",
    tasks: items,
  });
}

export function yieldArgs(context, data) {
  const schema = schemaOf(context, "yield");
  assert.ok(schema.properties.data, "Genuine yield must expose result data");
  const args = { data };
  if (schema.properties.status) args.status = "success";
  if (schema.properties.complete) args.complete = true;
  if (schema.properties.key) args.key = 1;
  return checkedArgs(schema, args);
}

export function failureYieldArgs(context, error) {
  const schema = schemaOf(context, "yield");
  assert.ok(schema.properties.error, "Real failure yield must expose its error field");
  const args = { error };
  if (schema.properties.key) args.key = 1;
  if (schema.properties.status) {
    assert.ok(
      schema.properties.status.enum?.includes("failed"),
      "Failure must use the public failed terminal status",
    );
    args.status = "failed";
  }
  if (schema.properties.complete) args.complete = true;
  return checkedArgs(schema, args);
}

export function assertTaskArguments(call, names) {
  assert.deepEqual(call.arguments, {
    i: "Dispatching acceptance agents",
    context:
      "# Goal\nExecute each exact assigned acceptance task with real tools.\n# Contract\nUse the isolated workspace and report only actual execution results; keep every child identity and message distinct.",
    tasks: names.map((name) => ({
      name: `Acceptance_${name}`,
      agent: "task",
      task: `AGENTS_CHILD_${name}`,
      solutionSpace:
        "One exact assignment: use the specified real tools and yield the correlated result.",
    })),
  });
}

export function dispatched(result, identities, mode) {
  const details = result.details;
  assert.ok(details && ["async", "sync"].includes(mode));
  // 中文原因：progress 是异步派发身份，results 是同步执行结果，不能用任意非空数组互相冒充。
  const values = mode === "async" ? details.progress : details.results;
  assert.ok(
    Array.isArray(values),
    `Require ${mode === "async" ? "progress" : "results"} for ${mode} dispatch`,
  );
  assert.equal(values.length, identities.length);
  assert.equal(new Set(values.map((item) => item.id)).size, identities.length);
  assert.deepEqual(
    values.map((item) => item.id).sort(),
    identities.map((child) => child.rawId).sort(),
  );
  for (const identity of identities) {
    const item = values.find((value) => value.id === identity.rawId);
    assert.equal(item.agent, "task");
    assert.equal(item.assignment, `AGENTS_CHILD_${identity.name}`);
    if (mode === "async")
      assert.ok(
        ["pending", "running"].includes(item.status),
        "Async dispatch cannot fabricate a completed child",
      );
    else
      assert.ok(
        Number.isInteger(item.exitCode),
        "Synchronous result must carry actual execution outcome",
      );
  }
}

export function publicDispatchIds(result, identities, names) {
  // 中文原因：名字不规定 ID 格式；独立记录给出的每个原始 ID 必须确实出现在本次模型可见回执中。
  assert.equal(result.is_error, false);
  const text = textOf(result.content);
  assert.equal(identities.length, names.length);
  assert.deepEqual(identities.map((child) => child.name).sort(), [...names].sort());
  assert.equal(new Set(identities.map((child) => child.rawId)).size, names.length);
  const mapping = {};
  for (const { name, rawId } of identities) {
    assert.equal(typeof rawId, "string");
    assert.ok(rawId.length > 0);
    const escaped = rawId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      text,
      new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "u"),
      `Real raw child ID ${rawId} must be fully visible in its actual public task tool_result`,
    );
    mapping[name] = rawId;
  }
  return mapping;
}

export async function barrier(gate, signal) {
  assert.ok(signal, "Gated fixture requires the actual HTTP cancellation signal");
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason ?? new Error("HTTP model request canceled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
