import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentInput } from "../../omp-agent/test/fixtures/ompAttachmentInput.mjs";
import {
  advertisedCall,
  assertProtocolTools,
  conversationChain,
  readChainText,
} from "./ompConversationAcceptance.tools.mjs";

export const C = Object.freeze({
  stream: "CONVERSATION_STREAM",
  stop: "CONVERSATION_STOP",
  afterStop: "CONVERSATION_AFTER_STOP",
  guide: "CONVERSATION_GUIDE_BASE",
  guideInput: "CONVERSATION_GUIDE_INPUT",
  queue: "CONVERSATION_QUEUE_BASE",
  queueStop: "CONVERSATION_QUEUE_STOP",
  afterQueueStop: "CONVERSATION_AFTER_QUEUE_STOP",
  queueFail: "CONVERSATION_QUEUE_FAIL",
  afterQueueFail: "CONVERSATION_AFTER_QUEUE_FAIL",
  attach: "CONVERSATION_ATTACH",
  pdfDraft: "CONVERSATION_PDF_DRAFT",
  chain: "CONVERSATION_TOOL_CHAIN",
  toolFail: "CONVERSATION_READ_MISSING",
  end: "CONVERSATION_LIVE_END",
  recovery: "CONVERSATION_RECOVERY",
});
const steeringNotice =
  "<system-notice>\n" +
  "User interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n" +
  "</system-notice>\n";
export const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
export const promptOf = (content) =>
  textOf(content).replace(
    /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]*'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
    "",
  );
export const latestInput = (messages) =>
  [...messages].reverse().find((message) => message.role === "user" && textOf(message.content));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX/AAAAAP9sof2OAAAAHElEQVR42u3BgQAAAADDoPlTX+EAVQEAAAAAfAYUUAABxFrmKwAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCADIAMgBAREA/8QAFQABAQ" +
    "A".repeat(20) +
    "f/xAAUEAE" +
    "A".repeat(21) +
    "/9oACAEBAAA/AJ+" +
    "A".repeat(208) +
    "//9k=",
  "base64",
);
const ATTACHED_TEXT =
  "GUI_ATTACHMENT_TEXT_FIRST\n中文 Ω actual UTF-8 bytes\nGUI_ATTACHMENT_TEXT_LAST\n";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toolIds = { read: "conversation_missing_read" };

