// 真实已安装 OMP → omp-agent → v4 公开协议；只有模型响应由本地模拟服务提供。
// 上传的实际 Anthropic 请求、真实工具落盘和有序 wire 分别作为跨边界证据。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  commandAckSchema,
  PROTOCOL_V4_LIMITS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  realOmpSkip,
  startRealOmpHarness,
  type RealOmpHarness,
} from "./fixtures/realOmpHarness.js";

import {
  assertAttachmentReplies,
  strictAttachmentRequests,
  strictRequestContent,
} from "./fixtures/strictAttachmentRequests.js";
import { attachmentInput } from "./fixtures/ompAttachmentInput.mjs";
import {
  assertWireAndOrdinals,
  callSchema,
  imageSources,
  textContent,
} from "./fixtures/adapterAssertions.js";
const WORKSPACE_ID = "real-e2e-workspace";

function requestContent(harness: RealOmpHarness, prompt: string, fromCall = 0): unknown {
  return strictRequestContent(harness.mock.calls, prompt, fromCall);
}

async function command(
  harness: RealOmpHarness,
  sessionId: string | null,
  commandId: string,
  type: string,
  payload: unknown,
) {
  return commandAckSchema.parse(
    await harness.request("v4/command", {
      commandId,
      clientId: "adapter-real-client",
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    }),
  );
}

async function waitCompleted(harness: RealOmpHarness, sessionId: string, count: number) {
  await harness.waitUntil(() => {
    const rows = [...harness.rows(sessionId).values()];
    const headers = rows.filter((row) => row.kind === "turnHeader");
    const assistants = rows.filter((row) => row.kind === "assistantText");
    // 成功头不能替代真实正文；也不能把额外生成的一轮悄悄算成预期轮数。
    return (
      headers.length === count &&
      headers.every((row) => row.state === "completedSuccess") &&
      assistants.length >= count &&
      assistants.every(
        (row) => row.state === "complete" && typeof row.text === "string" && row.text.length > 0,
      )
    );
  });
}

async function uploadFixture(
  harness: RealOmpHarness,
  uploadId: string,
  sessionId: string,
  mime: string,
  bytes: Buffer,
  chunkBytes: number = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
): Promise<{ ref: string; fileName: string; mime: string; bytes: number }> {
  const extension =
    mime === "application/pdf"
      ? "pdf"
      : mime === "text/plain"
        ? "txt"
        : mime === "image/jpeg"
          ? "jpg"
          : "png";
  const fileName = `${uploadId}.${extension}`;
  const common = { connectionId: "adapter-attachments", uploadId, sessionId };
  const begun = v4AttachmentBeginResultSchema.parse(
    await harness.request("v4/attachment/begin", {
      ...common,
      fileName,
      mime,
      totalBytes: bytes.length,
      totalChunks: Math.ceil(bytes.length / chunkBytes),
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }),
  );
  assert.equal(begun.state, "staging");
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    v4AttachmentChunkResultSchema.parse(
      await harness.request("v4/attachment/chunk", {
        ...common,
        chunkIndex: offset / chunkBytes,
        dataBase64: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
      }),
    );
  }
  const { ref } = v4AttachmentCommitResultSchema.parse(
    await harness.request("v4/attachment/commit", common),
  );
  return { ref, fileName, mime, bytes: bytes.length };
}

