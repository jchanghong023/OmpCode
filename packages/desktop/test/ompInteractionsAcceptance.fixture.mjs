import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedArgs, schemaOf } from "./ompAgentsAcceptance.protocol.mjs";
import {
  LIVE_CASES,
  PROBES,
  UI_TOOL,
  askArguments,
  askTimeout,
  assertAskModelResult,
  callIdFor,
  hash,
  markerFor,
  normalizedPrompt,
  probeArguments,
  probeResult,
  probeSpec,
  promptFor,
  textOf,
} from "./ompInteractionsAcceptance.contract.mjs";

function extensionSource(nonce) {
  // 扩展只请求真实 OMP UI，并将真实返回值摘要交回工具；不写 UI/store/会话事实。
  // OMP 扩展工具默认 discoverable；本固定 UI probe 显式 essential 发布其真实 schema，
  // 避免模型脚本把仅在 xd:// 目录中的工具误当成已在顶层 advertised 的工具。
  return `import { createHash } from 'node:crypto';
export default function (pi) {
  pi.registerTool({
    name: '${UI_TOOL}', label: 'Acceptance real extension UI',
    loadMode: 'essential',
    description: 'Request the named native input/editor and return only a digest of the actual UI response.',
    parameters: { type: 'object', properties: { case: { type: 'string', enum: ${JSON.stringify(PROBES)} } }, required: ['case'], additionalProperties: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const name = params.case;
      if (!${JSON.stringify(PROBES)}.includes(name)) throw new Error('Unknown UI probe');
      const nonce = ${JSON.stringify(nonce)};
      const editor = name.includes('editor');
      const empty = name.startsWith('editor-empty-');
      const title = 'Acceptance ' + name + ' ' + nonce;
      const prefill = '  original ' + nonce + '\\nsecond original line  \\n';
      const value = editor
        ? empty ? await ctx.ui.editor(title) : await ctx.ui.editor(title, prefill)
        : await ctx.ui.input(title, 'Enter the acceptance secret');
      const result = value === undefined ? { case: name, cancelled: true }
        : { case: name, cancelled: false, sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
`;
}