export async function prepareSuite({ root, workspace, configRoot, phase }) {
  assert.ok(["live", "recovery"].includes(phase));
  const inputRoot = join(root, "conversation-inputs");
  const files = [
    { name: "first.png", mime: "image/png", bytes: PNG },
    { name: "second.jpg", mime: "image/jpeg", bytes: JPEG },
    { name: "notes.txt", mime: "text/plain", bytes: Buffer.from(ATTACHED_TEXT) },
    {
      name: "report.pdf",
      mime: "application/pdf",
      bytes: Buffer.from("%PDF-1.4\nPDF_MUST_NOT_REACH_MODEL\n%%EOF\n"),
    },
  ];
  const manifest = {
    root,
    workspace,
    configRoot,
    phase,
    attachedText: ATTACHED_TEXT,
    chain: conversationChain(workspace),
    missingPath: join(workspace, "conversation-does-not-exist.txt"),
    toolIds,
    files: files.map(({ name, mime, bytes }) => ({
      name,
      mime,
      path: join(inputRoot, name),
      bytes: bytes.length,
      sha256: digest(bytes),
      base64: bytes.toString("base64"),
    })),
  };
  const barriers = new Map();
  const seen = [];
  const states = {};
  let cursor = 0;
  const plan =
    phase === "recovery"
      ? [C.recovery]
      : [
          C.stream,
          C.stop,
          C.afterStop,
          C.guide,
          steeringNotice + C.guideInput,
          steeringNotice + C.guideInput,
          steeringNotice + C.guideInput,
          C.queue,
          "hello",
          "hello",
          "hello",
          C.queueStop,
          C.afterQueueStop,
          C.queueFail,
          C.afterQueueFail,
          C.attach,
          C.pdfDraft,
          C.chain,
          "chain-write-first-result",
          "chain-read-first-result",
          "chain-write-second-result",
          C.toolFail,
          "read-result",
          C.end,
        ];
  function barrier(name) {
    assert.equal(barriers.has(name), false, `Duplicate model barrier ${name}`);
    const pending = Promise.withResolvers();
    barriers.set(name, pending);
    states[name] = "waiting";
    return pending.promise;
  }
  function stream(prefix, stages, options) {
    assert.ok(options?.signal, "Streaming requests need the actual HTTP cancellation signal");
    return [
      {
        type: "text",
        deltas: (async function* () {
          yield prefix;
          for (const [name, text] of stages) {
            await barrier(name);
            yield `\n\n${text}`;
          }
        })(),
      },
    ];
  }
  function handler(context, options) {
    assert.ok(cursor < plan.length, "Unexpected extra conversation model request");
    assert.ok(Array.isArray(context.messages) && context.messages.length > 0);
    const expected = plan[cursor];
    const last = context.messages.at(-1);
    const hasResult =
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content.some((block) => block.type === "tool_result");
    if (expected.endsWith("-result")) {
      assert.equal(hasResult, true, `Expected actual tool_result for ${expected}`);
      assert.equal(
        promptOf(latestInput(context.messages)?.content),
        expected === "read-result" ? C.toolFail : C.chain,
        "Dependent tool steps must not require another user submission",
      );
      const count =
        expected === "read-result"
          ? 3
          : [
              "chain-write-first-result",
              "chain-read-first-result",
              "chain-write-second-result",
            ].indexOf(expected) + 1;
      assert.ok(count > 0, `Unknown tool boundary ${expected}`);
      const outputs = assertProtocolTools(
        context.messages,
        manifest,
        count,
        expected === "read-result",
      );
      const prior = seen.filter((entry) => entry.output !== undefined).map((entry) => entry.output);
      assert.deepEqual(
        outputs.slice(0, prior.length),
        prior,
        "Retain exact preceding tool results",
      );
      const results = last.content.filter((block) => block.type === "tool_result");
      assert.equal(results.length, 1);
      assert.equal(
        results[0].tool_use_id,
        expected === "read-result" ? toolIds.read : manifest.chain[count - 1].id,
      );
      cursor++;
      seen.push({ step: expected, output: outputs.at(-1) });
      if (expected === "read-result")
        return { content: ["CONVERSATION_REAL_TOOL_FAILURE_CONFIRMED"] };
      if (count === 3) return { content: ["CONVERSATION_CHAIN_COMPLETE"] };
      const next = structuredClone(manifest.chain[count]);
      if (count === 2)
        next.arguments.content = `CONVERSATION_CHAIN_SECOND_FROM_REAL_READ\n${readChainText(outputs[1], manifest)}`;
      return advertisedCall(context, next);
    }
    assert.equal(hasResult, false, "Unplanned tool_result must not receive a generic reply");
    const input = latestInput(context.messages);
    assert.ok(input, "A request must contain a real user input");
    const prompt = promptOf(input.content);
    if (expected === C.attach) {
      const parsed = attachmentInput(input.content);
      assert.equal(
        parsed.prompt,
        C.attach,
        "Only the exact attachment prompt may receive this response",
      );
      assert.deepEqual(
        parsed.files,
        [{ name: "notes.txt", mime: "text/plain", text: ATTACHED_TEXT }],
        "Attachment metadata and actual UTF-8 bytes must match exactly, regardless of envelope placement",
      );
      assert.deepEqual(parsed.images, [
        { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
        { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") },
      ]);
    } else assert.equal(prompt, expected, `Conversation HTTP request ${cursor + 1} differs`);
    if (expected === "hello" || expected === steeringNotice + C.guideInput) {
      const occurrence = seen.filter((entry) => entry.step === expected).length + 1;
      assert.equal(
        context.messages.filter(
          (message) => message.role === "user" && promptOf(message.content) === expected,
        ).length,
        occurrence,
        "Each HTTP consumption must add exactly one of the equal-text inputs",
      );
    }
    cursor++;
    seen.push({ step: expected });
    if (expected === C.stream)
      return {
        content: stream(
          "STREAM_PREFIX_VISIBLE",
          [
            ["stream-body", "STREAM_BODY_GREW_BEFORE_TERMINAL"],
            ["stream-finish", "STREAM_DONE"],
          ],
          options,
        ),
      };
    if (expected === C.stop)
      return {
        content: stream(
          "STOP_PREFIX_VISIBLE",
          [["stop-late", "STOP_LATE_MUST_NOT_REVIVE"]],
          options,
        ),
      };
    if (expected === C.guide)
      return { content: stream("GUIDE_BASE_PREFIX", [["guide-base", "GUIDE_BASE_DONE"]], options) };
    if (expected === steeringNotice + C.guideInput) {
      const n = seen.filter((entry) => entry.step === expected).length;
      const done = `GUIDE_INPUT_${n}_DONE${n === 3 ? "\n\nGUIDE_INPUT_CONSUMED" : ""}`;
      return {
        content: stream(`GUIDE_INPUT_${n}_STARTED`, [[`guide-input-${n}`, done]], options),
      };
    }
    if (expected === C.queue)
      return { content: stream("QUEUE_BASE_PREFIX", [["queue-base", "QUEUE_BASE_DONE"]], options) };
    if (expected === "hello") {
      const n = seen.filter((entry) => entry.step === "hello").length;
      return {
        content: stream(`HELLO_${n}_STARTED`, [[`hello-${n}`, `HELLO_${n}_DONE`]], options),
      };
    }
    if (expected === C.queueStop)
      return {
        content: stream(
          "QUEUE_STOP_PREFIX",
          [["queue-stop-late", "QUEUE_STOP_LATE_MUST_NOT_REVIVE"]],
          options,
        ),
      };
    if (expected === C.queueFail)
      return {
        content: stream("QUEUE_FAIL_PREFIX", [["queue-fail", "QUEUE_FAIL_BODY"]], options),
        stopReason: "error",
        errorMessage: "CONVERSATION_QUEUE_PROVIDER_FAILURE",
      };
    if (expected === C.chain) {
      assertProtocolTools(context.messages, manifest, 0);
      return advertisedCall(context, manifest.chain[0]);
    }
    if (expected === C.toolFail) {
      assertProtocolTools(context.messages, manifest, 3);
      return advertisedCall(context, {
        id: toolIds.read,
        name: "read",
        arguments: { i: "Reading missing acceptance file", path: manifest.missingPath },
      });
    }
    if (expected === C.recovery) {
      const users = context.messages.filter((message) => message.role === "user");
      for (const marker of [C.stream, C.stop, C.guide, C.queue, C.chain, C.toolFail, C.end])
        assert.equal(
          users.filter((message) => promptOf(message.content) === marker).length,
          1,
          `Cold continuation must carry ${marker} exactly once`,
        );
      assert.equal(users.filter((message) => promptOf(message.content) === "hello").length, 3);
      assert.equal(
        users.filter((message) => promptOf(message.content) === steeringNotice + C.guideInput)
          .length,
        3,
        "Cold continuation must carry all three consumed guide inputs exactly once",
      );
      assertProtocolTools(context.messages, manifest, 3, true);
      const outputs = context.messages
        .filter((message) => message.role === "assistant")
        .map((message) => textOf(message.content))
        .join("\n");
      for (const forbidden of [
        "STOP_LATE_MUST_NOT_REVIVE",
        "QUEUE_STOP_LATE_MUST_NOT_REVIVE",
        "PDF_MUST_NOT_REACH_MODEL",
      ])
        assert.equal(outputs.includes(forbidden), false);
    }
    const replies = {
      [C.afterStop]: "AFTER_STOP_SAME_SESSION_DONE",
      [C.afterQueueStop]: "AFTER_QUEUE_STOP_DONE",
      [C.afterQueueFail]: "AFTER_QUEUE_FAIL_DONE",
      [C.attach]: "ATTACHMENTS_BYTES_ORDER_CONFIRMED",
      [C.pdfDraft]: "PDF_RETAINED_DRAFT_SENT",
      [C.end]: "CONVERSATION_LIVE_COMPLETE",
      [C.recovery]: "CONVERSATION_COLD_CONTINUATION_DONE",
    };
    assert.ok(Object.hasOwn(replies, expected), `No response specified for ${expected}`);
    return { content: [replies[expected]] };
  }
  return {
    manifest,
    handler,
    async prepare() {
      if (phase !== "live") return;
      await mkdir(inputRoot, { recursive: true });
      await Promise.all(files.map((file) => writeFile(join(inputRoot, file.name), file.bytes)));
    },
    snapshot: () => ({ cursor, expectedRequests: plan.length, seen, barriers: { ...states } }),
    async control(action) {
      assert.deepEqual(Object.keys(action).sort(), ["name", "type"]);
      assert.equal(action.type, "release");
      assert.equal(
        states[action.name],
        "waiting",
        "Release only an existing, currently waiting model barrier",
      );
      states[action.name] = "released";
      barriers.get(action.name).resolve();
      return { released: action.name };
    },
  };
}
