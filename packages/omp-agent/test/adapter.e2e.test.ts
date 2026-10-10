// 适配器协议级 E2E：真实拉起 omp-agent 子进程（tsx），fake omp 作为内嵌核心，
// 验证「storage 就绪 → v4 createSession → 流式 → 工具调用 → 权限确认 → 文件变更 →
// 会话完成」的桌面主链路。所有下行 v4 帧均按 @zcode/shared 的 wire schema 校验。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { zcodeProtocolResponseSchema } from "@zcode/shared";
import {
  conversationTopicWireFrameSchema,
  commandAckSchema,
  PROTOCOL_V4_LIMITS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const fakeOmpPath = join(packageRoot, "test", "fixtures", "fakeOmp.mjs");
// tsx 以真实 node + cli.mjs 拉起（避免 Windows .cmd shim 在 spawn 下的路径问题）。
const tsxCliPath = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);

interface WireFrame {
  topic: string;
  payload: {
    kind: "snapshot" | "deltas";
    snapshot?: { rows?: { window?: unknown[] } };
    deltas?: unknown[];
  };
}

class AdapterHarness {
  readonly frames: unknown[] = [];
  private nextRequestId = 100;
  private child: ReturnType<typeof spawn>;

  constructor(
    child: ReturnType<typeof spawn>,
    private readonly testRoot: string,
  ) {
    this.child = child;
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }
      try {
        this.frames.push(JSON.parse(line));
      } catch {
        // 非 JSON 行忽略
      }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.nextRequestId += 1;
    const id = this.nextRequestId;
    return new Promise((resolveRequest, rejectRequest) => {
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      this.waitUntil(() => {
        const match = this.frames.find(
          (frame) =>
            (frame as { id?: number }).id === id &&
            ("result" in (frame as object) || "error" in (frame as object)),
        );
        return match;
      })
        .then(resolveRequest)
        .catch(rejectRequest);
    });
  }

  respond(id: unknown, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async waitUntil(condition: () => unknown | undefined, timeoutMs = 20000): Promise<unknown> {
    const startedAt = Date.now();
    for (;;) {
      const match = condition();
      if (match !== undefined && match !== null && match !== false) {
        return match;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`waitUntil timeout after ${timeoutMs}ms`);
      }
      await new Promise((sleep) => setTimeout(sleep, 25));
    }
  }

  conversationFrames(): WireFrame[] {
    return this.frames
      .filter(
        (frame): frame is { method: string; params: { frame?: WireFrame } & WireFrame } =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { method?: string }).method === "v4/conversation/frame",
      )
      .map((frame) => frame.params.frame ?? (frame.params as WireFrame));
  }

  collectRows(): Map<number, Record<string, unknown>> {
    const rows = new Map<number, Record<string, unknown>>();
    for (const frame of this.conversationFrames()) {
      if (frame.payload.kind === "snapshot") {
        for (const row of (frame.payload.snapshot?.rows?.window ?? []) as Record<
          string,
          unknown
        >[]) {
          rows.set(row.rowId as number, { ...row });
        }
      } else if (frame.payload.kind === "deltas") {
        for (const delta of frame.payload.deltas as {
          op?: string;
          row?: Record<string, unknown>;
          rowId?: number;
          path?: string;
          append?: string;
        }[]) {
          if (delta.op === "row.appended" || delta.op === "row.upserted") {
            const row = delta.row as Record<string, unknown>;
            rows.set(row.rowId as number, { ...row });
          } else if (
            delta.op === "row.delta" &&
            typeof delta.rowId === "number" &&
            typeof delta.path === "string"
          ) {
            const row = rows.get(delta.rowId);
            if (row && typeof delta.append === "string") {
              row[delta.path] = String(row[delta.path] ?? "") + delta.append;
            }
          }
        }
      }
    }
    return rows;
  }

  collectState(): Record<string, unknown> {
    // 快照携带全量 state；本地命令瞬间完成时状态只出现在订阅快照里，必须以最后一个
    // 快照为基底再叠加后续 state.updated 增量。
    let state: Record<string, unknown> = {};
    for (const frame of this.conversationFrames()) {
      if (frame.payload.kind === "snapshot") {
        // 会话快照是扁平结构（control/meta/config 顶层字段），直接铺开作基底。
        state = { ...((frame.payload.snapshot ?? {}) as Record<string, unknown>) };
      } else {
        for (const delta of frame.payload.deltas as {
          op?: string;
          patch?: Record<string, unknown>;
        }[]) {
          if (delta.op === "state.updated" && delta.patch) {
            Object.assign(state, delta.patch);
          }
        }
      }
    }
    return state;
  }

  topicFrames(topic: string): WireFrame[] {
    return this.conversationFrames().filter((frame) => frame.topic === topic);
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => {
      this.child.once("exit", () => done());
      this.child.stdin.end();
      setTimeout(() => this.child.kill("SIGKILL"), 3000).unref?.();
    });
    // 仅清理当前 harness 创建的临时根；包含派生命令显示历史，不能写入用户应用根。
    if (dirname(this.testRoot) === tmpdir() && this.testRoot.includes("omp-adapter-e2e-")) {
      await rm(this.testRoot, { recursive: true, force: true });
    }
  }
}

