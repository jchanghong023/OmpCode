// 适配器协议级 E2E：真实拉起 omp-agent 子进程（tsx），fake omp 作为内嵌核心，
// 验证「storage 就绪 → v4 createSession → 流式 → 工具调用 → 权限确认 → 文件变更 →
// 会话完成」的桌面主链路。所有下行 v4 帧均按 @zcode/shared 的 wire schema 校验。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { zcodeWorkspacePresentationSchema } from "@zcode/shared";
import {
  conversationTopicWireFrameSchema,
  commandAckSchema,
} from "@zcode/shared/zcode-protocol-v4";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const fakeOmpPath = join(packageRoot, "test", "fixtures", "fakeOmp.mjs");
// tsx 以真实 node + cli.mjs 拉起（避免 Windows .cmd shim 在 spawn 下的路径问题）。
const tsxCliPath = join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");

interface WireFrame {
  topic: string;
  payload: { kind: "snapshot" | "deltas"; snapshot?: { rows?: { window?: unknown[] } }; deltas?: unknown[] };
}

class AdapterHarness {
  readonly frames: unknown[] = [];
  private nextRequestId = 100;
  private child: ReturnType<typeof spawn>;

  constructor(child: ReturnType<typeof spawn>) {
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
          (frame) => (frame as { id?: number }).id === id && ("result" in (frame as object) || "error" in (frame as object)),
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
        for (const row of (frame.payload.snapshot?.rows?.window ?? []) as Record<string, unknown>[]) {
          rows.set(row.rowId as number, row);
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
            rows.set(row.rowId as number, row);
          } else if (delta.op === "row.delta" && typeof delta.rowId === "number" && typeof delta.path === "string") {
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
        for (const delta of frame.payload.deltas as { op?: string; patch?: Record<string, unknown> }[]) {
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
  }
}

function assertFrameOrdinalsIncrease(frames: unknown[], subscriptionId: string): void {
  const logical = new Map<string, number>();
  for (const frame of frames) {
    const record = frame as { method?: string; params?: { subscriptionId?: string; logicalFrameId?: string; logicalFrameOrdinal?: number } };
    if (record.method !== "v4/conversation/frame" || record.params?.subscriptionId !== subscriptionId) continue;
    if (record.params.logicalFrameId && record.params.logicalFrameOrdinal) {
      logical.set(record.params.logicalFrameId, record.params.logicalFrameOrdinal);
    }
  }
  const ordinals = [...logical.values()];
  assert.ok(ordinals.length > 1, `Expected multiple logical frames for ${subscriptionId}`);
  assert.deepEqual(ordinals, ordinals.map((_, index) => index + 1));
}

async function startAdapter(extraEnv: Record<string, string> = {}): Promise<AdapterHarness> {
  const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      OMP_RPC_BINARY_PATH: process.execPath,
      OMP_RPC_ARGS_JSON: JSON.stringify([fakeOmpPath]),
      ZCODE_WORKSPACE_IDENTITY: "test-workspace",
      // 隔离 omp 配置目录：测试不得读写用户真实的 ~/.omp 会话数据。
      PI_CONFIG_DIR: join(packageRoot, ".test-omp-home"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4000);
  });
  const harness = new AdapterHarness(child);
  await harness.waitUntil(() =>
    harness.frames.find(
      (frame) =>
        (frame as { method?: string; params?: { phase?: string } }).method === "startup/storageState" &&
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
): Promise<{ ref: string; fileName: string; mime: string; bytes: number }> {
  const extension = mime === "application/pdf" ? "pdf" : mime === "text/plain" ? "txt" : mime === "image/jpeg" ? "jpg" : "png";
  const fileName = `${uploadId}.${extension}`;
  const common = { connectionId: "image-test", uploadId, sessionId };
  const begun = (await harness.request("v4/attachment/begin", {
    ...common,
    fileName,
    mime,
    totalBytes: bytes.length,
    totalChunks: 1,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  })) as { result: { state: string } };
  assert.equal(begun.result.state, "staging");
  await harness.request("v4/attachment/chunk", { ...common, chunkIndex: 0, dataBase64: bytes.toString("base64") });
  const committed = (await harness.request("v4/attachment/commit", common)) as { result: { ref: string } };
  return { ref: committed.result.ref, fileName, mime, bytes: bytes.length };
}

test("v4 图片和文本进入 omp，不能消费的 PDF 在提交前拒绝", async () => {
  const harness = await startAdapter();
  try {
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const first = await uploadFixture(harness, "image-first", "draft-image-test", "image/png", firstBytes);
    const created = (await harness.request("v4/command", {
      commandId: "create-with-image",
      clientId: "image-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/image-report first", attachments: [first] } },
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
      const row = await harness.waitUntil(() =>
        [...harness.collectRows().values()].find(
          (candidate) => candidate.kind === "assistantText" && String(candidate.text ?? "").startsWith(prefix),
        ),
      ) as { text: string };
      return JSON.parse(row.text.slice(prefix.length)) as { hasImages: boolean; images: unknown[] };
    };
    assert.deepEqual(await report("first"), {
      hasImages: true,
      images: [{ type: "image", data: firstBytes.toString("base64"), mimeType: "image/png" }],
    });

    const pdf = await uploadFixture(harness, "document", sessionId, "application/pdf", Buffer.from("%PDF-test"));
    const secondBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const second = await uploadFixture(harness, "image-second", sessionId, "image/jpeg", secondBytes);
    const sent = (await harness.request("v4/command", {
      commandId: "send-with-images",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "/image-report second", attachments: [second, first] },
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
      commandId: "send-with-pdf", clientId: "image-client", sessionId,
      type: "sendText", payload: { text: "请读 PDF", attachments: [pdf] }, issuedAt: Date.now(),
    })) as { result: unknown };
    const unsupportedAck = commandAckSchema.parse(unsupported.result);
    assert.equal(unsupportedAck.status, "rejected");
    assert.match(unsupportedAck.message ?? "", /document\.pdf: unsupported attachment type application\/pdf/u);

    const text = await uploadFixture(harness, "note", sessionId, "text/plain", Buffer.from("TEXT_ATTACHMENT_OK", "utf8"));
    const withText = (await harness.request("v4/command", {
      commandId: "send-with-text", clientId: "image-client", sessionId,
      type: "sendText", payload: { text: "/text-report note", attachments: [text] }, issuedAt: Date.now(),
    })) as { result: unknown };
    assert.equal(commandAckSchema.parse(withText.result).status, "accepted");
    const textRow = await harness.waitUntil(() => [...harness.collectRows().values()].find(
      (row) => row.kind === "assistantText" && String(row.text ?? "").startsWith("TEXT_REPORT:"),
    )) as { text: string };
    const textReport = JSON.parse(textRow.text.slice("TEXT_REPORT:".length)) as { message: string; images: unknown[] };
    assert.match(textReport.message, /note\.txt/u);
    assert.match(textReport.message, /TEXT_ATTACHMENT_OK/u);
    assert.deepEqual(textReport.images, []);

    const plain = (await harness.request("v4/command", {
      commandId: "send-without-images",
      clientId: "image-client",
      sessionId,
      type: "sendText",
      payload: { text: "/image-report plain" },
      issuedAt: Date.now(),
    })) as { result: unknown };
    assert.equal(commandAckSchema.parse(plain.result).status, "accepted");
    assert.deepEqual(await report("plain"), { hasImages: false, images: [] });
  } finally {
    await harness.close();
  }
});

test("omp 的 @ 引用目录不暴露旧插件 RPC 错误", async () => {
  const harness = await startAdapter();
  try {
    const response = await harness.request("plugins/referenceCatalog", { workspace: { workspacePath: packageRoot } }) as {
      result?: { authority: string; plugins: unknown[] };
      error?: unknown;
    };
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, { authority: "workspace", plugins: [] });
  } finally {
    await harness.close();
  }
});

