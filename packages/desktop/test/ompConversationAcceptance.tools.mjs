import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkedArgs, schemaOf, textOf as text } from "./ompAgentsAcceptance.protocol.mjs";
import { reveal } from "./ompMockInteractions.assertions.mjs";

// 真实模型请求的 read/write schema 均要求 concise intent i；发起、HTTP 与独立记录共用完整实参。
export function conversationChain(workspace) {
  const first = "CONVERSATION_CHAIN_FIRST\n中文 Ω exact UTF-8\n";
  const path = join(workspace, "conversation-chain-first.txt");
  return [
    {
      id: "conversation_chain_write_first",
      name: "write",
      arguments: { i: "Writing first chain artifact", path, content: first },
    },
    {
      id: "conversation_chain_read_first",
      name: "read",
      arguments: { i: "Reading first chain artifact", path },
    },
    {
      id: "conversation_chain_write_second",
      name: "write",
      arguments: {
        i: "Writing derived chain artifact",
        path: join(workspace, "conversation-chain-second.txt"),
        content: `CONVERSATION_CHAIN_SECOND_FROM_REAL_READ\n${first}`,
      },
    },
  ];
}

export function advertisedCall(context, call) {
  checkedArgs(schemaOf(context, call.name), call.arguments, call.name);
  return { content: [{ type: "toolCall", ...call }] };
}

const expectedCalls = (manifest, count, missing) => [
  ...manifest.chain.slice(0, count),
  ...(missing
    ? [
        {
          id: manifest.toolIds.read,
          name: "read",
          arguments: { i: "Reading missing acceptance file", path: manifest.missingPath },
        },
      ]
    : []),
];

export function readChainText(output, manifest) {
  const header = /^\[([^\r\n]+)#[0-9A-Fa-f]{4}\]\n/u.exec(output);
  if (header) assert.equal(basename(header[1]), basename(manifest.chain[0].arguments.path));
  const body = header ? output.slice(header[0].length) : output;
  const numbered = /^1([:|])/u.exec(body);
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const decoded =
    lines
      .map((line, index) => {
        if (!numbered) return line;
        const prefix = `${index + 1}${numbered[1]}`;
        assert.ok(line.startsWith(prefix), "Read rows must retain exact sequential line numbers");
        return line.slice(prefix.length);
      })
      .join("\n") + "\n";
  assert.equal(
    decoded,
    manifest.chain[0].arguments.content,
    "Read must return all exact written text",
  );
  return decoded;
}

function assertOutput(call, output, manifest, failed) {
  assert.ok(output.length > 0, `${call.id} must contain an actual result`);
  if (failed) {
    assert.match(output, /(?:ENOENT|no such file|not found|does not exist)/iu);
    assert.ok(output.includes("conversation-does-not-exist.txt"));
  } else if (call.name === "read") {
    readChainText(output, manifest);
  } else {
    const escaped = basename(call.arguments.path).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(
      `^(?:\\[([^\\r\\n]+)#[0-9A-Fa-f]{4}\\]\\n)?Successfully wrote ${Buffer.byteLength(call.arguments.content)} bytes to ((?:[^\\r\\n]*[\\\\/])?${escaped})$`,
      "u",
    ).exec(output);
    assert.ok(match, `${call.id} must report the precise real write: ${output}`);
    if (match[1] !== undefined) assert.equal(match[1], match[2]);
  }
}

export function assertProtocolTools(messages, manifest, count, missing = false) {
  const expected = expectedCalls(manifest, count, missing);
  const calls = messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "tool_use");
  const results = messages
    .filter((message) => message.role === "user")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "tool_result");
  assert.deepEqual(
    calls.map((call) => call.id),
    expected.map((call) => call.id),
    "No unknown/repeated tool calls",
  );
  assert.deepEqual(
    results.map((result) => result.tool_use_id),
    expected.map((call) => call.id),
    "No unknown/repeated/missing results",
  );
  const outputs = [];
  for (const [index, call] of expected.entries()) {
    assert.equal(calls[index].name, call.name);
    assert.deepEqual(calls[index].input, call.arguments);
    assert.equal(results[index].is_error, missing && index === expected.length - 1);
    const output = text(results[index].content);
    assertOutput(call, output, manifest, missing && index === expected.length - 1);
    outputs.push(output);
  }
  return outputs;
}

