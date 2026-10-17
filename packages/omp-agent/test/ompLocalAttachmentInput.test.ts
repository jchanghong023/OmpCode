import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  PROTOCOL_V4_LIMITS,
  type AttachmentRef,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";
import { createOmpAttachmentFileReader } from "../src/adapters/cliMain.js";
import { AttachmentStore } from "../src/app/attachmentStore.js";
import type { OmpAttachmentFileReader } from "../src/app/ompAttachmentInput.js";
import type { OmpProcessFactory } from "../src/app/ports.js";
import { SessionRegistry } from "../src/app/sessionRegistry.js";
import { V4CommandService } from "../src/app/v4Commands.js";
import type { OmpCommandFrame } from "../src/domain/ompFrames.js";
import { createDirectoryStub } from "./fixtures/directoryStub.js";

// Exercise the real command -> registry -> engine -> core boundary, not an echo of
// attachment metadata. Only the core process is fake; file IO uses the CLI reader.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==",
  "base64",
);

type CoreInput = Extract<OmpCommandFrame, { type: "prompt" | "steer" | "follow_up" }>;

async function harness(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "omp-local-attachment-input-"));
  const inputs: CoreInput[] = [];
  const processCwds: string[] = [];
  const reads: { path: string; maxBytes: number }[] = [];
  const actualReader = createOmpAttachmentFileReader();
  const reader: OmpAttachmentFileReader = {
    isAbsolutePath: (path) => actualReader.isAbsolutePath(path),
    async readFile(path, maxBytes) {
      reads.push({ path, maxBytes });
      return actualReader.readFile(path, maxBytes);
    },
  };
  const ompFactory: OmpProcessFactory = {
    create(options) {
      processCwds.push(options.cwd);
      return {
        ompSessionFile: null,
        async start() {},
        async send(command) {
          if (
            command.type === "prompt" ||
            command.type === "steer" ||
            command.type === "follow_up"
          ) {
            inputs.push(command);
            return { success: true, data: { agentInvoked: false } };
          }
          return { success: true, data: {} };
        },
        respondUi() {},
        refreshState: async () => null,
        readContextReport: async () => null,
        async dispose() {},
      };
    },
  };
  const registry = new SessionRegistry({
    ompFactory,
    directory: createDirectoryStub(),
    gateway: {
      emitFrame() {},
      requestUserInput: async () => ({ action: "cancel" }),
    },
    store: {
      listSessions: async () => [],
      readSessionEntries: async () => [],
      readSubagentEntries: async () => [],
      deleteSession: async () => true,
    },
  });
  context.after(async () => {
    try {
      await registry.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const store = new AttachmentStore();
  const commands = new V4CommandService({
    registry,
    workspaceId: "local-attachment-workspace",
    workspacePath: root,
    attachments: store,
    attachmentFileReader: reader,
  });
  let serial = 0;
  async function submit(
    type: "createSession" | "sendText",
    sessionId: string | null,
    text: string,
    attachments?: AttachmentRef[],
  ) {
    serial += 1;
    return commands.handle({
      commandId: `local-attachment-${serial}`,
      clientId: "local-attachment-client",
      sessionId,
      type,
      issuedAt: 1,
      payload:
        type === "createSession"
          ? {
              workspaceId: "local-attachment-workspace",
              firstInput: { text, attachments },
            }
          : { text, attachments },
    });
  }
  async function file(name: string, content: string | Buffer, mime = "text/plain") {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const path = join(root, name);
    await writeFile(path, bytes);
    return { ref: path, fileName: basename(path), mime, bytes: bytes.length };
  }
  function upload(name: string, bytes: Buffer, mime: string): AttachmentRef {
    serial += 1;
    const owner = {
      connectionId: "local-attachment-connection",
      sessionId: "local-attachment-draft",
      uploadId: `local-upload-${serial}`,
    };
    const chunkBytes = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
    store.begin({
      ...owner,
      fileName: name,
      mime,
      totalBytes: bytes.length,
      totalChunks: Math.ceil(bytes.length / chunkBytes),
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      store.chunk({
        ...owner,
        chunkIndex: offset / chunkBytes,
        dataBase64: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
      });
    }
    return { ...store.commit(owner), fileName: name, mime, bytes: bytes.length };
  }
  return { root, inputs, processCwds, reads, store, registry, submit, file, upload };
}

function createdSessionId(ack: CommandAck): string {
  assert.equal(ack.status, "accepted", ack.message ?? "createSession must accept real files");
  assert.equal(ack.result?.type, "createSession");
  assert.ok(ack.result && "sessionId" in ack.result);
  return ack.result.sessionId;
}

test("local UTF-8 and image files reach the core on createSession and sendText", async (context) => {
  const h = await harness(context);
  const firstText = await h.file(
    "mbist.md",
    "# MBIST\n真实首发内容 Ω\n",
    "text/markdown; charset=utf-8",
  );
  const firstImage = await h.file("first.png", PNG_BYTES, "IMAGE/PNG; charset=binary");
  const sessionId = createdSessionId(
    await h.submit("createSession", null, "read first files", [firstText, firstImage]),
  );
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0]!.type, "prompt");
  assert.equal(
    h.inputs[0]!.message,
    '<attached_file name="mbist.md" mime="text/markdown">\n# MBIST\n真实首发内容 Ω\n\n</attached_file>\n\nread first files',
  );
  assert.deepEqual(h.inputs[0]!.images, [
    { type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" },
  ]);

  // Update the same path: the next send must consume current host bytes, not a
  // previous prepared-input cache or the ref string masquerading as content.
  await writeFile(firstText.ref, "续发的新内容 — changed on disk\n", "utf8");
  const nextImageBytes = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  const nextImage = await h.file("next.gif", nextImageBytes, "image/gif");
  const sent = await h.submit("sendText", sessionId, "read updated files", [firstText, nextImage]);
  assert.equal(sent.status, "accepted", sent.message ?? "sendText must accept real files");
  assert.equal(h.inputs.length, 2);
  assert.equal(h.inputs[1]!.type, "prompt");
  assert.equal(
    h.inputs[1]!.message,
    '<attached_file name="mbist.md" mime="text/markdown">\n续发的新内容 — changed on disk\n\n</attached_file>\n\nread updated files',
  );
  assert.deepEqual(h.inputs[1]!.images, [
    { type: "image", data: nextImageBytes.toString("base64"), mimeType: "image/gif" },
  ]);
  assert.deepEqual(h.processCwds, [h.root], "file paths and execution cwd belong to this host");
  assert.deepEqual(
    h.reads.map(({ path }) => path),
    [firstText.ref, firstImage.ref, firstText.ref, nextImage.ref],
  );
});

test("uploaded references and real paths preserve text and image input order", async (context) => {
  const h = await harness(context);
  const uploadedText = h.upload("uploaded.txt", Buffer.from("UPLOADED_FIRST\n"), "text/plain");
  const localText = await h.file("local.txt", "LOCAL_SECOND\n");
  const uploadedLast = h.upload("last.txt", Buffer.from("UPLOADED_LAST\n"), "text/plain");
  const uploadedImage = h.upload("uploaded.png", PNG_BYTES, "image/png");
  const localImageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const localImage = await h.file("local.jpg", localImageBytes, "image/jpeg");
  const attachments = [uploadedText, uploadedImage, localText, localImage, uploadedLast];
  const sessionId = createdSessionId(
    await h.submit("createSession", null, "mixed first", attachments),
  );
  const sent = await h.submit("sendText", sessionId, "mixed next", [...attachments].reverse());
  assert.equal(sent.status, "accepted", sent.message ?? "sendText must accept mixed sources");
  assert.equal(h.inputs.length, 2);
  for (const [index, order] of [
    ["UPLOADED_FIRST", "LOCAL_SECOND", "UPLOADED_LAST"],
    ["UPLOADED_LAST", "LOCAL_SECOND", "UPLOADED_FIRST"],
  ].entries()) {
    const message = h.inputs[index]!.message;
    const positions = order.map((marker) => message.indexOf(marker));
    assert.ok(positions.every((position) => position >= 0));
    assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!, message);
    assert.ok(message.endsWith(index === 0 ? "mixed first" : "mixed next"));
  }
  const images = [
    { type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" },
    { type: "image", data: localImageBytes.toString("base64"), mimeType: "image/jpeg" },
  ];
  assert.deepEqual(h.inputs[0]!.images, images);
  assert.deepEqual(h.inputs[1]!.images, [...images].reverse());
  assert.deepEqual(
    h.reads.map(({ path }) => path),
    [localText.ref, localImage.ref, localImage.ref, localText.ref],
    "uploaded references never fall through to filesystem IO",
  );
});

test("zero-byte UTF-8 paths are valid on first and subsequent input", async (context) => {
  const h = await harness(context);
  const empty = await h.file("empty.txt", "");
  const sessionId = createdSessionId(await h.submit("createSession", null, "first empty", [empty]));
  const sent = await h.submit("sendText", sessionId, "next empty", [empty]);
  assert.equal(sent.status, "accepted", sent.message ?? "sendText must accept empty UTF-8 files");
  assert.equal(h.inputs.length, 2);
  assert.equal(
    h.inputs[0]!.message,
    '<attached_file name="empty.txt" mime="text/plain">\n\n</attached_file>\n\nfirst empty',
  );
  assert.equal(
    h.inputs[1]!.message,
    '<attached_file name="empty.txt" mime="text/plain">\n\n</attached_file>\n\nnext empty',
  );
  assert.equal(Object.hasOwn(h.inputs[0]!, "images"), false);
  assert.equal(Object.hasOwn(h.inputs[1]!, "images"), false);
});

test("invalid references, unsupported types and count limits reject before file reads", async (context) => {
  const h = await harness(context);
  const valid = await h.file("valid.txt", "must not read");
  const draft = await h.registry.createSession({
    workspaceId: "local-attachment-workspace",
    workspacePath: h.root,
  });
  const expired = h.upload("expired.txt", Buffer.from("expired bytes"), "text/plain");
  h.store.sweep(Date.now() + PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs + 1);
  const invalidInputs: [string, AttachmentRef[]][] = [
    ["relative path", [{ ...valid, ref: "relative/valid.txt" }]],
    ["unknown URI", [{ ...valid, ref: "https://example.invalid/valid.txt" }]],
    ["file URI is not an absolute host path", [{ ...valid, ref: `file://${valid.ref}` }]],
    ["missing upload ref", [{ ...valid, ref: "omp-attachment://missing-upload" }]],
    ["expired upload ref", [expired]],
    ["unsupported MIME", [{ ...valid, mime: "application/pdf" }]],
    ["attachment count", Array.from({ length: 9 }, () => valid)],
  ];
  if (process.platform === "win32") {
    invalidInputs.push(["drive-relative path", [{ ...valid, ref: "C:valid.txt" }]]);
    invalidInputs.push(["root-relative path", [{ ...valid, ref: "\\valid.txt" }]]);
  } else {
    invalidInputs.push(["foreign Windows path", [{ ...valid, ref: "C:\\valid.txt" }]]);
  }
  for (const [label, attachments] of invalidInputs) {
    for (const type of ["createSession", "sendText"] as const) {
      const ack = await h.submit(
        type,
        type === "sendText" ? draft.sessionId : null,
        label,
        attachments,
      );
      assert.equal(ack.status, "rejected", `${type}: ${label}`);
      assert.equal(ack.reasonCode, "fault.command.attachmentUnsupportedByOmpCore");
      assert.ok(ack.message, `${type}: ${label} must explain its rejection`);
      assert.deepEqual(h.reads, [], `${type}: ${label} must not read a file`);
      assert.deepEqual(h.inputs, [], `${type}: ${label} must not dispatch to the core`);
      assert.deepEqual(h.processCwds, [], `${type}: ${label} must not start the core`);
    }
  }
});

test("unreadable or invalid real file content rejects the entire first and subsequent input", async (context) => {
  const h = await harness(context);
  const draft = await h.registry.createSession({
    workspaceId: "local-attachment-workspace",
    workspacePath: h.root,
  });
  const good = await h.file("good.txt", "valid prefix must not partially dispatch");
  const missing = { ...good, ref: join(h.root, "missing.txt"), fileName: "missing.txt" };
  const directoryPath = join(h.root, "directory.txt");
  await mkdir(directoryPath);
  const directory = { ...good, ref: directoryPath, fileName: "directory.txt" };
  const invalidUtf8 = await h.file("invalid.txt", Buffer.from([0xc3, 0x28]));
  const oversized = await h.file("oversized.txt", Buffer.alloc(256 * 1024 + 1, 0x61));
  const totalA = await h.file("total-a.txt", Buffer.alloc(180 * 1024, 0x61));
  const totalB = await h.file("total-b.txt", Buffer.alloc(180 * 1024, 0x62));
  const totalC = await h.file("total-c.txt", Buffer.alloc(180 * 1024, 0x63));
  const oversizedImage = await h.file("oversized.png", PNG_BYTES, "image/png");
  await truncate(oversizedImage.ref, PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1);
  const invalidInputs: [string, AttachmentRef[]][] = [
    ["missing regular file", [good, missing]],
    ["directory is not a regular file", [good, directory]],
    ["invalid UTF-8", [good, invalidUtf8]],
    ["text actual bytes exceed 256 KiB despite understated metadata", [{ ...oversized, bytes: 1 }]],
    ["text total exceeds 512 KiB", [totalA, totalB, totalC]],
    [
      "image actual bytes exceed upload limit despite understated metadata",
      [{ ...oversizedImage, bytes: 1 }],
    ],
    [
      "mixed valid image and unsupported PDF",
      [
        await h.file("valid.png", PNG_BYTES, "image/png"),
        await h.file("unsupported.pdf", "%PDF-1.7\n", "application/pdf"),
      ],
    ],
  ];
  for (const [label, attachments] of invalidInputs) {
    for (const type of ["createSession", "sendText"] as const) {
      const ack = await h.submit(
        type,
        type === "sendText" ? draft.sessionId : null,
        label,
        attachments,
      );
      assert.equal(ack.status, "rejected", `${type}: ${label}`);
      assert.equal(ack.reasonCode, "fault.command.attachmentUnsupportedByOmpCore");
      assert.ok(ack.message, `${type}: ${label} must explain its rejection`);
      assert.deepEqual(h.inputs, [], `${type}: ${label} must not partially dispatch valid files`);
      assert.deepEqual(h.processCwds, [], `${type}: ${label} must not start the core`);
    }
  }
  assert.ok(h.reads.some(({ path }) => path === missing.ref));
  assert.ok(h.reads.some(({ path }) => path === directory.ref));
  assert.ok(h.reads.some(({ path }) => path === invalidUtf8.ref));
  assert.ok(h.reads.some(({ path, maxBytes }) => path === oversized.ref && maxBytes <= 256 * 1024));
  assert.ok(
    h.reads.some(
      ({ path, maxBytes }) =>
        path === oversizedImage.ref && maxBytes <= PROTOCOL_V4_LIMITS.attachmentMaxBytes,
    ),
  );
  const sent = await h.submit("sendText", draft.sessionId, "plain input after rejections");
  assert.equal(sent.status, "accepted", sent.message ?? "plain input must remain available");
  assert.equal(h.inputs.length, 1, "rejected inputs leave no deferred core prompt");
  assert.equal(h.inputs[0]!.message, "plain input after rejections");
  assert.equal(Object.hasOwn(h.inputs[0]!, "images"), false);
});
