// 适配器协议级 E2E：真实拉起 omp-agent 子进程（tsx），fake omp 作为内嵌核心，
// 验证「storage 就绪 → v4 createSession → 流式 → 工具调用 → 权限确认 → 文件变更 →
// 会话完成」的桌面主链路。所有下行 v4 帧均按 @zcode/shared 的 wire schema 校验。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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
        for (const delta of frame.payload.deltas as { op?: string; row?: Record<string, unknown> }[]) {
          if (delta.op === "row.appended" || delta.op === "row.upserted") {
            const row = delta.row as Record<string, unknown>;
            rows.set(row.rowId as number, row);
          }
        }
      }
    }
    return rows;
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => {
      this.child.once("exit", () => done());
      this.child.stdin.end();
      setTimeout(() => this.child.kill("SIGKILL"), 3000).unref?.();
    });
  }
}

async function startAdapter(): Promise<AdapterHarness> {
  const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      OMP_RPC_BINARY_PATH: process.execPath,
      OMP_RPC_ARGS_JSON: JSON.stringify([fakeOmpPath]),
      ZCODE_WORKSPACE_IDENTITY: "test-workspace",
      // 隔离 omp 配置目录：测试不得读写用户真实的 ~/.omp 会话数据。
      PI_CONFIG_DIR: join(packageRoot, ".test-omp-home"),
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