function assertFrameOrdinalsIncrease(frames: unknown[], subscriptionId: string): void {
  const logical = new Map<string, number>();
  for (const frame of frames) {
    const record = frame as {
      method?: string;
      params?: { subscriptionId?: string; logicalFrameId?: string; logicalFrameOrdinal?: number };
    };
    if (
      record.method !== "v4/conversation/frame" ||
      record.params?.subscriptionId !== subscriptionId
    )
      continue;
    if (record.params.logicalFrameId && record.params.logicalFrameOrdinal) {
      logical.set(record.params.logicalFrameId, record.params.logicalFrameOrdinal);
    }
  }
  const ordinals = [...logical.values()];
  assert.ok(ordinals.length > 1, `Expected multiple logical frames for ${subscriptionId}`);
  assert.deepEqual(
    ordinals,
    ordinals.map((_, index) => index + 1),
  );
}

async function startAdapter(extraEnv: Record<string, string> = {}): Promise<AdapterHarness> {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-adapter-e2e-"));
  const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      OMP_RPC_BINARY_PATH: process.execPath,
      OMP_RPC_ARGS_JSON: JSON.stringify([fakeOmpPath]),
      ZCODE_WORKSPACE_IDENTITY: "test-workspace",
      // 隔离 omp 配置目录：测试不得读写用户真实的 ~/.omp 会话数据。
      OMP_CONFIG_ROOT: join(testRoot, "omp"),
      PI_CONFIG_DIR: join(testRoot, "omp"),
      ZCODE_DATA_BASE_DIR: testRoot,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });
  const harness = new AdapterHarness(child, testRoot);
  await harness.waitUntil(() =>
    harness.frames.find(
      (frame) =>
        (frame as { method?: string; params?: { phase?: string } }).method ===
          "startup/storageState" &&
        (frame as { params?: { phase?: string } }).params?.phase === "ready",
    ),
  );
  void stderrTail;
  return harness;
}

async function uploadFixture(
  harness: AdapterHarness,
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
  const common = { connectionId: "image-test", uploadId, sessionId };
  const begun = zcodeProtocolResponseSchema.parse(
    await harness.request("v4/attachment/begin", {
      ...common,
      fileName,
      mime,
      totalBytes: bytes.length,
      totalChunks: Math.ceil(bytes.length / chunkBytes),
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }),
  );
  assert.equal(v4AttachmentBeginResultSchema.parse(begun.result).state, "staging");
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = zcodeProtocolResponseSchema.parse(
      await harness.request("v4/attachment/chunk", {
        ...common,
        chunkIndex: offset / chunkBytes,
        dataBase64: bytes.subarray(offset, offset + chunkBytes).toString("base64"),
      }),
    );
    v4AttachmentChunkResultSchema.parse(chunk.result);
  }
  const committed = zcodeProtocolResponseSchema.parse(
    await harness.request("v4/attachment/commit", common),
  );
  const { ref } = v4AttachmentCommitResultSchema.parse(committed.result);
  return { ref, fileName, mime, bytes: bytes.length };
}