test("真实 OMP 附件：图片字节/顺序、文本注入和 PDF 提前拒绝", { skip: realOmpSkip }, async () => {
  // 完整的 200×200 红 PNG / 灰阶 JPEG 远小于真核的 128KB 原样保留阈值。
  // 精确的小型夹具不触发缩放/转码，仍逐字节验证实际模型请求。
  const firstBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX/AAAAAP9sof2OAAAAHElEQVR42u3BgQAAAADDoPlTX+EAVQEAAAAAfAYUUAABxFrmKwAAAABJRU5ErkJggg==",
    "base64",
  );
  const secondBytes = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCADIAMgBAREA/8QAFQABAQ" +
      "A".repeat(20) +
      "f/xAAUEAE" +
      "A".repeat(21) +
      "/9oACAEBAAA/AJ+" +
      "A".repeat(208) +
      "//9k=",
    "base64",
  );
  const script = strictAttachmentRequests([
    {
      prompt: "Inspect the first attached image.",
      images: [{ type: "base64", media_type: "image/png", data: firstBytes.toString("base64") }],
      reply: "ATTACHMENT_FIRST_IMAGE_DONE",
    },
    {
      prompt: "Inspect these two images in their supplied order.",
      images: [
        { type: "base64", media_type: "image/jpeg", data: secondBytes.toString("base64") },
        { type: "base64", media_type: "image/png", data: firstBytes.toString("base64") },
      ],
      reply: "ATTACHMENT_ORDERED_IMAGES_DONE",
    },
    {
      prompt: "Read the attached note.",
      files: [{ name: "note.txt", mime: "text/plain", text: "TEXT_ATTACHMENT_OK" }],
      reply: "ATTACHMENT_TEXT_DONE",
    },
    { prompt: "Continue without attachments.", reply: "ATTACHMENT_PLAIN_DONE" },
  ]);
  const harness = await startRealOmpHarness({ handler: script.handler });
  try {
    const first = await uploadFixture(
      harness,
      "image-first",
      "draft-image-test",
      "image/png",
      firstBytes,
      32,
    );
    const created = await command(harness, null, "attachment-create", "createSession", {
      workspaceId: WORKSPACE_ID,
      firstInput: { text: "Inspect the first attached image.", attachments: [first] },
    });
    assert.equal(created.status, "accepted");
    const sessionId = z.object({ sessionId: z.string().min(1) }).parse(created.result).sessionId;
    await harness.subscribe(sessionId);
    await waitCompleted(harness, sessionId, 1);
    assert.deepEqual(imageSources(requestContent(harness, "Inspect the first attached image.")), [
      { type: "base64", media_type: "image/png", data: firstBytes.toString("base64") },
    ]);

    const second = await uploadFixture(
      harness,
      "image-second",
      sessionId,
      "image/jpeg",
      secondBytes,
    );
    const sent = await command(harness, sessionId, "attachment-second", "sendText", {
      text: "Inspect these two images in their supplied order.",
      attachments: [second, first],
    });
    assert.equal(sent.status, "accepted");
    await waitCompleted(harness, sessionId, 2);
    assert.deepEqual(
      imageSources(requestContent(harness, "Inspect these two images in their supplied order.")),
      [
        { type: "base64", media_type: "image/jpeg", data: secondBytes.toString("base64") },
        { type: "base64", media_type: "image/png", data: firstBytes.toString("base64") },
      ],
    );

    const pdf = await uploadFixture(
      harness,
      "document",
      sessionId,
      "application/pdf",
      Buffer.from("%PDF-test"),
    );
    const callsBeforePdf = harness.mock.calls.length;
    const rowsBeforePdf = [...harness.rows(sessionId).values()].filter(
      (row) => row.kind === "userInput",
    ).length;
    const rejected = await command(harness, sessionId, "attachment-pdf", "sendText", {
      text: "Read the PDF.",
      attachments: [pdf],
    });
    assert.equal(rejected.status, "rejected");
    assert.match(
      rejected.message ?? "",
      /document\.pdf: unsupported attachment type application\/pdf/u,
    );

    const text = await uploadFixture(
      harness,
      "note",
      sessionId,
      "text/plain",
      Buffer.from("TEXT_ATTACHMENT_OK", "utf8"),
      3,
    );
    assert.equal(
      (
        await command(harness, sessionId, "attachment-text", "sendText", {
          text: "Read the attached note.",
          attachments: [text],
        })
      ).status,
      "accepted",
    );
    await waitCompleted(harness, sessionId, 3);
    // 下一个模型请求必须属于文本附件，而不是先前被拒的 PDF；拒绝也不创建输入行。
    const textRequest = requestContent(harness, "Read the attached note.", callsBeforePdf);
    assert.match(textContent(textRequest), /Read the attached note\./u);
    assert.match(textContent(textRequest), /note\.txt/u);
    assert.match(textContent(textRequest), /TEXT_ATTACHMENT_OK/u);
    assert.doesNotMatch(textContent(textRequest), /Read the PDF\./u);
    assert.deepEqual(imageSources(textRequest), []);
    assert.equal(
      [...harness.rows(sessionId).values()].filter((row) => row.kind === "userInput").length,
      rowsBeforePdf + 1,
    );

    assert.equal(
      (
        await command(harness, sessionId, "attachment-plain", "sendText", {
          text: "Continue without attachments.",
        })
      ).status,
      "accepted",
    );
    await waitCompleted(harness, sessionId, 4);
    const plain = requestContent(harness, "Continue without attachments.");
    assert.match(textContent(plain), /Continue without attachments\./u);
    assert.deepEqual(imageSources(plain), []);
    for (const call of harness.mock.calls) {
      for (const message of callSchema.parse(call).context.messages) {
        if (message.role === "user")
          assert.doesNotMatch(textContent(message.content), /Read the PDF\./u);
      }
    }
    harness.mock.assertHealthy();
    script.assertFinished(harness.mock.calls);
    assertAttachmentReplies(harness.rows(sessionId).values(), script.replies);
  } finally {
    await harness.close();
  }
});