test("omp 子代理事件投影为父会话的状态与可见记录，重复结束幂等", async () => {
  const harness = await startAdapter();
  try {
    const created = await harness.request("v4/command", {
      commandId: "subagent-test", clientId: "subagent-client", sessionId: null,
      type: "createSession", payload: { workspaceId: "test-workspace", firstInput: { text: "SUBAGENT_REPORT" } }, issuedAt: Date.now(),
    }) as { result: unknown };
    const ack = commandAckSchema.parse(created.result);
    assert.equal(ack.status, "accepted");
    const sessionId = (ack.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", { topic: `conversation/${sessionId}`, connectionId: "subagent-test", clientMode: "desktop-continuous" });
    await harness.waitUntil(() => [...harness.collectRows().values()].some((row) => row.kind === "subagent" && row.status === "success"));
    const rows = [...harness.collectRows().values()].filter((row) => row.kind === "subagent");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.subagentType, "scout");
    const subagentDeltas = harness.conversationFrames().flatMap((frame) => frame.payload.kind === "deltas" ? frame.payload.deltas ?? [] : [])
      .filter((delta): delta is { op: string; row?: { kind?: string } } => typeof delta === "object" && delta !== null)
      .filter((delta) => delta.row?.kind === "subagent");
    const initialSubagent = harness.conversationFrames().some((frame) =>
      frame.payload.kind === "snapshot" && frame.payload.snapshot?.rows?.window?.some((row: { kind?: string }) => row.kind === "subagent"));
    if (!initialSubagent) {
      assert.equal(subagentDeltas[0]?.op, "row.appended", "new subagent rows must be delivered to live desktop consumers");
    }
    await harness.waitUntil(() => (harness.collectState().subagents as { endedTotal?: number } | undefined)?.endedTotal === 1);
    assert.equal((harness.collectState().subagents as { endedTotal: number }).endedTotal, 1);
    await harness.waitUntil(() => [...harness.collectRows().values()].some((row) => row.kind === "subagent" && String(row.transcriptText ?? "").includes("Read README")));
    const directory = await harness.request("session/subagents", { sessionId }) as { result: { ended: { total: number; items: unknown[] } } };
    assert.equal(directory.result.ended.total, 1);
    assert.equal(directory.result.ended.items.length, 1);
  } finally {
    await harness.close();
  }
});