test("v4 图片和文本进入 omp，不能消费的 PDF 在提交前拒绝", async () => {
  const harness = await startAdapter();
  try {
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const first = await uploadFixture(
      harness,
      "image-first",
      "draft-image-test",
      "image/png",
      firstBytes,
      2,
    );
    const created = (await harness.request("v4/command", {
      commandId: "create-with-image",
      clientId: "image-client",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: "test-workspace",
        firstInput: { text: "image-report first", attachments: [first] },
      },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const createAck = commandAckSchema.parse(created.result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "image-test",
      clientMode: "desktop-continuous",
    });
    const report = async (label: string) => {
      const prefix = `IMAGE_REPORT:${label}:`;
      const row = (await harness.waitUntil(() =>
        [...harness.collectRows().values()].find(
          (candidate) =>
            candidate.kind === "assistantText" && String(candidate.text ?? "").startsWith(prefix),
        ),
      )) as { text: string };
      return JSON.parse(row.text.slice(prefix.length)) as { hasImages: boolean; images: unknown[] };
    };
    assert.deepEqual(await report("first"), {
      hasImages: true,
      images: [{ type: "image", data: firstBytes.toString("base64"), mimeType: "image/png" }],
    });

    const pdf = await uploadFixture(
      harness,
      "document",
      sessionId,
      "application/pdf",
      Buffer.from("%PDF-test"),
    );
    const secondBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const second = await uploadFixture(
      harness,
      "image-second",
      sessionId,
      "image/jpeg",
      secondBytes,
    );
    const sent = (await harness.request("v4/command", {
      commandId: "send-with-images",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "image-report second", attachments: [second, first] },
      issuedAt: Date.now(),
    })) as { result: unknown };
    assert.equal(commandAckSchema.parse(sent.result).status, "accepted");
    assert.deepEqual(await report("second"), {
      hasImages: true,
      images: [
        { type: "image", data: secondBytes.toString("base64"), mimeType: "image/jpeg" },
        { type: "image", data: firstBytes.toString("base64"), mimeType: "image/png" },
      ],
    });

    const unsupported = (await harness.request("v4/command", {
      commandId: "send-with-pdf",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "请读 PDF", attachments: [pdf] },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const unsupportedAck = commandAckSchema.parse(unsupported.result);
    assert.equal(unsupportedAck.status, "rejected");
    assert.match(
      unsupportedAck.message ?? "",
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
    const withText = (await harness.request("v4/command", {
      commandId: "send-with-text",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "text-report note", attachments: [text] },
      issuedAt: Date.now(),
    })) as { result: unknown };
    assert.equal(commandAckSchema.parse(withText.result).status, "accepted");
    const textRow = (await harness.waitUntil(() =>
      [...harness.collectRows().values()].find(
        (row) => row.kind === "assistantText" && String(row.text ?? "").startsWith("TEXT_REPORT:"),
      ),
    )) as { text: string };
    const textReport = JSON.parse(textRow.text.slice("TEXT_REPORT:".length)) as {
      message: string;
      images: unknown[];
    };
    assert.match(textReport.message, /note\.txt/u);
    assert.match(textReport.message, /TEXT_ATTACHMENT_OK/u);
    assert.deepEqual(textReport.images, []);

    const plain = (await harness.request("v4/command", {
      commandId: "send-without-images",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "image-report plain" },
      issuedAt: Date.now(),
    })) as { result: unknown };
    assert.equal(commandAckSchema.parse(plain.result).status, "accepted");
    assert.deepEqual(await report("plain"), { hasImages: false, images: [] });
  } finally {
    await harness.close();
  }
});

for (const control of ["resolveInteraction", "stop"] as const) {
  test(`同步原生 goal confirm 未返回 send ACK 时，${control} 控制回路可达`, async () => {
    const harness = await startAdapter({ FAKE_OMP_NATIVE_COMMANDS: "1" });
    try {
      const created = (await harness.request("v4/command", {
        commandId: "sync-create",
        clientId: "sync-client",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "test-workspace", firstInput: { text: "/help" } },
        issuedAt: Date.now(),
      })) as { result: unknown };
      const sessionId = (commandAckSchema.parse(created.result).result as { sessionId: string })
        .sessionId;
      await harness.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: "sync-goal",
        clientMode: "desktop-continuous",
      });
      let sendFinished = false;
      const pendingSend = harness
        .request("v4/command", {
          commandId: "sync-goal-drop",
          clientId: "sync-client",
          sessionId,
          type: "sendText",
          payload: { text: "/goal drop" },
          issuedAt: Date.now(),
        })
        .then((result) => {
          sendFinished = true;
          return result as { result: unknown };
        });
      const card = (await harness.waitUntil(
        () =>
          (
            harness.collectState().pendingInteractions as
              | Array<{ interactionId: string }>
              | undefined
          )?.[0],
      )) as { interactionId: string };
      assert.equal(sendFinished, false, "真实同步 confirm 的 send ACK 必须仍在等待");
      if (control === "resolveInteraction") {
        const invalid = (await harness.request("v4/command", {
          commandId: "sync-invalid-reply",
          clientId: "sync-client",
          sessionId,
          type: control,
          payload: { interactionId: card.interactionId, answer: { action: "invalid" } },
          issuedAt: Date.now(),
        })) as { error?: { code: number } };
        assert.equal(invalid.error?.code, -32602, "控制回路仍执行完整 Envelope 校验");
        assert.equal(sendFinished, false);
        const foreign = (await harness.request("v4/command", {
          commandId: "sync-foreign-reply",
          clientId: "sync-client",
          sessionId: "unknown-session",
          type: control,
          payload: { interactionId: card.interactionId, answer: { action: "accept" } },
          issuedAt: Date.now(),
        })) as { error?: { code: number } };
        assert.equal(foreign.error?.code, -32004, "不存在的会话不能答复当前会话的交互");
        assert.equal(sendFinished, false);
      }
      const envelope = {
        commandId: "sync-control",
        clientId: "sync-client",
        sessionId,
        type: control,
        payload:
          control === "stop"
            ? {}
            : { interactionId: card.interactionId, answer: { action: "accept" } },
        issuedAt: Date.now(),
      };
      const result = (await harness.request("v4/command", envelope)) as { result: unknown };
      assert.equal(commandAckSchema.parse(result.result).status, "accepted");
      const duplicate = (await harness.request("v4/command", envelope)) as { result: unknown };
      assert.deepEqual(duplicate.result, result.result, "重复 commandId 继续由原服务幂等裁决");
      assert.equal(commandAckSchema.parse((await pendingSend).result).status, "accepted");
      await harness.waitUntil(
        () => (harness.collectState().pendingInteractions as unknown[] | undefined)?.length === 0,
      );
      const expected = control === "stop" ? "Goal drop cancelled." : "Goal dropped.";
      await harness.waitUntil(() =>
        [...harness.collectRows().values()].some(
          (row) => row.kind === "assistantText" && row.text === expected,
        ),
      );
      assert.equal(
        [...harness.collectRows().values()].filter(
          (row) => row.kind === "assistantText" && row.text === expected,
        ).length,
        1,
      );
    } finally {
      await harness.close();
    }
  });
}

