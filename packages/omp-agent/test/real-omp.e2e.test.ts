// 真实已安装 omp 二进制 → omp-agent 适配器 → ZCode v4 公开协议的 E2E。
// 仅模型响应由本地模拟服务提供；工具、审批、ask、子代理及记录读取都由真实 OMP 执行。
// 移除对外部模型可用性及用户凭据的依赖，避免网络、配额和认证波动污染本地验收。
// 独立临时 OMP 根与工作区；没有安装核时跳过，不下载或安装，门禁将跳过视为未验证。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { zcodeUserInputRequestParamsSchema } from "@zcode/shared";
import { z } from "zod";
import {
  commandAckSchema,
  pendingInteractionSchema,
  conversationTopicFrameSchema,
  conversationTopicWireFrameSchema,
  TopicWireFrameAssembler,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  MOCK_PROVIDER,
  MOCK_MODEL_ID,
  MOCK_MODEL_SELECTOR,
  startMockModelServer,
} from "./fixtures/ompMockServer.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const ompBinary =
  process.env.OMP_RPC_BINARY_PATH ??
  join(
    repoRoot,
    "packages",
    "desktop",
    "bundled-agents",
    `${process.platform}-${process.arch}`,
    "glm",
    "omp",
    process.platform === "win32" ? "omp.exe" : "omp",
  );
const hasRealBinary = process.env.OMP_AGENT_SKIP_REAL_E2E !== "1" && existsSync(ompBinary);

type Row = Record<string, unknown>;
const protocolFrameSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