test("omp 子代理订阅失败时投影明确不可用，普通会话仍可发送", async () => {
  const harness = await startAdapter({ FAKE_OMP_SUBAGENT_SUBSCRIBE_FAIL: "1" });
  try {
    const created = await harness.request("v4/command", {
      commandId: "subagent-unavailable", clientId: "subagent-client", sessionId: null,
      type: "createSession", payload: { workspaceId: "test-workspace", firstInput: { text: "/help" } }, issuedAt: Date.now(),
    }) as { result: unknown };
    const ack = commandAckSchema.parse(created.result);
    assert.equal(ack.status, "accepted");
    const sessionId = (ack.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", { topic: `conversation/${sessionId}`, connectionId: "subagent-unavailable", clientMode: "desktop-continuous" });
    await harness.waitUntil(() => (harness.collectState().subagents as { availability?: string } | undefined)?.availability === "unavailable");
    assert.ok([...harness.collectRows().values()].some((row) => row.kind === "assistantText" && String(row.text).includes("Fake help output")));
  } finally {
    await harness.close();
  }
});

test("workspace/readPresentation 符合 Host 严格响应协议", async () => {
  const harness = await startAdapter();
  try {
    const workspace = {
      workspacePath: packageRoot,
      workspaceIdentity: "test-workspace",
      workspaceKey: "test-workspace",
    };
    const response = (await harness.request("workspace/readPresentation", { workspace })) as {
      result: unknown;
    };
    const presentation = zcodeWorkspacePresentationSchema.parse(response.result);
    assert.deepEqual(presentation.workspace, workspace);
    assert.equal(presentation.mode, "build");
    assert.deepEqual(presentation.slashCommands, [
      { name: "help", description: "Show help", source: "builtin" },
      { name: "ship", description: "Ship changes", inputHint: "target", source: "custom" },
    ]);
    const modelOption = presentation.configOptions?.find((option) => option.id === "model")?.options?.[0];
    assert.equal(modelOption?.value, "mock/mock-1");
    assert.deepEqual(modelOption?.modelThoughtLevels, ["off", "low", "high", "max"]);
    assert.equal(modelOption?.modelDefaultThoughtLevel, "high");
    assert.equal(presentation.configOptions?.find((option) => option.id === "thought_level")?.currentValue, "max");
  } finally {
    await harness.close();
  }
});

test("自动压缩开关通过 omp RPC 更新并投影实际状态", async () => {
  const harness = await startAdapter();
  try {
    const created = (await harness.request("v4/command", {
      commandId: "create-auto-compaction",
      clientId: "auto-compaction-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "HOLD 自动压缩" } },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const createAck = commandAckSchema.parse(created.result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    const subscribed = (await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "auto-compaction-desktop",
      clientMode: "desktop-continuous",
    })) as { result: { ack: { logEpoch: string } } };
    await harness.waitUntil(() =>
      (harness.collectState().config as { autoCompactionEnabled?: boolean } | undefined)
        ?.autoCompactionEnabled === true,
    );
    const initial = harness.collectState();
    assert.equal((initial.config as { model: string }).model, "mock-1");
    assert.equal((initial.config as { thought: string }).thought, "max");
    assert.deepEqual((initial.usage as { contextWindow: unknown }).contextWindow, {
      usedTokens: 512,
      maxTokens: 200000,
      autoCompactThresholdTokens: null,
    });

    let baseRevision = (harness.collectState().revision as number | undefined) ?? 0;
    let accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const changed = (await harness.request("v4/command", {
        commandId: `set-auto-compaction-${attempt}`,
        clientId: "auto-compaction-client",
        sessionId,
        type: "setAutoCompaction",
        payload: { enabled: false },
        baseRevision,
        baseLogEpoch: subscribed.result.ack.logEpoch,
        issuedAt: Date.now(),
      })) as { result: unknown };
      const ack = commandAckSchema.parse(changed.result);
      if (ack.status === "accepted") {
        accepted = true;
        break;
      }
      assert.equal(ack.status, "stale", JSON.stringify(ack));
      baseRevision = ack.revisionAtDecision;
    }
    assert.equal(accepted, true);
    await harness.waitUntil(() =>
      (harness.collectState().config as { autoCompactionEnabled?: boolean } | undefined)
        ?.autoCompactionEnabled === false,
    );
    for (const frame of harness.frames.filter(
      (item) => (item as { method?: string }).method === "v4/conversation/frame",
    )) {
      const parsed = conversationTopicWireFrameSchema.safeParse((frame as { params: unknown }).params);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3)));
    }
  } finally {
    await harness.close();
  }
});