test("桌面主链路：createSession → 流式 → 工具 → 权限确认 → 文件变更 → 完成", async () => {
  const harness = await startAdapter();
  try {
    // 1. v4 createSession（带首条输入）
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-create-1",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "请写 greeting 文件" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    assert.equal(createAck.status, "accepted", `createSession ACK: ${JSON.stringify(createAck)}`);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    assert.ok(sessionId.length > 0);

    // 2. 订阅 conversation topic（快照帧必须合法）
    const subscribeResult = (await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
    })) as { result: { ack: { subscriptionId: string; mode: string } } };
    assert.ok(subscribeResult.result.ack.subscriptionId.length > 0);

    // 3. 等待交互请求（omp select 审批 → interaction/requestUserInput 反向请求）
    const interaction = (await harness.waitUntil(() =>
      harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ),
    )) as { id: string; params: { requestId: string; prompt: string } };
    assert.match(interaction.params.prompt, /greeting\.txt/);
    const projectedQuestion = (await harness.waitUntil(() => {
      const interactions = harness.collectState().pendingInteractions as
        | Array<{ payload?: { questions?: unknown[]; answerMode?: string } }>
        | undefined;
      return interactions?.find((item) => item.payload?.answerMode === "option");
    })) as { payload: { questions: unknown[]; answerMode: string } };
    assert.equal(
      projectedQuestion.payload.questions.length,
      1,
      "rpc-ui 选择题须投影到已有 Ask 界面",
    );

    // 4. Host 反向请求应答使用显式选项；content.value 是自由文本，不是审批选择。
    harness.respond(interaction.id, { action: "accept", content: { optionId: "Approve" } });

    // 5. 等待会话完成
    await harness.waitUntil(() => {
      for (const row of harness.collectRows().values()) {
        if (row.kind === "turnHeader" && row.state === "completedSuccess") {
          return true;
        }
      }
      return false;
    });

    // 6. 校验全部下行 v4 帧 schema 合法
    for (const frame of harness.frames.filter(
      (item) => (item as { method?: string }).method === "v4/conversation/frame",
    )) {
      const parsed = conversationTopicWireFrameSchema.safeParse(
        (frame as { params: unknown }).params,
      );
      assert.ok(
        parsed.success,
        `v4 frame 不合法: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`,
      );
    }
    assertFrameOrdinalsIncrease(harness.frames, subscribeResult.result.ack.subscriptionId);

    // 7. 投影内容正确
    const rows = harness.collectRows();
    const rowList = [...rows.values()];
    const userRow = rowList.find((row) => row.kind === "userInput");
    assert.ok(userRow, "缺少 userInput 行");
    assert.equal(userRow!.text, "请写 greeting 文件");
    const textRows = rowList.filter((row) => row.kind === "assistantText");
    assert.equal(
      textRows.reduce((total, row) => total + String(row.text ?? "").length, 0),
      "Hello world! Done.".length,
      "流式文本合并后长度不符",
    );
    const toolRow = rowList.find((row) => row.kind === "toolCall" && row.toolName === "write");
    assert.ok(toolRow, "缺少 write 工具行");
    assert.equal(toolRow!.status, "success");
    assert.match(String(toolRow!.output?.text ?? ""), /wrote 2 lines/);
    const headerRow = rowList.find((row) => row.kind === "turnHeader");
    assert.ok(headerRow, "缺少 turnHeader 行");
    assert.equal(headerRow!.state, "completedSuccess");
    assert.deepEqual(headerRow!.fileChanges, { additions: 2, deletions: 0, files: 1 });

    // 8. fileChanges 查询
    const fileChangesResult = (await harness.request("v4/conversation/fileChanges", {
      sessionId,
      target: { rowId: headerRow!.rowId, entityId: headerRow!.entityId },
      baseRevision: 0,
      baseLogEpoch: "omp",
    })) as { result: { files: number; items: { path: string; additions: number }[] } };
    assert.equal(fileChangesResult.result.files, 1);
    assert.equal(fileChangesResult.result.items[0]!.path, "greeting.txt");
    assert.equal(fileChangesResult.result.items[0]!.additions, 2);
  } finally {
    await harness.close();
  }
});

test("stop 命令与 abort 收口 + sessions-index 订阅", async () => {
  const harness = await startAdapter();
  try {
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-create-2",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace" },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;

    const indexResult = (await harness.request("v4/conversation/subscribe", {
      topic: "sessions-index/test-workspace",
      connectionId: "conn-2",
    })) as { result: { ack: { subscriptionId: string } } };
    assert.ok(indexResult.result.ack.subscriptionId.length > 0);
    await harness.request("v4/conversation/resync", {
      topic: "sessions-index/test-workspace",
      subscriptionId: indexResult.result.ack.subscriptionId,
      base: null,
      forceSnapshot: true,
    });
    assertFrameOrdinalsIncrease(harness.frames, indexResult.result.ack.subscriptionId);

    const sessionSubscribe = (await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-2",
      clientMode: "desktop-continuous",
    })) as { result: { ack: { subscriptionId: string } } };
    assert.ok(sessionSubscribe.result.ack.subscriptionId.length > 0);

    const sendResult = await harness.request("v4/command", {
      commandId: "cmd-send-2",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "第二个任务" },
      issuedAt: Date.now(),
    });
    const sendAck = commandAckSchema.parse((sendResult as { result: unknown }).result);
    assert.equal(sendAck.status, "accepted");

    // 拒绝审批 → stop → abort → 会话以 interrupted 收口
    const interaction = (await harness.waitUntil(() =>
      harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ),
    )) as { id: string; params: { requestId: string } };
    harness.respond(interaction.id, { action: "decline" });

    const stopResult = await harness.request("v4/command", {
      commandId: "cmd-stop-2",
      clientId: "test-client",
      sessionId,
      type: "stop",
      payload: {},
      issuedAt: Date.now(),
    });
    const stopAck = commandAckSchema.parse((stopResult as { result: unknown }).result);
    assert.equal(stopAck.status, "accepted");

    await harness.waitUntil(() => {
      for (const row of harness.collectRows().values()) {
        if (
          row.kind === "turnHeader" &&
          (row.state === "completedInterrupted" || row.state === "completedSuccess")
        ) {
          return true;
        }
      }
      return false;
    });
  } finally {
    await harness.close();
  }
});

