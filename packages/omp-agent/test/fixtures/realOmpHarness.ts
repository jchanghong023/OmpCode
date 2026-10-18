import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { zcodeUserInputRequestParamsSchema } from "@zcode/shared";
import {
  commandAckSchema,
  pendingInteractionSchema,
  conversationTopicFrameSchema,
  conversationTopicWireFrameSchema,
  TopicWireFrameAssembler,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";
import { installedOmp } from "../../../../scripts/test-gates-plan.mjs";
import { startMockModelServer } from "./ompMockServer.mjs";
import { closeRealOmpProcess, createRealOmpLaunch, spawnRealOmpProcess } from "./realOmpProcess.js";

const ompBinary = await installedOmp();
export const realOmpSkip: false | string =
  process.env.OMP_AGENT_SKIP_REAL_E2E === "1"
    ? "OMP_AGENT_SKIP_REAL_E2E=1（真实 E2E 未验证）"
    : ompBinary
      ? false
      : "本机 omp 二进制未安装（真实 E2E 未验证；不下载或回退 bundled 核）";

type Row = Record<string, unknown>;
export type RealOmpHarnessOptions = {
  handler?: unknown;
  responses?: Iterable<unknown> | AsyncIterable<unknown>;
  root?: string;
  /** 只在测试子进程安装真实文件读取屏障，不改变 adapter/OMP 的业务入口。 */
  sessionReadBarrier?: boolean;
};
export interface SessionReadBarrier {
  reached(): Promise<void>;
  release(): void;
}
const protocolFrameSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type ProtocolFrame = z.infer<typeof protocolFrameSchema>;

export class RealOmpHarness {
  readonly frames: ProtocolFrame[] = [];
  readonly coreLifecycle: Row[] = [];
  private readonly readBarrierMessages: { kind: string; token: number }[] = [];
  private nextId = 1;
  private processError: Error | undefined;
  private readonly closed: Promise<void>;
  private closing: Promise<void> | undefined;
  private stderrTail = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly root: string,
    readonly workspace: string,
    readonly mock: Awaited<ReturnType<typeof startMockModelServer>>,
    private readonly closeFixture: () => Promise<void>,
  ) {
    this.closed = new Promise((done) => child.once("close", () => done()));
    child.on("error", (error) => {
      this.processError = error;
    });
    child.stdin.on("error", (error) => {
      this.processError = error;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8000);
    });
    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on("line", (line) => {
      try {
        const record = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
        if (record.event === "omp_core_spawned" || record.event === "omp_core_exited")
          this.coreLifecycle.push(record);
      } catch {
        /* OMP/loader stderr is not necessarily a structured adapter diagnostic. */
      }
    });
    child.on("message", (message) => {
      const parsed = z.object({ kind: z.string(), token: z.number() }).safeParse(message);
      if (parsed.success) this.readBarrierMessages.push(parsed.data);
    });
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      if (line.trim().length === 0) return;
      try {
        this.frames.push(protocolFrameSchema.parse(JSON.parse(line)));
      } catch {
        /* non-protocol output */
      }
    });
  }

  diagnostics(): string {
    return this.stderrTail;
  }

  async pauseNextSessionRead(sessionId: string): Promise<SessionReadBarrier> {
    assert.ok(this.child.connected, "sessionReadBarrier must be enabled for this fixture");
    const token = ++this.nextId;
    this.child.send({ kind: "session-read-arm", sessionId, token });
    await this.waitUntil(() =>
      this.readBarrierMessages.find(
        (message) => message.kind === "session-read-armed" && message.token === token,
      ),
    );
    return {
      reached: async () => {
        await this.waitUntil(() =>
          this.readBarrierMessages.find(
            (message) => message.kind === "session-read-reached" && message.token === token,
          ),
        );
      },
      release: () => {
        this.child.send({ kind: "session-read-release", token });
      },
    };
  }

  async rawRequest(method: string, params: unknown): Promise<ProtocolFrame> {
    const id = ++this.nextId;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return this.waitUntil(
      () => this.frames.find((frame) => frame.id === id && ("result" in frame || "error" in frame)),
      120000,
    );
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const response = await this.rawRequest(method, params);
    assert.equal(
      response.error,
      undefined,
      `${method}: ${JSON.stringify(response.error)}\n${this.stderrTail}`,
    );
    return response.result;
  }

  respond(id: unknown, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async waitUntil<T>(
    condition: () => T | undefined | null | false,
    timeoutMs = 180000,
  ): Promise<T> {
    const startedAt = Date.now();
    for (;;) {
      this.mock.assertHealthy();
      if (this.processError) throw this.processError;
      assert.ok(
        this.child.exitCode === null && this.child.signalCode === null,
        `adapter exited\n${this.stderrTail}`,
      );
      const match = condition();
      if (match) return match;
      if (Date.now() - startedAt > timeoutMs)
        throw new Error(`waitUntil timeout\n${this.stderrTail}`);
      // 真实跨进程/HTTP 事件不使用测试假时钟；只按可观察条件判断成功。
      await delay(50);
    }
  }

  conversationFrames(sessionId: string): ConversationTopicFrame[] {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const logicalFrames: ConversationTopicFrame[] = [];
    for (const frame of this.frames) {
      if (frame.method !== "v4/conversation/frame") continue;
      const { topic } = z.object({ topic: z.string() }).parse(frame.params);
      if (topic !== `conversation/${sessionId}`) continue;
      const wire = conversationTopicWireFrameSchema.parse(frame.params);
      // 仅完整解码后投影；assembler 按 topic + subscription 隔离分片并校验完整性。
      for (const event of assembler.accept(wire)) {
        if (event.kind === "fault") {
          assert.fail(`conversation frame assembly: ${JSON.stringify(event.fault)}`);
        }
        logicalFrames.push(event.frame);
      }
    }
    return logicalFrames;
  }

  state(sessionId: string): Row {
    let state: Row = {};
    for (const { payload } of this.conversationFrames(sessionId)) {
      if (payload.kind === "snapshot") state = { ...payload.snapshot };
      else
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "state.updated" && delta.patch) Object.assign(state, delta.patch);
        }
    }
    return state;
  }

  rows(sessionId: string): Map<number, Row> {
    const rows = new Map<number, Row>();
    for (const { payload } of this.conversationFrames(sessionId)) {
      if (payload.kind === "snapshot") {
        rows.clear();
        for (const row of payload.snapshot.rows.window) rows.set(row.rowId, { ...row });
      } else
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "row.appended" || delta.op === "row.upserted") {
            rows.set(delta.row.rowId, { ...delta.row });
          } else if (delta.op === "row.delta" && delta.rowId !== undefined && delta.path) {
            const row = rows.get(delta.rowId);
            if (row && typeof delta.append === "string")
              row[delta.path] = String(row[delta.path] ?? "") + delta.append;
          } else if (delta.op === "row.removed") {
            for (const rowId of rows.keys()) if (rowId >= delta.fromRowId) rows.delete(rowId);
          }
        }
    }
    return rows;
  }

  async subscribe(sessionId: string): Promise<void> {
    await this.request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: `real-${sessionId}`,
      clientMode: "desktop-continuous",
    });
  }

  async create(scenario: string, prompt: string): Promise<string> {
    const ack = commandAckSchema.parse(
      await this.request("v4/command", {
        commandId: `real-create-${scenario}`,
        clientId: "e2e-client",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "real-e2e-workspace", firstInput: { text: prompt } },
        issuedAt: Date.now(),
      }),
    );
    assert.equal(
      ack.status,
      "accepted",
      `createSession: ${JSON.stringify(ack)}\n${this.stderrTail}`,
    );
    const sessionId = z.object({ sessionId: z.string().min(1) }).parse(ack.result).sessionId;
    await this.subscribe(sessionId);
    return sessionId;
  }

  terminal(sessionId: string): Row | undefined {
    return [...this.rows(sessionId).values()].find(
      (row) =>
        row.kind === "turnHeader" &&
        ["completedSuccess", "completedInterrupted", "failed"].includes(String(row.state)),
    );
  }

  async complete(sessionId: string, marker: string, toolName: string): Promise<Row[]> {
    await this.waitUntil(() => this.terminal(sessionId));
    const rows = [...this.rows(sessionId).values()];
    assert.equal(
      this.terminal(sessionId)?.state,
      "completedSuccess",
      `真实轮次必须成功完成\n${this.stderrTail}`,
    );
    const text = rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => String(row.text ?? ""))
      .join("");
    assert.ok(text.includes(marker), `缺少成功确认的流式文本 ${marker}\n${this.stderrTail}`);
    const tool = rows.find((row) => row.kind === "toolCall" && row.toolName === toolName);
    assert.equal(
      tool?.status,
      "success",
      `${toolName} 工具未成功: ${JSON.stringify(tool)}\n${this.stderrTail}`,
    );
    return rows;
  }

  async interaction(sessionId: string): Promise<{
    id: string;
    params: z.infer<typeof zcodeUserInputRequestParamsSchema>;
  }> {
    const request = () =>
      this.frames.find((frame) => {
        const candidate = frame as { method?: string; params?: { sessionId?: string } };
        return (
          candidate.method === "interaction/requestUserInput" &&
          candidate.params?.sessionId === sessionId
        );
      });
    // 模型未调用交互工具就结束必须失败，不能把普通文本当作审批或 ask。
    await this.waitUntil(() => request() || this.terminal(sessionId));
    const interaction = z
      .object({ id: z.string(), params: zcodeUserInputRequestParamsSchema })
      .parse(request());
    const card = pendingInteractionSchema.parse(
      await this.waitUntil(() =>
        pendingInteractionSchema
          .array()
          .parse(this.state(sessionId).pendingInteractions ?? [])
          .find((item) => item.interactionId === interaction.params.requestId),
      ),
    );
    assert.equal(card.payload.kind, "userInput", "真实交互必须投影为可操作交互卡");
    return interaction;
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    try {
      await closeRealOmpProcess(this.child, this.closed);
    } finally {
      await this.closeFixture();
    }
  }
}