for (const [command, expectedOutput] of [["/help", "Fake help output"], ["/later", "Delayed output"]] as const) {
  test(`本地斜杠命令 ${command} 输出后结束轮次`, async () => {
    const harness = await startAdapter();
    try {
      const created = (await harness.request("v4/command", {
        commandId: `create-${command}`,
        clientId: "slash-client",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "test-workspace", firstInput: { text: command } },
        issuedAt: Date.now(),
      })) as { result: unknown };
      const ack = commandAckSchema.parse(created.result);
      assert.equal(ack.status, "accepted");
      const sessionId = (ack.result as { sessionId: string }).sessionId;
      await harness.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: `slash-${command}`,
        clientMode: "desktop-continuous",
      });
      await harness.waitUntil(() => [...harness.collectRows().values()].some(
        (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
      ));
      const rows = [...harness.collectRows().values()];
      assert.ok(rows.some((row) => row.kind === "assistantText" && String(row.text).includes(expectedOutput)));
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
      harness.frames.find((frame) => (frame as { method?: string }).method === "interaction/requestUserInput"),
    )) as { id: string; params: { requestId: string; prompt: string } };
    assert.match(interaction.params.prompt, /greeting\.txt/);

    // 4. 直接应答反向请求（host 的另一条应答路径）
    harness.respond(interaction.id, { action: "accept", content: { value: "Approve" } });

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
      const parsed = conversationTopicWireFrameSchema.safeParse((frame as { params: unknown }).params);
      assert.ok(parsed.success, `v4 frame 不合法: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`);
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
      harness.frames.find((frame) => (frame as { method?: string }).method === "interaction/requestUserInput"),
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
        if (row.kind === "turnHeader" && (row.state === "completedInterrupted" || row.state === "completedSuccess")) {
          return true;
        }
      }
      return false;
    });
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
    const followupImage = await uploadFixture(harness, "followup-image", sessionId, "image/png", followupImageBytes);
    const imageEcho = `|IMAGES:${JSON.stringify([{ type: "image", data: followupImageBytes.toString("base64"), mimeType: "image/png" }])}`;
    const steerSend = await harness.request("v4/command", {
      commandId: "cmd-fm-send-1",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "引导补充", attachments: [followupImage] },
      issuedAt: Date.now(),
    });
    assert.equal(commandAckSchema.parse((steerSend as { result: unknown }).result).status, "accepted");
    await harness.waitUntil(() => {
      for (const row of harness.collectRows().values()) {
        if (row.kind === "assistantText" && String(row.text ?? "").includes(`STEERED:引导补充${imageEcho}`)) {
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
        if (row.kind === "assistantText" && String(row.text ?? "").includes(`FOLLOWEDUP:队列补充${imageEcho}`)) {
          return true;
        }
      }
      return false;
    });
  } finally {
    await harness.close();
  }
});

