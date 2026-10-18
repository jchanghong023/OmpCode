import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import {
  PROTOCOL_V4_LIMITS,
  commandAckSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  type AttachmentRef,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";
import { startRealOmpAttachmentClock } from "./fixtures/realOmpAttachmentClock.js";
import { storedAttachmentUserInputs } from "./fixtures/attachmentAdmissionAssertions.js";
import {
  assertAttachmentReplies,
  strictAttachmentRequests,
  strictRequestContent,
  type AttachmentRequest,
} from "./fixtures/strictAttachmentRequests.js";

// Valid 200×200 images stay below the native core's image transformation threshold.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX/AAAAAP9sof2OAAAAHElEQVR42u3BgQAAAADDoPlTX+EAVQEAAAAAfAYUUAABxFrmKwAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCADIAMgBAREA/8QAFQABAQ" +
    "A".repeat(20) +
    "f/xAAUEAE" +
    "A".repeat(21) +
    "/9oACAEBAAA/AJ+" +
    "A".repeat(208) +
    "//9k=",
  "base64",
);
const callSchema = z.object({
  context: z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }),
});
const blocksSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksSchema
    .parse(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function userInputs(h: RealOmpHarness, fromCall = 0) {
  return h.mock.calls
    .slice(fromCall)
    .flatMap((call: unknown) =>
      callSchema.parse(call).context.messages.filter((message) => message.role === "user"),
    );
}

function requestContent(h: RealOmpHarness, prompt: string, fromCall = 0): unknown {
  return strictRequestContent(h.mock.calls, prompt, fromCall);
}

function imageSources(content: unknown): unknown[] {
  return typeof content === "string"
    ? []
    : blocksSchema
        .parse(content)
        .filter((block) => block.type === "image")
        .map((block) => block.source);
}

async function harness(
  context: TestContext,
  steps: readonly AttachmentRequest[],
  withAttachmentClock = false,
) {
  const script = strictAttachmentRequests(steps);
  const clock = withAttachmentClock ? await startRealOmpAttachmentClock(script.handler) : undefined;
  const h = clock?.h ?? (await startRealOmpHarness({ handler: script.handler }));
  context.after(async () => {
    try {
      script.assertFinished(h.mock.calls);
      h.mock.assertHealthy();
    } finally {
      await h.close();
    }
  });
  let serial = 0;
  function envelope(
    type: "createSession" | "sendText",
    sessionId: string | null,
    text: string,
    attachments?: AttachmentRef[],
  ) {
    return {
      commandId: `local-attachment-${++serial}`,
      clientId: "local-attachment-client",
      sessionId,
      type,
      issuedAt: clock?.now() ?? Date.now(),
      payload:
        type === "createSession"
          ? { workspaceId: "real-e2e-workspace", firstInput: { text, attachments } }
          : { text, attachments },
    };
  }
  async function submit(
    type: "createSession" | "sendText",
    sessionId: string | null,
    text: string,
    attachments?: AttachmentRef[],
  ) {
    return commandAckSchema.parse(
      await h.request("v4/command", envelope(type, sessionId, text, attachments)),
    );
  }
  async function file(
    name: string,
    content: string | Buffer,
    mime = "text/plain",
  ): Promise<AttachmentRef> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const path = join(h.workspace, name);
    await writeFile(path, bytes);
    return { ref: path, fileName: basename(path), mime, bytes: bytes.length };
  }
  async function upload(name: string, bytes: Buffer, mime: string): Promise<AttachmentRef> {
    const owner = {
      connectionId: "local-attachment-connection",
      sessionId: "local-attachment-draft",
      uploadId: `local-upload-${++serial}`,
    };
    const chunkBytes = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
    v4AttachmentBeginResultSchema.parse(
      await h.request("v4/attachment/begin", {
        ...owner,
        fileName: name,
        mime,
        totalBytes: bytes.length,
        totalChunks: Math.ceil(bytes.length / chunkBytes),
        checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      }),
    );
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      v4AttachmentChunkResultSchema.parse(
        await h.request("v4/attachment/chunk", {
          ...owner,
          chunkIndex: offset / chunkBytes,
          dataBase64: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
        }),
      );
    }
    const committed = v4AttachmentCommitResultSchema.parse(
      await h.request("v4/attachment/commit", owner),
    );
    return { ref: committed.ref, fileName: name, mime, bytes: bytes.length };
  }
  return {
    h,
    submit,
    envelope,
    file,
    upload,
    async advanceAttachmentClock(milliseconds: number) {
      assert.ok(clock, "expiry scenarios require the real adapter's controlled clock");
      await clock.advanceBy(milliseconds);
    },
    assertReplies: (sessionId: string) =>
      assertAttachmentReplies(h.rows(sessionId).values(), script.replies),
  };
}