test("中断在途工具：end(isError)+尾随 update 序列后工具行收口为 cancelled（P2 验收 D1）", async () => {
  const harness = await startAdapter();
  try {
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-create-d1",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace" },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-d1",
      clientMode: "desktop-continuous",
    });

    // SLOW_TOOL_HOLD：fake omp 让 bash 工具停在在途态（对应真实 sleep 场景）
    const sendResult = await harness.request("v4/command", {
      commandId: "cmd-send-d1",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "SLOW_TOOL_HOLD" },
      issuedAt: Date.now(),
    });
    const sendAck = commandAckSchema.parse((sendResult as { result: unknown }).result);
    assert.equal(sendAck.status, "accepted");

    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "toolCall" && row.toolName === "bash" && row.status === "running",
      ),
    );

    const stopResult = await harness.request("v4/command", {
      commandId: "cmd-stop-d1",
      clientId: "test-client",
      sessionId,
      type: "stop",
      payload: {},
      issuedAt: Date.now(),
    });
    const stopAck = commandAckSchema.parse((stopResult as { result: unknown }).result);
    assert.equal(stopAck.status, "accepted");

    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedInterrupted",
      ),
    );
    // 修复前：omp 端 tool_execution_end(isError) 后的尾随 tool_execution_update 会把
    // 工具行复活为 running，且 failOpenToolRows 因在途表已清无法再收口（D1 残留 Running）。
    const bashRow = [...harness.collectRows().values()].find(
      (row) => row.kind === "toolCall" && row.toolName === "bash",
    );
    assert.ok(bashRow, "缺少 bash 工具行");
    assert.equal(bashRow.status, "cancelled");
  } finally {
    await harness.close();
  }
});

test("setFollowupMode guide 收敛 + 流式中输入按模式路由 steer/follow_up", async () => {
  const harness = await startAdapter();
  try {
    // 1. 创建会话并进入 HOLD 流式保持态
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-create-fm",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "HOLD 保持流式" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    const subscribeResult = (await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-fm",
      clientMode: "desktop-continuous",
    })) as { result: { ack: { subscriptionId: string; logEpoch: string } } };
    const logEpoch = subscribeResult.result.ack.logEpoch;
    const holdingTextRowCount = () =>
      [...harness.collectRows().values()].filter(
        (row) => row.kind === "assistantText" && String(row.text ?? "").length > 0,
      ).length;
    await harness.waitUntil(() => (holdingTextRowCount() >= 1 ? true : undefined));

    // setFollowupMode 是 CAS 命令：stale ACK 携带当前 revision，按其重试收敛（与 UI 同语义）。
    const sendFollowupModeCas = async (mode: "guide" | "queue") => {
      let baseRevision = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await harness.request("v4/command", {
          commandId: `cmd-fm-${mode}-${attempt}`,
          clientId: "test-client",
          sessionId,
          type: "setFollowupMode",
          payload: { mode },
          baseRevision,
          baseLogEpoch: logEpoch,
          issuedAt: Date.now(),
        });
        const ack = commandAckSchema.parse((result as { result: unknown }).result);
        if (ack.status === "accepted") {
          return ack;
        }
        assert.equal(ack.status, "stale", `setFollowupMode ${mode} ACK: ${JSON.stringify(ack)}`);
        baseRevision = ack.revisionAtDecision;
      }
      throw new Error("setFollowupMode CAS 未收敛");
    };

    // 2. guide 模式必须接受（回归：此前被 unsupportedByOmpCore 拒绝，导致桌面首发失败）
    const guideAck = await sendFollowupModeCas("guide");
    assert.equal(guideAck.status, "accepted");

    // 3. 流式中输入 → omp steer 命令，fake 核以 STEERED:<text> 收口本轮
    const followupImageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
    const followupImage = await uploadFixture(
      harness,
      "followup-image",
      sessionId,
      "image/png",
      followupImageBytes,
    );
    const imageEcho = `|IMAGES:${JSON.stringify([{ type: "image", data: followupImageBytes.toString("base64"), mimeType: "image/png" }])}`;
    const steerSend = await harness.request("v4/command", {
      commandId: "cmd-fm-send-1",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "引导补充", attachments: [followupImage] },
      issuedAt: Date.now(),
    });
    assert.equal(
      commandAckSchema.parse((steerSend as { result: unknown }).result).status,
      "accepted",
    );
    await harness.waitUntil(() => {
      for (const row of harness.collectRows().values()) {
        if (
          row.kind === "assistantText" &&
          String(row.text ?? "").includes(`STEERED:引导补充${imageEcho}`)
        ) {
          return true;
        }
      }
      return false;
    });

    // 4. 切回 queue：新 prompt 再次进入 HOLD 保持态，流式中输入 → omp follow_up 命令
    await sendFollowupModeCas("queue");
    await harness.request("v4/command", {
      commandId: "cmd-fm-send-hold2",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "HOLD 第二轮" },
      issuedAt: Date.now(),
    });
    await harness.waitUntil(() => (holdingTextRowCount() >= 2 ? true : undefined));
    const queueSend = await harness.request("v4/command", {
      commandId: "cmd-fm-send-2",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "队列补充", attachments: [followupImage] },
      issuedAt: Date.now(),
    });
    const queueAck = commandAckSchema.parse((queueSend as { result: unknown }).result);
    assert.equal(queueAck.status, "accepted");
    assert.equal((queueAck.result as { delivery?: string } | undefined)?.delivery, "queue");
    await harness.waitUntil(() => {
      for (const row of harness.collectRows().values()) {
        if (
          row.kind === "assistantText" &&
          String(row.text ?? "").includes(`FOLLOWEDUP:队列补充${imageEcho}`)
        ) {
          return true;
        }
      }
      return false;
    });
    await harness.waitUntil(() => {
      const rows = [...harness.collectRows().values()];
      const headers = rows.filter((row) => row.kind === "turnHeader");
      return headers.length === 4 && headers.every((row) => row.state === "completedSuccess")
        ? true
        : undefined;
    });
    assert.ok(
      [...harness.collectRows().values()]
        .filter((row) => row.kind === "assistantText")
        .every((row) => row.state === "complete"),
    );
  } finally {
    await harness.close();
  }
});