test("临时模型：modelSelection 随提交下发，相同选择不重复 set_model", async () => {
  const harness = await startAdapter();
  try {
    const selection = { providerId: "mock", modelId: "mock-2", options: { reasoningLevel: "high" } };
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-model-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/help", modelSelection: selection } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-model",
      clientMode: "desktop-continuous",
    });
    await harness.waitUntil(() => [...harness.collectRows().values()].some(
      (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
    ));
    const rows = [...harness.collectRows().values()];
    const marker = rows.find((row) => row.kind === "timelineMarker" && (row as { marker?: { type?: string } }).marker?.type === "modelChange") as
      | { marker?: { toProvider?: string; toModel?: string } }
      | undefined;
    assert.ok(marker, "缺少 modelChange 时间线标记");
    assert.equal(marker!.marker!.toProvider, "mock");
    assert.equal(marker!.marker!.toModel, "mock-2");
    const state = harness.collectState();
    assert.equal((state.config as { provider?: string })?.provider, "mock");
    assert.equal((state.config as { model?: string })?.model, "mock-2");
    assert.equal((state.config as { thought?: string })?.thought, "high");

    // 相同选择的第二次提交不应再次下发 set_model（fake 核统计并经 /model-report 回报）。
    const sendResult = await harness.request("v4/command", {
      commandId: "cmd-model-send",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "/model-report", modelSelection: selection },
      issuedAt: Date.now(),
    });
    assert.equal(commandAckSchema.parse((sendResult as { result: unknown }).result).status, "accepted");
    await harness.waitUntil(() => [...harness.collectRows().values()].some(
      (row) => row.kind === "assistantText" && String(row.text).includes("set_model calls: 1"),
    ));
  } finally {
    await harness.close();
  }
});

test("session_info_update / config_update 回投会话标题与模型状态", async () => {
  const harness = await startAdapter();
  try {
    const createResult = await harness.request("v4/command", {
      commandId: "cmd-info-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/title Fake Title" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-info",
      clientMode: "desktop-continuous",
    });
    await harness.waitUntil(() => {
      const state = harness.collectState();
      return (state.meta as { title?: string } | undefined)?.title === "Fake Title" ? true : undefined;
    });
    const sendResult = await harness.request("v4/command", {
      commandId: "cmd-info-send",
      clientId: "test-client",
      sessionId,
      type: "sendText",
      payload: { text: "/config-new" },
      issuedAt: Date.now(),
    });
    assert.equal(commandAckSchema.parse((sendResult as { result: unknown }).result).status, "accepted");
    await harness.waitUntil(() => {
      const state = harness.collectState();
      const config = state.config as { model?: string; thought?: string } | undefined;
      return config?.model === "mock-9" && config?.thought === "high" ? true : undefined;
    });
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
    await harness.waitUntil(() => [...harness.collectRows().values()].some(
      (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
    ));
    // 轮次已完成：sessions-index 的最后一次 session.upserted 必须是终态 phase。
    // 丢弃式节流的回归场景：终态 flush 落在上次通知 500ms 窗口内被丢弃，索引停在 running。
    await harness.waitUntil(() => {
      let lastPhase: string | null = null;
      for (const frame of harness.topicFrames("sessions-index/test-workspace")) {
        if (frame.payload.kind !== "deltas") continue;
        for (const delta of frame.payload.deltas as { op?: string; session?: { phase?: string } }[]) {
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

test("available_commands_update 热刷新 workspace-config 命令目录", async () => {
  const harness = await startAdapter();
  try {
    const configSubscribe = (await harness.request("v4/conversation/subscribe", {
      topic: "workspace-config/test-workspace",
      connectionId: "conn-wc",
    })) as { result: { ack: { subscriptionId: string } } };
    assert.ok(configSubscribe.result.ack.subscriptionId.length > 0);

    const createResult = await harness.request("v4/command", {
      commandId: "cmd-cmds-create",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", firstInput: { text: "/install-ship2" } },
      issuedAt: Date.now(),
    });
    const createAck = commandAckSchema.parse((createResult as { result: unknown }).result);
    assert.equal(createAck.status, "accepted");
    const sessionId = (createAck.result as { sessionId: string }).sessionId;
    await harness.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "conn-cmds",
      clientMode: "desktop-continuous",
    });
    await harness.waitUntil(() => {
      for (const frame of harness.topicFrames("workspace-config/test-workspace")) {
        if (frame.payload.kind !== "deltas") continue;
        for (const delta of frame.payload.deltas as { op?: string; config?: { slashCommands?: { name: string }[] } }[]) {
          if (delta.op === "config.updated" && delta.config?.slashCommands?.some((command) => command.name === "ship2")) {
            return true;
          }
        }
      }
      return undefined;
    });
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
      return (state.control as { phase?: string } | undefined)?.phase === "error" ? true : undefined;
    });
    const state = harness.collectState();
    const lastError = (state.control as { lastError?: { code?: string; message?: string } | null } | undefined)?.lastError;
    assert.equal(lastError?.code, "omp_provider_401");
    assert.match(lastError?.message ?? "", /401 Model not supported/);
  } finally {
    await harness.close();
  }
});