export async function prepareRealOmpFixture(options: RealOmpHarnessOptions = {}) {
  assert.equal(realOmpSkip, false, String(realOmpSkip));
  assert.ok(ompBinary, "本机 omp 二进制未安装");
  const mock = await startMockModelServer({
    handler: options.handler,
    responses: options.responses,
  });
  let root: string | undefined;
  try {
    root = options.root ?? (await mkdtemp(join(tmpdir(), "zcode-real-e2e-")));
    const workspace = join(root, "workspace");
    const configRoot = join(root, "omp");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await mock.writeConfig(configRoot, { input: ["text", "image"] });
    const launch = createRealOmpLaunch(
      { workspace, home, configRoot, ompBinary },
      options.sessionReadBarrier,
    );
    const fixtureRoot = root;
    let closing: Promise<void> | undefined;
    return {
      root,
      workspace,
      mock,
      launch,
      close(): Promise<void> {
        closing ??= (async () => {
          try {
            await mock.close();
          } finally {
            if (options.root === undefined) await rm(fixtureRoot, { recursive: true, force: true });
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await mock.close();
    } finally {
      if (root && options.root === undefined) await rm(root, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function startRealOmpHarness(
  options: RealOmpHarnessOptions = {},
): Promise<RealOmpHarness> {
  const fixture = await prepareRealOmpFixture(options);
  let harness: RealOmpHarness | undefined;
  try {
    const child = spawnRealOmpProcess(fixture.launch, options.sessionReadBarrier);
    harness = new RealOmpHarness(child, fixture.root, fixture.workspace, fixture.mock, () =>
      fixture.close(),
    );
    await harness.waitUntil(() =>
      harness!.frames.find(
        (frame) =>
          frame.method === "startup/storageState" &&
          z.object({ phase: z.string() }).parse(frame.params).phase === "ready",
      ),
    );
    return harness;
  } catch (error) {
    if (harness) await harness.close();
    else await fixture.close();
    throw error;
  }
}