test("轮次终态必达 sessions-index（侧栏 phase 不停留在 running）", async () => {
  const harness = await startAdapter();
  try {
    await harness.request("v4/conversation/subscribe", {
      topic: "sessions-index/test-workspace",
      connectionId: "conn-idx",
    });
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-idx-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/help" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-idx-conv",
      clientMode: "desktop-continuous",
    });
    // /help 本地命令在毫秒级完成：终态 flush 必然落在首个 running 通知后的 500ms 节流
    // 窗口内，是「丢弃式节流吞掉终态」的最严格回归场景。
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
      ),
    );
    // 轮次已完成：sessions-index 的最后一次 session.upserted 必须是终态 phase。
    // 丢弃式节流的回归场景：终态 flush 落在上次通知 500ms 窗口内被丢弃，索引停在 running。
    await harness.waitUntil(() => {
      let lastPhase: string | null = null;
      for (const frame of harness.topicFrames("sessions-index/test-workspace")) {
        if (frame.payload.kind !== "deltas") continue;
        for (const delta of frame.payload.deltas as {
          op?: string;
          session?: { phase?: string };
        }[]) {
          if (delta.op === "session.upserted" && delta.session?.phase) {
            lastPhase = delta.session.phase;
          }
        }
      }
      return lastPhase === "completedSuccess" ? true : undefined;
    }, 8000);
  } finally {
    await harness.close();
  }
});

test("供应商错误（stopReason=error）以 failed 收口并携带错误事实", async () => {
  const harness = await startAdapter();
  try {
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-failmodel-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/failmodel" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-failmodel",
      clientMode: "desktop-continuous",
    });
    await harness.waitUntil(() => {
      const state = harness.collectState();
      return (state.control as { phase?: string } | undefined)?.phase === "error"
        ? true
        : undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (harness.collectState().control as { phase?: string }).phase,
      "error",
      "agentInvoked=true 的 prompt_result 不得改写失败终态",
    );
    const state = harness.collectState();
    const lastError = (
      state.control as { lastError?: { code?: string; message?: string } | null } | undefined
    )?.lastError;
    assert.equal(lastError?.code, "omp_provider_401");
    assert.match(lastError?.message ?? "", /401 Model not supported/);
  } finally {
    await harness.close();
  }
});

test("prompt_result{status:aborted}（模型回合前取消）按 interrupted 收口且会话可继续对话", async () => {
  // 协议条款 §14.4：被输入门取消的 prompt 以 success ACK（无 data）+ 恰一个
  // prompt_result{status:"aborted", agentInvoked:true} 收尾，不启动模型回合。
  // ACK 无 data 使 PromptResultTracker 登记该 id（真实核 ticket 语义），aborted 帧经
  // onPromptResult 上抛，引擎按 interrupted 收口该轮。
  const harness = await startAdapter();
  try {
    const created = await harness.request("v4/command", {
      commandId: "cmd-aborted-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace" },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((created as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-aborted",
      clientMode: "desktop-continuous",
    });
    const sent = await harness.request("v4/command", {
      commandId: "cmd-aborted-send",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "ABORT_AT_START" },
      issuedAt: Date.now(),
    });
    assert.equal(commandAckSchema.parse((sent as { result: unknown }).result).status, "accepted");
    // 该轮按 interrupted 收口，且不产生任何模型内容行（无 agent 回合）。
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedInterrupted",
      ),
    );
    assert.equal(
      [...harness.collectRows().values()].filter((row) => row.kind === "assistantText").length,
      0,
      "被取消的轮不得产生模型内容行",
    );
    // 后续会话可继续正常对话：本地命令照常收口。
    const followup = await harness.request("v4/command", {
      commandId: "cmd-aborted-followup",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "/help" },
      issuedAt: Date.now(),
    });
    assert.equal(
      commandAckSchema.parse((followup as { result: unknown }).result).status,
      "accepted",
    );
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "assistantText" && String(row.text).includes("Fake help output"),
      ),
    );
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
      ),
    );
  } finally {
    await harness.close();
  }
});