test(
  "真实 write：无审批执行、流式参数、落盘/fileChanges 与合法有序 wire",
  { skip: realOmpSkip },
  async () => {
    const fileName = "greeting-real.txt";
    const content = "Hello from real OMP\nSecond line\n";
    const toolCallId = "adapter-write";
    const before = "Preparing the requested file. ";
    const after = "Write completed.";
    const prompt = "Write a two-line greeting file.";
    let requestCount = 0;
    const harness = await startRealOmpHarness({
      handler(context: unknown) {
        const messages = callSchema.shape.context.parse(context).messages;
        const requestIndex = requestCount++;
        assert.ok(requestIndex < 2, "write 只允许初始请求和一次真实工具结果回传");
        assert.equal(messages.length, requestIndex === 0 ? 1 : 3);
        assert.equal(messages[0]!.role, "user");
        assert.deepEqual(attachmentInput(messages[0]!.content), {
          prompt,
          files: [],
          images: [],
        });
        if (requestIndex === 0) {
          return {
            content: [
              before,
              {
                type: "toolCall",
                id: toolCallId,
                name: "write",
                deltas: [
                  '{"path":"greeting-',
                  'real.txt","content":',
                  JSON.stringify(content),
                  "}",
                ],
              },
            ],
          };
        }
        assert.equal(messages[1]!.role, "assistant");
        assert.deepEqual(
          z
            .array(z.looseObject({ type: z.string() }))
            .parse(messages[1]!.content)
            .map((block) =>
              block.type === "text"
                ? { type: block.type, text: block.text }
                : { type: block.type, id: block.id, name: block.name, input: block.input },
            ),
          [
            { type: "text", text: before },
            {
              type: "tool_use",
              id: toolCallId,
              name: "write",
              input: { path: fileName, content },
            },
          ],
          "流式参数完成后，回传工具结果必须属于同一对话中精确发出的 write 调用",
        );
        assert.equal(messages[2]!.role, "user");
        const results = z
          .array(
            z.looseObject({
              type: z.literal("tool_result"),
              tool_use_id: z.string(),
              is_error: z.boolean(),
              content: z.unknown(),
            }),
          )
          .parse(messages[2]!.content);
        assert.equal(results.length, 1, "不接受丢失、重复或额外工具结果");
        const result = results[0]!;
        assert.equal(result.tool_use_id, toolCallId);
        assert.equal(result.is_error, false);
        const output = textContent(result.content);
        const written =
          /^(?:\[([^\r\n]+)#[0-9A-Fa-f]{4}\]\n)?Successfully wrote (\d+) bytes to ((?:[^\r\n]*[\\/])?greeting-real\.txt)$/u.exec(
            output,
          );
        assert.ok(written, `write 必须回传精确字节数和目标路径: ${output}`);
        assert.equal(Number(written[2]), Buffer.byteLength(content, "utf8"));
        const writtenPath = written[3]!.replaceAll("\\", "/");
        assert.ok(
          [fileName, join(harness.workspace, fileName).replaceAll("\\", "/")].includes(writtenPath),
          "不可接受其他目录中的同名文件",
        );
        if (written[1]) assert.equal(written[1], written[3], "快照路径与实际写入路径必须一致");
        return { content: [after] };
      },
    });
    try {
      const created = await command(harness, null, "adapter-write-create", "createSession", {
        workspaceId: WORKSPACE_ID,
      });
      assert.equal(created.status, "accepted");
      const sessionId = z.object({ sessionId: z.string().min(1) }).parse(created.result).sessionId;
      const subscription = z.object({ ack: z.object({ subscriptionId: z.string() }) }).parse(
        await harness.request("v4/conversation/subscribe", {
          topic: `conversation/${sessionId}`,
          connectionId: "adapter-write",
          clientMode: "desktop-continuous",
        }),
      );
      assert.equal(
        (await command(harness, sessionId, "adapter-write-send", "sendText", { text: prompt }))
          .status,
        "accepted",
      );
      await waitCompleted(harness, sessionId, 1);
      const rows = [...harness.rows(sessionId).values()];
      assert.ok(rows.some((row) => row.kind === "userInput" && row.text === prompt));
      assert.equal(
        rows
          .filter((row) => row.kind === "assistantText")
          .map((row) => String(row.text ?? ""))
          .join(""),
        before + after,
      );
      const tool = rows.find((row) => row.kind === "toolCall" && row.toolName === "write");
      assert.ok(tool, "工具行必须来自真实 write 执行");
      assert.equal(tool.toolCallId, toolCallId);
      assert.equal(tool.status, "success");
      assert.deepEqual(tool.input, { path: fileName, content });
      assert.deepEqual(harness.state(sessionId).pendingInteractions, []);
      const header = rows.find((row) => row.kind === "turnHeader");
      assert.ok(header);
      assert.equal(header.state, "completedSuccess");
      const changes = z
        .object({
          files: z.number(),
          items: z.array(
            z.object({ path: z.string(), additions: z.number(), deletions: z.number() }),
          ),
        })
        .parse(
          await harness.request("v4/conversation/fileChanges", {
            sessionId,
            target: { rowId: header.rowId, entityId: header.entityId },
            baseRevision: 0,
            baseLogEpoch: "omp",
          }),
        );
      assert.equal(await readFile(join(harness.workspace, fileName), "utf8"), content);
      assert.deepEqual(header.fileChanges, { additions: 2, deletions: 0, files: 1 });
      assert.equal(changes.files, 1);
      assert.deepEqual(
        changes.items.map((item) => ({ ...item, path: item.path.replaceAll("\\", "/") })),
        [{ path: fileName, additions: 2, deletions: 0 }],
      );
      assertWireAndOrdinals(harness, subscription.ack.subscriptionId);
      assert.equal(requestCount, 2);
      assert.equal(harness.mock.calls.length, 2, "恰有两次真实 HTTP，不接受通用补答或额外重试");
      harness.mock.assertHealthy();
    } finally {
      await harness.close();
    }
  },
);