class Harness {
  readonly frames: z.infer<typeof protocolFrameSchema>[] = [];
  private nextId = 1;
  private processError: Error | undefined;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private assertHealthy: () => void,
    private stderr: () => string,
  ) {
    child.on("error", (error) => {
      this.processError = error;
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
  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const response = await this.waitUntil(
      () => this.frames.find((frame) => frame.id === id && ("result" in frame || "error" in frame)),
      120000,
    );
    assert.equal(
      response.error,
      undefined,
      `${method}: ${JSON.stringify(response.error)}\n${this.stderr()}`,
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
      this.assertHealthy();
      if (this.processError) throw this.processError;
      assert.equal(this.child.exitCode, null, `adapter exited\n${this.stderr()}`);
      const match = condition();
      if (match) return match;
      if (Date.now() - startedAt > timeoutMs)
        throw new Error(`waitUntil timeout\n${this.stderr()}`);
      // 真实跨进程/HTTP 事件不可用测试假时钟推进；轮询等待可观察条件，不按固定延迟宣告成功。
      await delay(50);
    }
  }
  conversationFrames(sessionId: string): ConversationTopicFrame[] {
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const logicalFrames: ConversationTopicFrame[] = [];
    for (const frame of this.frames) {
      if (frame.method !== "v4/conversation/frame") continue;
      const wire = conversationTopicWireFrameSchema.parse(frame.params);
      if (wire.topic !== `conversation/${sessionId}`) continue;
      // NDJSON params 是物理信封；仅完整解码后才允许快照/增量进入投影。
      // assembler 按 topic + subscription 隔离分片，并校验字节、校验和及逻辑帧 schema。
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
    assert.equal(ack.status, "accepted", `createSession: ${JSON.stringify(ack)}\n${this.stderr()}`);
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
      `真实轮次必须成功完成\n${this.stderr()}`,
    );
    const text = rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => String(row.text ?? ""))
      .join("");
    assert.ok(text.includes(marker), `缺少成功确认的流式文本 ${marker}\n${this.stderr()}`);
    const tool = rows.find((row) => row.kind === "toolCall" && row.toolName === toolName);
    assert.equal(
      tool?.status,
      "success",
      `${toolName} 工具未成功: ${JSON.stringify(tool)}\n${this.stderr()}`,
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
}

test(
  `真实 OMP + 模拟模型 ${MOCK_MODEL_SELECTOR}：流式、write 审批、ask 作答及真实子代理记录`,
  { skip: hasRealBinary ? false : "本机 omp 二进制未安装（跳过真实 E2E）" },
  async () => {
    const mock = await startMockModelServer();
    let root: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      root = await mkdtemp(join(tmpdir(), "zcode-real-e2e-"));
      const sandbox = join(root, "workspace");
      const configRoot = join(root, "omp");
      const home = join(root, "home");
      await mkdir(sandbox);
      await mkdir(join(home, ".claude"), { recursive: true });
      await mock.writeConfig(configRoot);
      // HOME/.env 会补回已删凭据并改 agent 根；broker、叠加设置与 Claude 目录也必须隔离。
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(key) &&
            !/^(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL$/iu.test(key) &&
            !/^(?:OMP_AUTH_BROKER_.+|PI_CONFIG_FILES|CLAUDE_CONFIG_DIR|OMP_OFFLINE|HOME|USERPROFILE|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|OMP_RPC_ARGS_JSON|OMP_E2E_MODEL_SELECTOR)$/iu.test(
              key,
            ),
        ),
      );
      child = spawn(
        process.execPath,
        ["--import", tsxLoader, adapterEntry, "app-server", "--stdio"],
        {
          cwd: sandbox,
          env: {
            ...inheritedEnv,
            HOME: home,
            USERPROFILE: home,
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
            OMP_OFFLINE: "",
            PI_CONFIG_FILES: "",
            OMP_CONFIG_ROOT: configRoot,
            OMP_PROFILE: "",
            PI_PROFILE: "",
            OMPCODE_CENTOS7_PROFILE: "",
            PI_CONFIG_DIR: "",
            PI_CODING_AGENT_DIR: "",
            OMP_E2E_MODEL_SELECTOR: "",
            PI_SMOL_MODEL: "",
            PI_SLOW_MODEL: "",
            PI_PLAN_MODEL: "",
            OMP_SMOL_MODEL: "",
            OMP_SLOW_MODEL: "",
            OMP_PLAN_MODEL: "",
            ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace",
            OMP_RPC_BINARY_PATH: ompBinary,
            OMP_RPC_ARGS_JSON: JSON.stringify([
              "--provider",
              MOCK_PROVIDER,
              "--model",
              MOCK_MODEL_ID,
              "--no-title",
              "--thinking",
              "low",
              "--approval-mode",
              "always-ask",
            ]),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8000);
      });
      const harness = new Harness(
        child,
        () => mock.assertHealthy(),
        () => stderrTail,
      );
      await harness.waitUntil(() =>
        harness.frames.find(
          (frame) =>
            frame.method === "startup/storageState" &&
            z.object({ phase: z.string() }).parse(frame.params).phase === "ready",
        ),
      );

      const writeSession = await harness.create("write", "ZCODE_MOCK_WRITE greeting-real.txt");
      const approval = await harness.interaction(writeSession);
      const { options } = z
        .object({ options: z.array(z.object({ optionId: z.string(), label: z.string() })) })
        .parse(approval.params.input);
      const approve = options.find((option) => option.optionId === "Approve");
      assert.ok(approve, "真实 always-ask 核必须提供允许一次写入的选项");
      const approvalCard = pendingInteractionSchema
        .array()
        .parse(harness.state(writeSession).pendingInteractions)
        .find((item) => item.interactionId === approval.params.requestId);
      assert.ok(approvalCard?.payload.kind === "userInput");
      assert.deepEqual(approvalCard.payload.options, options, "投影卡须保留真实审批选项");
      // stdio 的选择应答位于 content.optionId；value 是自由文本，不能冒充选项。
      harness.respond(approval.id, { action: "accept", content: { optionId: approve.optionId } });
      await harness.complete(writeSession, "OMP_MOCK_WRITE_DONE", "write");
      assert.equal(
        await readFile(join(sandbox, "greeting-real.txt"), "utf8"),
        "real omp wrote this\n",
      );
      mock.assertHealthy();

      const askMarker = "CORE_ASK";
      const askSession = await harness.create("ask", `ZCODE_MOCK_ASK ${askMarker}`);
      const ask = await harness.interaction(askSession);
      assert.equal(ask.params.questions?.length, 1, "真实 ask 必须携带完整问题集");
      const question = ask.params.questions![0]!;
      assert.equal(question.question, `Choose the mock answer for ${askMarker}`);
      assert.deepEqual(
        question.options.map((option) => option.label),
        ["Mock answer A", "Mock answer B"],
      );
      const askCard = pendingInteractionSchema
        .array()
        .parse(harness.state(askSession).pendingInteractions)
        .find((item) => item.interactionId === ask.params.requestId);
      assert.ok(askCard?.payload.kind === "userInput");
      assert.equal(askCard.payload.toolName, "AskUserQuestion");
      assert.deepEqual(askCard.payload.questions, ask.params.questions, "问答投影须保留真实选项");
      harness.respond(ask.id, { action: "accept", content: { answer_0: ["Mock answer A"] } });
      await harness.complete(askSession, `${askMarker}_ASK_DONE`, "ask");
      assert.deepEqual(harness.state(askSession).pendingInteractions, [], "ask 应答后必须收口");
      mock.assertHealthy();

      const taskMarker = "CORE_TASK";
      const taskSession = await harness.create("task", `ZCODE_MOCK_TASK ${taskMarker}`);
      // task 是 exec-tier；同一 always-ask 策略也必须真实批准子代理执行，不能旁路授权。
      const taskApproval = await harness.interaction(taskSession);
      assert.match(taskApproval.params.prompt ?? "", /task/u);
      const taskOptions = z
        .object({ options: z.array(z.object({ optionId: z.string() })) })
        .parse(taskApproval.params.input).options;
      const allowTask = taskOptions.find((option) => option.optionId === "Approve");
      assert.ok(allowTask, "真实 task 必须提供一次性执行审批");
      harness.respond(taskApproval.id, {
        action: "accept",
        content: { optionId: allowTask.optionId },
      });
      const taskRows = await harness.complete(taskSession, `${taskMarker}_TASK_DONE`, "task");
      const subagent = await harness.waitUntil(() =>
        [...harness.rows(taskSession).values()].find(
          (row) => row.kind === "subagent" && row.status === "success",
        ),
      );
      assert.equal(subagent.subagentType, "task");
      const childSessionId = z.string().min(1).parse(subagent.childSessionId);
      assert.notEqual(childSessionId, taskSession, "子代理必须拥有独立身份");
      assert.match(childSessionId, /^omp-subagent:MockChild_CORE_TASK@/u);
      const taskRow = taskRows.find((row) => row.kind === "toolCall" && row.toolName === "task")!;
      assert.equal(subagent.parentToolCallId, taskRow.toolCallId, "子代理必须关联真实父工具调用");
      // 详情订阅触发 get_subagent_messages 读取子代理真实保存记录，不从父代理完成文本取证。
      await harness.subscribe(childSessionId);
      const childRows = [...harness.rows(childSessionId).values()];
      assert.ok(
        childRows.some(
          (row) =>
            row.kind === "userInput" &&
            String(row.text ?? "").includes(`ZCODE_MOCK_CHILD ${taskMarker}`),
        ),
        "真实子记录必须包含派发输入",
      );
      assert.ok(
        childRows.some(
          (row) =>
            row.kind === "assistantText" &&
            String(row.text ?? "").includes(`${taskMarker}_CHILD_DONE`),
        ),
        "真实子记录必须包含实际子输出",
      );
      // 父工具参数本身也含 CHILD，必须核对独立请求的 user 内容，不能只搜索所有请求字符串。
      const childRequests = mock.calls.filter((call: unknown) => {
        const parsed = z
          .object({
            context: z.object({
              messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
            }),
          })
          .parse(call);
        return parsed.context.messages.some((message) => {
          if (message.role !== "user") return false;
          const text =
            typeof message.content === "string"
              ? message.content
              : z
                  .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
                  .parse(message.content)
                  .filter((block) => block.type === "text")
                  .map((block) => block.text ?? "")
                  .join("\n");
          // OMP date-cwd-reminder 仅前置固定提醒；字符串与独立 text block 分别产生两个或一个换行。
          // 只移除这个已知的首部信封，剩余 user 正文仍须完整匹配，父 task 参数不能充当子请求。
          const input = text.replace(
            /^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\r\n]+'\. Do not repeat this information in your reply\.\n<\/system-reminder>\n{1,2}/u,
            "",
          );
          // tiny-model 的 task label 请求独立存在，不能作为实际执行子任务的 HTTP 证据。
          if (input === `<user>\nZCODE_MOCK_CHILD ${taskMarker}\n</user>`) return false;
          // 真实 structured-subagent 路径通过 renderSubagentPrompt 派发完整任务信封；
          // 裸 CHILD 标记同样不证明执行了真实 assignment。
          return input === `Complete assignment thoroughly:\n\nZCODE_MOCK_CHILD ${taskMarker}`;
        });
      });
      assert.equal(
        childRequests.length,
        1,
        "必须观察到一次携带完整 assignment 的独立真实子模型请求",
      );
      mock.assertHealthy();
      console.log(
        "[real-e2e] 真实 OMP + 模拟模型：流式、审批、write 精确落盘、ask 回答及独立子代理记录通过",
      );
    } finally {
      try {
        // taskkill 返回不代表原生 SQLite 句柄已释放；真实 EOF dispose 后再删除隔离根。
        if (child && child.exitCode === null && child.pid !== undefined) {
          const closed = once(child, "close");
          child.stdin.end();
          await closed;
        }
      } finally {
        try {
          await mock.close();
        } finally {
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
);