// ── D1 新帧容忍：omp 协议演进（goal/fork 会话命令/live voice 等）下发的未知帧与
// 新字段不得破坏适配器——未知会话帧优雅忽略、后续正常帧照常消费；get_state 新字段
// 不拒帧、原字段消费不变。注入经 fake omp 文本标记与环境旗标（fakeOmp.mjs）。

test("未知类型的会话帧被优雅忽略，后续正常事件仍被消费", async () => {
  const harness = await startAdapter();
  try {
    const created = await harness.request("v4/command", {
      commandId: "cmd-unknown-frames-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "UNKNOWN_SESSION_FRAMES" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((created as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-unknown-frames",
      clientMode: "desktop-continuous",
    });
    // fake 先下发 goal_updated / live_voice_state（适配器未接入的新核帧），再走正常
    // 文本轮：轮次必须照常完成，未知帧不得打断事件流或误置状态。
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
      ),
    );
    const rows = [...harness.collectRows().values()];
    assert.ok(
      rows.some(
        (row) =>
          row.kind === "assistantText" && String(row.text).includes("UNKNOWN_FRAMES_TOLERATED"),
      ),
      "未知帧后的正常 message 事件必须仍被投影",
    );
    assert.equal(
      (harness.collectState().control as { phase?: string } | undefined)?.phase,
      "completedSuccess",
      "未知帧不得误置会话状态",
    );
    // 适配器存活且下行 wire 帧全部合法（含携带新核字段的 prompt_result no-op 路径）。
    for (const frame of harness.frames.filter(
      (item) => (item as { method?: string }).method === "v4/conversation/frame",
    )) {
      const parsed = conversationTopicWireFrameSchema.safeParse(
        (frame as { params: unknown }).params,
      );
      assert.ok(
        parsed.success,
        `v4 frame 不合法: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`,
      );
    }
  } finally {
    await harness.close();
  }
});

test("get_state 响应携带新核字段（queuedMessages/liveSteered/goal）不破坏原字段消费", async () => {
  const harness = await startAdapter({ FAKE_OMP_GET_STATE_NEW_FIELDS: "1" });
  try {
    const created = await harness.request("v4/command", {
      commandId: "cmd-newstate-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/help" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((created as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-newstate",
      clientMode: "desktop-continuous",
    });
    // 引擎 bootstrap 即回读 get_state（fake 响应混入 queuedMessages/liveSteered/goal），
    // schema passthrough 不得拒帧：配置与用量等原字段照常落投影。
    await harness.waitUntil(() =>
      [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
      ),
    );
    const state = harness.collectState();
    assert.equal((state.config as { model?: string } | undefined)?.model, "mock-1");
    assert.equal((state.config as { thought?: string } | undefined)?.thought, "max");
    assert.deepEqual((state.usage as { contextWindow?: unknown } | undefined)?.contextWindow, {
      usedTokens: 512,
      maxTokens: 200000,
      autoCompactThresholdTokens: null,
    });
  } finally {
    await harness.close();
  }
});

// v3 协商后沿真实 select(Approve/Deny) 审批边界验证放行、拒绝与 wire。

function v3HarnessOptions(): Record<string, string> {
  return { FAKE_OMP_PROTOCOL_V3: "1" };
}

async function createV3Session(
  harness: AdapterHarness,
  commandId: string,
  text: string,
): Promise<string> {
  const createResult = await harness.request("v4/command", {
    commandId,
    clientId: "test-client",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: "test-workspace", ...(text ? { firstInput: { text } } : {}) },
    issuedAt: Date.now(),
  });
  const ack = commandAckSchema.parse((createResult as { result: unknown }).result);
  assert.equal(ack.status, "accepted", `createSession: ${JSON.stringify(ack)}`);
  const sessionId = (ack.result as { sessionId: string }).sessionId;
  await harness.request("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: `conn-${commandId}`,
    clientMode: "desktop-continuous",
  });
  return sessionId;
}