export async function prepareSuite({ root, workspace, configRoot, phase }) {
  assert.ok(phase === "live" || phase === "recovery");
  const nonce = hash(root).slice(0, 16);
  const extensionPath = join(root, "interaction-fixtures", "real-ui-extension.mjs");
  const names = phase === "live" ? LIVE_CASES : ["resume"];
  const verified = [];
  const issued = [];
  let pending;
  let cursor = 0;
  let requestCount = 0;
  return {
    rpcArgs: ["--extension", extensionPath],
    manifest: {
      suite: "interactions",
      nonce,
      extensionPath,
      workspace,
      configRoot,
      publicDraft: `PUBLIC_INTERACTION_DRAFT_${nonce}`,
      liveCases: LIVE_CASES,
    },
    async prepare() {
      if (phase === "live") {
        await mkdir(join(root, "interaction-fixtures"), { recursive: true });
        await writeFile(extensionPath, extensionSource(nonce), "utf8");
      } else {
        assert.equal(
          await readFile(extensionPath, "utf8"),
          extensionSource(nonce),
          "Cold recovery must load the original test-owned extension, not recreate product state",
        );
      }
    },
    handler(context, options) {
      requestCount++;
      assert.equal(
        options.modelId,
        "scripted",
        "Interaction requests must use the configured loopback model",
      );
      assert.ok(Array.isArray(context.messages) && context.messages.length > 0);
      const messages = context.messages;
      const last = messages.at(-1);
      let results =
        last.role === "user" && Array.isArray(last.content)
          ? last.content.filter((part) => part.type === "tool_result")
          : [];
      const assistantCalls = messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => part.type === "tool_use");
      if (pending?.name === "ask-cancel") {
        // OMP 取消 ask 会中断整轮，不发工具结果续轮；只在下次明确用户请求中
        // 核验随真实历史携带的取消结果，再推进脚本，不能为取消伪造助手 marker。
        assert.equal(
          normalizedPrompt(last.content),
          promptFor(names[cursor + 1], nonce),
          "A cancelled ask must stop the turn until the next explicit user submission",
        );
        const cancellations = messages
          .filter((message) => message.role === "user" && Array.isArray(message.content))
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool_result" && part.tool_use_id === pending.id);
        assert.equal(cancellations.length, 1, "The next request must carry one real cancellation");
        const cancellation = cancellations[0];
        const invocations = assistantCalls.filter((call) => call.id === pending.id);
        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].name, pending.tool);
        assert.deepEqual(invocations[0].input, pending.arguments);
        assert.equal(cancellation.is_error, true);
        const output = textOf(cancellation.content);
        assertAskModelResult(pending.name, output, nonce);
        assert.equal(
          messages.filter(
            (message) =>
              message.role === "assistant" &&
              textOf(message.content) === markerFor(pending.name, nonce),
          ).length,
          0,
          "An aborted ask cannot fabricate a completed assistant turn",
        );
        verified.push({
          name: pending.name,
          id: pending.id,
          outputHash: hash(output),
          isError: cancellation.is_error,
        });
        results = results.filter((part) => part.tool_use_id !== pending.id);
        pending = undefined;
        cursor++;
      }
      if (pending) {
        assert.equal(results.length, 1, "Every intent needs exactly its own actual tool result");
        const result = results[0];
        assert.equal(result.tool_use_id, pending.id);
        const invocations = assistantCalls.filter((call) => call.id === pending.id);
        assert.equal(invocations.length, 1, "No cross-conversation or duplicate tool identities");
        assert.equal(invocations[0].name, pending.tool);
        assert.deepEqual(invocations[0].input, pending.arguments);
        const latestPrompt = [...messages]
          .reverse()
          .find((message) => message.role === "user" && textOf(message.content));
        assert.equal(normalizedPrompt(latestPrompt?.content), promptFor(pending.name, nonce));
        const output = textOf(result.content);
        assert.ok(output.length > 0);
        if (pending.name.startsWith("ask-")) {
          assert.equal(result.is_error, false);
          assertAskModelResult(pending.name, output, nonce);
        } else {
          assert.equal(result.is_error, false);
          assert.deepEqual(
            JSON.parse(output),
            probeResult(probeSpec(pending.name, nonce)),
            "Only the real extension UI return value may satisfy this exact hash/cancellation result",
          );
        }
        verified.push({
          name: pending.name,
          id: pending.id,
          outputHash: hash(output),
          isError: result.is_error,
        });
        const marker = markerFor(pending.name, nonce);
        pending = undefined;
        cursor++;
        return { content: [marker] };
      }
      assert.equal(
        results.length,
        0,
        "An unsolicited/duplicate result must not get a generic reply",
      );
      assert.ok(cursor < names.length, "Unexpected extra model request");
      assert.equal(last.role, "user");
      const name = names[cursor];
      assert.equal(
        normalizedPrompt(last.content),
        promptFor(name, nonce),
        "Unknown or out-of-order scenario",
      );
      if (name === "resume") {
        for (const prior of LIVE_CASES.filter((name) => name !== "ask-cancel")) {
          const markers = messages.filter(
            (message) =>
              message.role === "assistant" && textOf(message.content) === markerFor(prior, nonce),
          );
          assert.equal(
            markers.length,
            1,
            `Resume must carry exactly one saved ${prior} completion`,
          );
        }
        const cancelledResults = messages
          .filter((message) => message.role === "user" && Array.isArray(message.content))
          .flatMap((message) => message.content)
          .filter(
            (part) =>
              part.type === "tool_result" && part.tool_use_id === callIdFor("ask-cancel", nonce),
          );
        assert.equal(cancelledResults.length, 1);
        assert.equal(cancelledResults[0].is_error, true);
        assertAskModelResult("ask-cancel", textOf(cancelledResults[0].content), nonce);
        const historicalCalls = assistantCalls.filter(
          (call) => call.id.startsWith(`interactions_`) && call.id.endsWith(nonce),
        );
        assert.deepEqual(
          historicalCalls.map((call) => call.id),
          LIVE_CASES.map((prior) => callIdFor(prior, nonce)),
        );
        verified.push({ name });
        cursor++;
        return { content: [markerFor(name, nonce)] };
      }
      const tool = name.startsWith("ask-") ? "ask" : UI_TOOL;
      const schema = schemaOf(context, tool);
      const args =
        tool === "ask"
          ? askArguments(name, nonce, schema)
          : checkedArgs(schema, probeArguments(name));
      pending = { name, id: callIdFor(name, nonce), tool, arguments: args };
      issued.push({
        name,
        id: pending.id,
        ...(name === "ask-timeout"
          ? { timeout: askTimeout(schema), intentIssuedAt: Date.now() }
          : {}),
      });
      return { content: [{ type: "toolCall", id: pending.id, name: tool, arguments: args }] };
    },
    snapshot: () => ({
      phase,
      requestCount,
      issued,
      verified,
      pending: pending ? { name: pending.name, id: pending.id } : null,
    }),
  };
}