function createdSessionId(ack: CommandAck): string {
  assert.equal(ack.status, "accepted", ack.message ?? "createSession must accept real files");
  assert.equal(ack.result?.type, "createSession");
  return z.object({ sessionId: z.string().min(1) }).parse(ack.result).sessionId;
}

async function completed(h: RealOmpHarness, sessionId: string, count: number) {
  await h.waitUntil(() => {
    const rows = [...h.rows(sessionId).values()];
    const turns = rows.filter((row) => row.kind === "turnHeader");
    const assistants = rows.filter((row) => row.kind === "assistantText");
    return (
      turns.length === count &&
      turns.every((row) => row.state === "completedSuccess") &&
      assistants.length === count &&
      assistants.every(
        (row) => row.state === "complete" && typeof row.text === "string" && row.text.length > 0,
      )
    );
  });
}

function assertTextOrder(content: unknown, markers: string[]) {
  const text = textContent(content);
  const positions = markers.map((marker) => text.indexOf(marker));
  assert.ok(
    positions.every((position) => position >= 0),
    text,
  );
  assert.ok(
    positions.every((position, index) => index === 0 || positions[index - 1]! < position),
    text,
  );
}

test(
  "真实 CLI 读取绝对路径 UTF-8/图片，与上传引用混排且续发重新读取文件",
  { skip: realOmpSkip },
  async (context) => {
    const { h, submit, file, upload, assertReplies } = await harness(context, [
      {
        prompt: "LOCAL_PATH_MIXED_FIRST: inspect these files.",
        files: [
          { name: "uploaded.txt", mime: "text/plain", text: "UPLOADED_FIRST\n" },
          { name: "mbist.md", mime: "text/markdown", text: "# MBIST\n真实首发内容 Ω\n" },
          { name: "last.txt", mime: "text/plain", text: "UPLOADED_LAST\n" },
        ],
        images: [
          { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") },
          { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
        ],
        reply: "LOCAL_MIXED_FIRST_DONE",
      },
      {
        prompt: "LOCAL_PATH_MIXED_NEXT: inspect the changed files.",
        files: [
          { name: "last.txt", mime: "text/plain", text: "UPLOADED_LAST\n" },
          { name: "mbist.md", mime: "text/markdown", text: "续发的新内容 — changed on disk\n" },
          { name: "uploaded.txt", mime: "text/plain", text: "UPLOADED_FIRST\n" },
        ],
        images: [
          { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
          { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") },
        ],
        reply: "LOCAL_MIXED_NEXT_DONE",
      },
    ]);
    const localText = await file(
      "mbist.md",
      "# MBIST\n真实首发内容 Ω\n",
      "text/markdown; charset=utf-8",
    );
    const localImage = await file("local.png", PNG_BYTES, "IMAGE/PNG; charset=binary");
    const uploadedText = await upload(
      "uploaded.txt",
      Buffer.from("UPLOADED_FIRST\n"),
      "text/plain",
    );
    const uploadedImage = await upload("uploaded.jpg", JPEG_BYTES, "image/jpeg");
    const uploadedLast = await upload("last.txt", Buffer.from("UPLOADED_LAST\n"), "text/plain");
    const attachments = [uploadedText, uploadedImage, localText, localImage, uploadedLast];
    const firstPrompt = "LOCAL_PATH_MIXED_FIRST: inspect these files.";
    const sessionId = createdSessionId(
      await submit("createSession", null, firstPrompt, attachments),
    );
    await h.subscribe(sessionId);
    await completed(h, sessionId, 1);
    const first = requestContent(h, firstPrompt);
    assertTextOrder(first, ["UPLOADED_FIRST", "真实首发内容 Ω", "UPLOADED_LAST"]);
    assert.match(textContent(first), /mbist\.md/u);
    assert.deepEqual(imageSources(first), [
      { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") },
      { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
    ]);

    await writeFile(localText.ref, "续发的新内容 — changed on disk\n", "utf8");
    const nextPrompt = "LOCAL_PATH_MIXED_NEXT: inspect the changed files.";
    const fromCall = h.mock.calls.length;
    assert.equal(
      (await submit("sendText", sessionId, nextPrompt, [...attachments].reverse())).status,
      "accepted",
    );
    await completed(h, sessionId, 2);
    const next = requestContent(h, nextPrompt, fromCall);
    assertTextOrder(next, ["UPLOADED_LAST", "续发的新内容 — changed on disk", "UPLOADED_FIRST"]);
    assert.doesNotMatch(textContent(next), /真实首发内容 Ω/u);
    assert.deepEqual(imageSources(next), [
      { type: "base64", media_type: "image/png", data: PNG_BYTES.toString("base64") },
      { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") },
    ]);
    assertReplies(sessionId);
  },
);

test("真实 CLI 接受首发和续发的零字节 UTF-8 路径", { skip: realOmpSkip }, async (context) => {
  const { h, submit, file, assertReplies } = await harness(context, [
    {
      prompt: "LOCAL_EMPTY_FIRST: inspect empty text.",
      files: [{ name: "empty.txt", mime: "text/plain", text: "" }],
      reply: "LOCAL_EMPTY_FIRST_DONE",
    },
    {
      prompt: "LOCAL_EMPTY_NEXT: inspect empty text again.",
      files: [{ name: "empty.txt", mime: "text/plain", text: "" }],
      reply: "LOCAL_EMPTY_NEXT_DONE",
    },
  ]);
  const empty = await file("empty.txt", "");
  const firstPrompt = "LOCAL_EMPTY_FIRST: inspect empty text.";
  const sessionId = createdSessionId(await submit("createSession", null, firstPrompt, [empty]));
  await h.subscribe(sessionId);
  await completed(h, sessionId, 1);
  const first = requestContent(h, firstPrompt);
  assert.match(
    textContent(first),
    /<attached_file name="empty\.txt" mime="text\/plain">\n\n<\/attached_file>/u,
  );
  assert.deepEqual(imageSources(first), []);
  const nextPrompt = "LOCAL_EMPTY_NEXT: inspect empty text again.";
  const fromCall = h.mock.calls.length;
  assert.equal((await submit("sendText", sessionId, nextPrompt, [empty])).status, "accepted");
  await completed(h, sessionId, 2);
  const next = requestContent(h, nextPrompt, fromCall);
  assert.match(
    textContent(next),
    /<attached_file name="empty\.txt" mime="text\/plain">\n\n<\/attached_file>/u,
  );
  assert.deepEqual(imageSources(next), []);
  assertReplies(sessionId);
});

test(
  "真实 CLI 拒绝非法路径、类型、UTF-8、目录、缺失、过期及超限内容，不留下部分输入",
  { skip: realOmpSkip },
  async (context) => {
    const { h, submit, envelope, file, upload, advanceAttachmentClock, assertReplies } =
      await harness(
        context,
        [
          {
            prompt: "LOCAL_REJECTION_SEED: initialize a normal session.",
            reply: "LOCAL_REJECTION_SEED_DONE",
          },
          {
            prompt: "LOCAL_AFTER_REJECTIONS: plain input remains available.",
            reply: "LOCAL_AFTER_REJECTIONS_DONE",
          },
        ],
        true,
      );
    const sessionId = await h.create(
      "local-attachment-rejections",
      "LOCAL_REJECTION_SEED: initialize a normal session.",
    );
    await completed(h, sessionId, 1);
    const good = await file("good.txt", "VALID_PREFIX_MUST_NOT_PARTIALLY_DISPATCH");
    const directoryPath = join(h.workspace, "directory.txt");
    await mkdir(directoryPath);
    const invalidUtf8 = await file("invalid.txt", Buffer.from([0xc3, 0x28]));
    const oversized = await file("oversized.txt", Buffer.alloc(256 * 1024 + 1, 0x61));
    const totals = await Promise.all(
      ["a", "b", "c"].map((part) => file(`total-${part}.txt`, Buffer.alloc(180 * 1024, 0x61))),
    );
    const oversizedImage = await file("oversized.png", PNG_BYTES, "image/png");
    await truncate(oversizedImage.ref, PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1);
    // 缺失引用不等于已提交后过期：先经真实 owner 完成公开上传，再只推进其时钟。
    const expired = await upload("expired.txt", Buffer.from("EXPIRED_UPLOAD_BYTES"), "text/plain");
    assert.match(expired.ref, /^omp-attachment:\/\//u);
    await advanceAttachmentClock(PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs + 1);
    const invalidInputs: [string, AttachmentRef[]][] = [
      ["relative path", [{ ...good, ref: "relative/valid.txt" }]],
      ["unknown URI", [{ ...good, ref: "https://example.invalid/valid.txt" }]],
      ["file URI", [{ ...good, ref: `file://${good.ref}` }]],
      ["missing upload", [{ ...good, ref: "omp-attachment://missing-upload" }]],
      ["expired committed upload", [good, expired]],
      ["unsupported MIME", [{ ...good, mime: "application/pdf" }]],
      ["attachment count", Array.from({ length: 9 }, () => good)],
      [
        "missing regular file",
        [good, { ...good, ref: join(h.workspace, "missing.txt"), fileName: "missing.txt" }],
      ],
      ["directory", [good, { ...good, ref: directoryPath, fileName: "directory.txt" }]],
      ["invalid UTF-8", [good, invalidUtf8]],
      ["actual text bytes exceed understated metadata", [{ ...oversized, bytes: 1 }]],
      ["total text bytes exceed 512 KiB", totals],
      ["actual image bytes exceed understated metadata", [{ ...oversizedImage, bytes: 1 }]],
      [
        "valid image followed by unsupported type",
        [
          await file("valid.png", PNG_BYTES, "image/png"),
          await file("unsupported.pdf", "%PDF-1.7\n", "application/pdf"),
        ],
      ],
    ];
    if (process.platform === "win32") {
      invalidInputs.push(["drive-relative path", [{ ...good, ref: "C:valid.txt" }]]);
      invalidInputs.push(["root-relative path", [{ ...good, ref: "\\valid.txt" }]]);
    } else {
      invalidInputs.push(["foreign Windows path", [{ ...good, ref: "C:\\valid.txt" }]]);
    }
    const callsBefore = h.mock.calls.length;
    const userRowsBefore = [...h.rows(sessionId).values()].filter(
      (row) => row.kind === "userInput",
    ).length;
    const inputRowsBefore = [...h.rows(sessionId).values()].filter(
      (row) => row.kind === "userInput" || row.kind === "turnHeader",
    );
    const storedInputsBefore = await storedAttachmentUserInputs(h);
    assert.equal(storedInputsBefore.length, 1, "the seed must have one real persisted session");
    assert.equal(
      storedInputsBefore[0]!.users.length,
      1,
      "the seed must have one real user message",
    );
    const rejectedPrompts: string[] = [];
    for (const [label, attachments] of invalidInputs) {
      for (const type of ["createSession", "sendText"] as const) {
        const prompt = `LOCAL_REJECT_${rejectedPrompts.length}: ${label}`;
        rejectedPrompts.push(prompt);
        const response = await h.rawRequest(
          "v4/command",
          envelope(type, type === "sendText" ? sessionId : null, prompt, attachments),
        );
        if (label === "expired committed upload") {
          assert.equal(
            response.error,
            undefined,
            `${type}: a valid committed ref must reach command admission`,
          );
        }
        if (response.error !== undefined) {
          assert.equal(
            z.object({ code: z.number() }).parse(response.error).code,
            -32602,
            `${type}: ${label}`,
          );
        } else {
          const ack = commandAckSchema.parse(response.result);
          assert.equal(ack.status, "rejected", `${type}: ${label}`);
          assert.equal(ack.reasonCode, "fault.command.attachmentUnsupportedByOmpCore");
          assert.ok(ack.message, `${type}: ${label} must explain its rejection`);
        }
        assert.equal(h.mock.calls.length, callsBefore, `${type}: ${label} must not invoke a model`);
        assert.deepEqual(
          [...h.rows(sessionId).values()].filter(
            (row) => row.kind === "userInput" || row.kind === "turnHeader",
          ),
          inputRowsBefore,
          `${type}: ${label} must not append user input or an empty turn`,
        );
        if (label === "expired committed upload") {
          assert.deepEqual(
            await storedAttachmentUserInputs(h),
            storedInputsBefore,
            `${type}: expired upload must leave all persisted user inputs and session identities unchanged`,
          );
        }
      }
    }
    assert.equal(h.mock.calls.length, callsBefore, "rejected files must not invoke a model");
    const finalPrompt = "LOCAL_AFTER_REJECTIONS: plain input remains available.";
    assert.equal((await submit("sendText", sessionId, finalPrompt)).status, "accepted");
    await completed(h, sessionId, 2);
    assert.deepEqual(imageSources(requestContent(h, finalPrompt, callsBefore)), []);
    for (const input of userInputs(h, callsBefore)) {
      const text = textContent(input.content);
      for (const prompt of rejectedPrompts) assert.ok(!text.includes(prompt), prompt);
      assert.ok(!text.includes("VALID_PREFIX_MUST_NOT_PARTIALLY_DISPATCH"));
    }
    assert.equal(
      [...h.rows(sessionId).values()].filter((row) => row.kind === "userInput").length,
      userRowsBefore + 1,
    );
    assertReplies(sessionId);
  },
);