async function waitTurnCompleted(harness: AdapterHarness, minCount: number): Promise<void> {
  await harness.waitUntil(() => {
    const headers = [...harness.collectRows().values()].filter(
      (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
    );
    return headers.length >= minCount ? true : undefined;
  });
}

/** 发送本地报告命令并从助手行解析 JSON 载荷（报告随轮次累积，按第 occurrence 次输出取值）。 */
async function readFakeReport(
  harness: AdapterHarness,
  sessionId: string,
  commandId: string,
  reportCommand: string,
  occurrence: number,
): Promise<unknown> {
  const sendResult = await harness.request("v4/command", {
    commandId,
    clientId: "test-client",
    sessionId,
    type: "sendText",
    payload: { text: reportCommand },
    issuedAt: Date.now(),
  });
  assert.equal(
    commandAckSchema.parse((sendResult as { result: unknown }).result).status,
    "accepted",
  );
  const prefix = reportCommand.replace("/", "");
  const text = (await harness.waitUntil(() => {
    const joined = [...harness.collectRows().values()]
      .filter((row) => row.kind === "assistantText")
      .map((row) => String(row.text ?? ""))
      .join("\n");
    const matches = [...joined.matchAll(new RegExp(`${prefix}:(.*)`, "g"))];
    return matches.length >= occurrence ? matches[occurrence - 1]![1]!.trim() : undefined;
  })) as string;
  return JSON.parse(text);
}

test("v3 工具审批：extension_ui select(Approve/Deny) → 反向请求 allow → 放行且 wire 合法", async () => {
  const harness = await startAdapter(v3HarnessOptions());
  try {
    const sessionId = await createV3Session(harness, "cmd-v3-perm", "请写 greeting 文件");

    // omp 审批（extension runner select）→ interaction/requestUserInput 反向请求（两档选项，
    // 提示为 formatApprovalPrompt 形态：Allow tool / Reason / details）。
    const approvalRequest = (await harness.waitUntil(() =>
      harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ),
    )) as { id: string; params: Record<string, unknown> };
    assert.match(String(approvalRequest.params.prompt), /Allow tool: write/);
    // 反向请求线形状：options 位于 params.input.options（protocolServer requestUserInput）。
    const wireOptions = ((approvalRequest.params.input as { options?: { optionId: string }[] })
      ?.options ?? []) as { optionId: string }[];
    assert.deepEqual(
      wireOptions.map((option) => option.optionId),
      ["Approve", "Deny"],
      "新核审批恒为 Approve/Deny 两档（会话/始终/前缀档由 omp 配置持有，不经宿主）",
    );

    // v4 投影：userInput 卡（select 形态、无自由文本）。
    const card = (await harness.waitUntil(() => {
      const interactions = harness.collectState().pendingInteractions as
        | Array<{
            interactionId: string;
            kind: string;
            payload: Record<string, unknown>;
          }>
        | undefined;
      return interactions?.find(
        (item) =>
          item.kind === "userInput" &&
          (item.payload.options as { optionId: string }[] | undefined)?.some(
            (option) => option.optionId === "Approve",
          ),
      );
    })) as { interactionId: string; payload: Record<string, unknown> };
    assert.equal(card.payload.freeText, false);
    assert.equal(card.payload.answerMode, "option");

    // 宿主直接应答反向请求（allow）→ omp 收到 value "Approve" → 轮次放行完成。
    harness.respond(approvalRequest.id, { action: "accept", content: { optionId: "Approve" } });
    await waitTurnCompleted(harness, 1);

    // 下行 v4 帧全部合法（含 userInput pendingInteraction 的 state patch）。
    for (const frame of harness.frames.filter(
      (item) => (item as { method?: string }).method === "v4/conversation/frame",
    )) {
      const parsed = conversationTopicWireFrameSchema.safeParse(
        (frame as { params: unknown }).params,
      );
      assert.ok(
        parsed.success,
        `v4 frame 不合法: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`,
      );
    }

    // fake 收到的应答选项（经 /approval-report 回读）。
    const report = (await readFakeReport(
      harness,
      sessionId,
      "cmd-v3-perm-report",
      "/approval-report",
      1,
    )) as { id: string; option: string }[];
    assert.equal(report.length, 1);
    assert.match(report[0]!.id, /^fake-/);
    assert.equal(report[0]!.option, "Approve");
  } finally {
    await harness.close();
  }
});

test("v3 审批拒绝：v4 resolveInteraction 选 Deny → 工具被拒收口 error，pending 清空", async () => {
  const harness = await startAdapter(v3HarnessOptions());
  try {
    const sessionId = await createV3Session(harness, "cmd-v3-deny", "请写 greeting 文件");
    await harness.waitUntil(() =>
      harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ),
    );
    const card = (await harness.waitUntil(() => {
      const interactions = harness.collectState().pendingInteractions as
        | Array<{ interactionId: string; payload: Record<string, unknown> }>
        | undefined;
      return interactions?.find((item) =>
        (item.payload.options as { optionId: string }[] | undefined)?.some(
          (option) => option.optionId === "Deny",
        ),
      );
    })) as { interactionId: string };

    // UI 主路径（v4 resolveInteraction）：选择 Deny。
    const resolveResult = await harness.request("v4/command", {
      commandId: "cmd-v3-deny-resolve",
      clientId: "test-client",
      sessionId,
      type: "resolveInteraction",
      payload: {
        interactionId: card.interactionId,
        answer: { action: "accept", optionId: "Deny" },
      },
      issuedAt: Date.now(),
    });
    assert.equal(
      commandAckSchema.parse((resolveResult as { result: unknown }).result).status,
      "accepted",
    );
    await waitTurnCompleted(harness, 1);

    const report = (await readFakeReport(
      harness,
      sessionId,
      "cmd-v3-deny-report",
      "/approval-report",
      1,
    )) as { option: string }[];
    assert.equal(report.length, 1);
    assert.equal(report[0]!.option, "Deny");

    // 工具被拒：工具行收口为 error；pending 交互清空。
    const toolRow = [...harness.collectRows().values()].find(
      (row) => row.kind === "toolCall" && row.toolName === "write",
    );
    assert.ok(toolRow, "缺少 write 工具行");
    assert.equal(toolRow!.status, "error");
    const remaining = (harness.collectState().pendingInteractions ?? []) as unknown[];
    assert.equal(remaining.length, 0, "审批收口后 pending 交互应清空");
  } finally {
    await harness.close();
  }
});