export function assertPersistedTools(records, manifest) {
  const expected = expectedCalls(manifest, 3, true);
  const calls = records
    .filter((record) => record.role === "assistant")
    .flatMap((record) => (Array.isArray(record.content) ? record.content : []))
    .filter((part) => part.type === "toolCall");
  const results = records.filter((record) => record.role === "toolResult");
  assert.deepEqual(
    calls.map((call) => call.id),
    expected.map((call) => call.id),
  );
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    expected.map((call) => call.id),
  );
  for (const [index, call] of expected.entries()) {
    assert.equal(calls[index].name, call.name);
    assert.deepEqual(calls[index].arguments, call.arguments);
    assert.equal(results[index].toolName, call.name);
    assert.equal(results[index].isError, index === 3);
    assertOutput(call, text(results[index].content), manifest, index === 3);
    const callPosition = records.findIndex(
      (record) =>
        record.role === "assistant" &&
        Array.isArray(record.content) &&
        record.content.some((part) => part.type === "toolCall" && part.id === call.id),
    );
    const resultPosition = records.indexOf(results[index]);
    assert.ok(resultPosition > callPosition, "Persist invocation before its actual result");
    if (index < expected.length - 1) {
      const nextPosition = records.findIndex(
        (record) =>
          record.role === "assistant" &&
          Array.isArray(record.content) &&
          record.content.some(
            (part) => part.type === "toolCall" && part.id === expected[index + 1].id,
          ),
      );
      assert.ok(nextPosition > resultPosition, "Next invocation must follow the previous result");
    }
  }
  return results.map((result) => text(result.content));
}

export function chainHttpEvidence(state, manifest) {
  const requests = state.calls.filter((call) => {
    const last = call.messages.at(-1);
    return (
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content.some((part) => part.type === "tool_result")
    );
  });
  assert.equal(requests.length, 4, "Three successful chain followups plus one real missing read");
  let previous = [];
  for (const [index, request] of requests.entries()) {
    const outputs = assertProtocolTools(
      request.messages,
      manifest,
      Math.min(index + 1, 3),
      index === 3,
    );
    assert.deepEqual(
      outputs.slice(0, previous.length),
      previous,
      "Later requests must retain exact earlier results",
    );
    const last = request.messages.at(-1).content.filter((part) => part.type === "tool_result");
    assert.equal(last.length, 1, "One real tool per model boundary");
    assert.equal(last[0].tool_use_id, expectedCalls(manifest, 3, true)[index].id);
    previous = outputs;
  }
  return previous;
}

export async function assertChainFiles(manifest, previous) {
  const files = [];
  for (const call of [manifest.chain[0], manifest.chain[2]]) {
    const bytes = await readFile(call.arguments.path);
    assert.deepEqual(
      bytes,
      Buffer.from(call.arguments.content),
      "Actual workspace bytes must match exactly",
    );
    const info = await stat(call.arguments.path);
    files.push({
      path: call.arguments.path,
      base64: bytes.toString("base64"),
      mtimeMs: info.mtimeMs,
    });
  }
  if (previous)
    assert.deepEqual(files, previous, "Cold recovery must not rewrite or re-execute files");
  return files;
}

export async function assertChainRows(page, manifest, outputs) {
  assert.equal(outputs.length, 4);
  for (const [index, call] of manifest.chain.entries()) {
    const row = page.locator(`[data-tool-call-id="${call.id}"]`);
    await reveal(page, row);
    assert.equal(await row.count(), 1, "Each actual chain call needs its own GUI row");
    assert.equal(await row.getAttribute("data-status"), "completed");
    if (call.name === "read") {
      // Read 的产品入口是文件 chip → 真实文件预览，不要求增加通用展开器。
      await row.getByRole("button", { name: basename(call.arguments.path), exact: true }).click();
      // 侧栏为每个已打开 tab 常驻一个 preview-pane（写 diff 与其他文件预览同时存在），
      // 隔离 GUI 实测 4 个 pane 只有当前激活 tab 的可见；断言必须落在可见的阅读预览上，
      // 否则 getByTestId 触发 strict 冲突、隐藏 pane 也永远不会变成 visible。
      const preview = page.locator('[data-testid="preview-pane"]').filter({ visible: true });
      await preview.waitFor({ state: "visible" });
      for (const line of readChainText(outputs[index], manifest).trimEnd().split("\n"))
        await preview.getByText(line, { exact: false }).first().waitFor({ state: "visible" });
      const escaped = basename(call.arguments.path).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      // 同一关闭文案同时存在于 tab 关闭按钮与（未打开的）标签总览列表，取可见的那个。
      await page
        .getByRole("button", { name: new RegExp(`^(?:关闭|Close) ${escaped}$`, "u") })
        .filter({ visible: true })
        .first()
        .click();
      await preview.waitFor({ state: "hidden" });
    } else {
      const toggle = row.getByTestId(`tool-summary-trigger-${call.id}`);
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        // 隔离 GUI 实测（真实 OMP + 模拟模型，write 摘要行）：摘要行中心是产品真实的文件名
        // chip（内层 <button>，点击打开文件预览并在自己的 onClick 里停止冒泡），Playwright
        // 的 .click() 命中可视中心时点到的就是它，摘要行不会展开，后续内容断言超时。
        // 产品对摘要行显式支持键盘展开（ToolSummaryRow onKeyDown → currentTarget.click()），
        // 这里走同一真实控件上的键盘激活路径，不要求产品为测试改变点击语义。
        await toggle.focus();
        await page.keyboard.press("Enter");
      }
      // 成功 write 按现有设计显示写入内容，不额外要求重复的确认 Result。
      // 精确原生 receipt 另在模型边界和持久记录核对，真实字节由文件断言核对。
      for (const line of call.arguments.content.trimEnd().split("\n"))
        await row.getByText(line, { exact: false }).first().waitFor({ state: "visible" });
    }
  }
}
