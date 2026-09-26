// 真实 omp release 二进制 E2E（换核验收）：驱动「内嵌 omp.exe → omp-agent 适配器 →
// ZCode v4 协议」全链路。
// 模型按 FORK.md 测试约定：使用用户 omp 配置的 zhipu-coding-plan/glm-5.3-flash
// （走用户 omp 既有凭据，行为与日常 omp 一致）；
// 审批模式用运行时 flag --approval-mode write（不持久化，不改用户配置）；
// 工作区为沙箱目录，不触碰用户文件。
// omp 会话文件按其自身目录规则落在用户会话库的新桶目录（与用户日常使用等效，只增不改）。
// 未下载二进制（bundled-agents/<plat>/glm/omp/omp(.exe)）时跳过。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { zcodeWorkspacePresentationSchema } from "@zcode/shared";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { commandAckSchema } from "@zcode/shared/zcode-protocol-v4";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const tsxCliPath = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);
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
// 真实模型统一走用户 omp 配置的 glm-5.3-flash（FORK.md 测试约定）；不依赖
// commandcode 免费模型（每日 100 次配额，耗尽后 429 会污染验收结果）。
const ompModelArgs = ["--provider", "zhipu-coding-plan", "--model", "glm-5.3-flash"];

const hasRealBinary = process.env.OMP_AGENT_SKIP_REAL_E2E !== "1" && existsSync(ompBinary);

class Harness {
  readonly frames: unknown[] = [];
  private nextId = 1;
  constructor(private child: ReturnType<typeof spawn>) {
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      if (line.trim().length === 0) return;
      try {
        this.frames.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    });
  }
  request(method: string, params: unknown): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolveRequest, rejectRequest) => {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        const match = this.frames.find(
          (frame) =>
            (frame as { id?: number }).id === id &&
            ("result" in (frame as object) || "error" in (frame as object)),
        );
        if (match) {
          clearInterval(poll);
          resolveRequest(match);
        } else if (Date.now() - startedAt > 120000) {
          clearInterval(poll);
          rejectRequest(new Error(`request timeout: ${method}`));
        }
      }, 25);
    });
  }
  respond(id: unknown, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
  async waitUntil(condition: () => unknown, timeoutMs = 180000): Promise<unknown> {
    const startedAt = Date.now();
    for (;;) {
      const match = condition();
      if (match) return match;
      if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timeout");
      await new Promise((sleep) => setTimeout(sleep, 50));
    }
  }
  state(): Record<string, unknown> {
    let state: Record<string, unknown> = {};
    for (const frame of this.frames) {
      if ((frame as { method?: string }).method !== "v4/conversation/frame") continue;
      const wire = (frame as { params: { frame?: { topic?: string; payload: unknown } } }).params
        .frame;
      if (!wire) continue;
      const payload = wire.payload as {
        kind: string;
        snapshot?: Record<string, unknown>;
        deltas?: { op?: string; patch?: Record<string, unknown> }[];
      };
      if (payload.kind === "snapshot") {
        state = { ...payload.snapshot };
      } else {
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "state.updated" && delta.patch) Object.assign(state, delta.patch);
        }
      }
    }
    return state;
  }
  rows(): Map<number, Record<string, unknown>> {
    const rows = new Map<number, Record<string, unknown>>();
    for (const frame of this.frames) {
      if ((frame as { method?: string }).method !== "v4/conversation/frame") continue;
      const wire = (frame as { params: { frame?: { payload: unknown } } }).params.frame;
      if (!wire) continue;
      const payload = wire.payload as {
        kind: string;
        snapshot?: { rows?: { window?: unknown[] } };
        deltas?: { op?: string; row?: Record<string, unknown> }[];
      };
      if (payload.kind === "snapshot") {
        for (const row of (payload.snapshot?.rows?.window ?? []) as Record<string, unknown>[])
          rows.set(row.rowId as number, row);
      } else {
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "row.appended" || delta.op === "row.upserted") {
            rows.set(delta.row!.rowId as number, delta.row!);
          }
        }
      }
    }
    return rows;
  }
}

test(
  "真实 omp 二进制 + glm-5.3-flash：流式 → write 工具 → 审批 → 文件落盘 → 完成",
  { skip: hasRealBinary ? false : "内嵌 omp 二进制未下载（跳过真实 E2E）" },
  async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "zcode-real-e2e-"));
    const targetFile = join(sandbox, "greeting-real.txt");

    const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
      cwd: sandbox,
      env: {
        ...process.env,
        ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace",
        OMP_RPC_BINARY_PATH: ompBinary,
        // 附加 omp 启动参数：固定 commandcode 免费模型；审批走运行时 flag，不写用户配置。
        OMP_RPC_ARGS_JSON: JSON.stringify([...ompModelArgs, "--approval-mode", "write"]),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8000);
    });
    const harness = new Harness(child);
    try {
      await harness.waitUntil(() =>
        harness.frames.find(
          (frame) =>
            (frame as { method?: string; params?: { phase?: string } }).method ===
              "startup/storageState" &&
            (frame as { params?: { phase?: string } }).params?.phase === "ready",
        ),
      );

      const presentationResponse = (await harness.request("workspace/readPresentation", {
        workspace: {
          workspacePath: sandbox,
          workspaceIdentity: "real-e2e-workspace",
          workspaceKey: "real-e2e-workspace",
        },
      })) as { result: unknown };
      const presentation = zcodeWorkspacePresentationSchema.parse(presentationResponse.result);
      assert.ok(presentation.slashCommands.length > 0, `真实 omp 未返回命令目录\n${stderrTail}`);

      const createResult = (await harness.request("v4/command", {
        commandId: "real-create-1",
        clientId: "e2e-client",
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: "real-e2e-workspace",
          firstInput: {
            text: "请用 write 工具创建文件 greeting-real.txt，内容为一行：real omp wrote this",
          },
        },
        issuedAt: Date.now(),
      })) as { result: unknown };
      const createAck = commandAckSchema.parse(createResult.result);
      assert.equal(
        createAck.status,
        "accepted",
        `createSession: ${JSON.stringify(createAck)}\n${stderrTail}`,
      );
      const sessionId = (createAck.result as { sessionId: string }).sessionId;

      await harness.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: "real-conn",
        clientMode: "desktop-continuous",
      });

      // --approval-mode write：模型调用 write 工具时触发 omp 审批 select → 适配器转
      // interaction/requestUserInput。免费模型是否调用工具不受控：先到者为准（交互或轮完成）。
      const firstSignal = (await harness.waitUntil(() => {
        const hasInteraction = harness.frames.some(
          (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
        );
        const turnDone = [...harness.rows().values()].some(
          (row) =>
            row.kind === "turnHeader" &&
            (row.state === "completedSuccess" ||
              row.state === "completedInterrupted" ||
              row.state === "failed"),
        );
        return hasInteraction || turnDone;
      })) as unknown;
      const interaction = harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ) as { id: string; params: { requestId: string; prompt: string } } | undefined;
      if (interaction) {
        assert.match(
          interaction.params.prompt,
          /write|greeting|approv/i,
          `审批提示异常: ${interaction.params.prompt}`,
        );
        harness.respond(interaction.id, { action: "accept", content: { value: "Approve" } });
      }
      void firstSignal;

      // 会话完成（真实 omp agent_end → turnHeader 终态）
      await harness.waitUntil(() => {
        for (const row of harness.rows().values()) {
          if (
            row.kind === "turnHeader" &&
            (row.state === "completedSuccess" ||
              row.state === "completedInterrupted" ||
              row.state === "failed")
          ) {
            return true;
          }
        }
        return false;
      });

      // 免费模型自由生成：工具行与文件按实际行为验证；流式文本必须存在。
      const rows = [...harness.rows().values()];
      const toolRow = rows.find((row) => row.kind === "toolCall" && row.toolName === "write");
      const headerRow = rows.find((row) => row.kind === "turnHeader");
      const textLength = rows
        .filter((row) => row.kind === "assistantText")
        .reduce((total, row) => total + String(row.text ?? "").length, 0);
      assert.ok(headerRow, `缺少 turnHeader 行\n${stderrTail}`);
      assert.ok(textLength > 0, `缺少 assistantText 流式输出\n${stderrTail}`);
      if (interaction) {
        assert.ok(toolRow, `出现审批但缺少 write 工具行\n${stderrTail}`);
      }
      if (toolRow && toolRow.status === "success" && existsSync(targetFile)) {
        const written = readFileSync(targetFile, "utf8");
        assert.ok(written.trim().length > 0, "文件为空");
        console.log("[real-e2e] 文件已落盘:", written.trim().slice(0, 80));
      } else {
        console.log("[real-e2e] write 工具行:", toolRow?.status ?? "未调用");
      }
    } finally {
      child.kill();
      await new Promise((done) => setTimeout(done, 300));
    }
  },
);

test(
  "真实 omp 二进制：本地命令收口 + 临时模型切换到 glm-5.3-flash",
  { skip: hasRealBinary ? false : "内嵌 omp 二进制未下载（跳过真实 E2E）" },
  async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "zcode-real-e2e-model-"));

    const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
      cwd: sandbox,
      env: {
        ...process.env,
        ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace-2",
        OMP_RPC_BINARY_PATH: ompBinary,
        // 基座用 muse-spark（免费、与 glm 凭据无关），临时模型切换目标才是 glm-5.3-flash，
        // 这样「模型已切换」标记与 set_model 下发才有可断言的差值。
        OMP_RPC_ARGS_JSON: JSON.stringify([
          "--provider",
          "opencode-zen",
          "--model",
          "muse-spark-1.2-contributor-free",
        ]),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8000);
    });
    const harness = new Harness(child);
    try {
      await harness.waitUntil(() =>
        harness.frames.find(
          (frame) =>
            (frame as { method?: string; params?: { phase?: string } }).method ===
              "startup/storageState" &&
            (frame as { params?: { phase?: string } }).params?.phase === "ready",
        ),
      );

      // 1. 本地命令：/rename 不触发模型轮，输出经 command_output 投影并经 session_info_update 回投标题。
      const createResult = (await harness.request("v4/command", {
        commandId: "real-local-create",
        clientId: "e2e-client",
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: "real-e2e-workspace-2",
          firstInput: { text: "/rename omp-e2e-local-title" },
        },
        issuedAt: Date.now(),
      })) as { result: unknown };
      const createAck = commandAckSchema.parse(createResult.result);
      assert.equal(
        createAck.status,
        "accepted",
        `createSession: ${JSON.stringify(createAck)}\n${stderrTail}`,
      );
      const sessionId = (createAck.result as { sessionId: string }).sessionId;
      await harness.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: "real-conn-2",
        clientMode: "desktop-continuous",
      });
      await harness.waitUntil(() =>
        [...harness.rows().values()].some(
          (row) => row.kind === "turnHeader" && row.state === "completedSuccess",
        ),
      );
      await harness.waitUntil(() =>
        (harness.state().meta as { title?: string } | undefined)?.title === "omp-e2e-local-title"
          ? true
          : undefined,
      );
      assert.ok(
        [...harness.rows().values()].some(
          (row) => row.kind === "assistantText" && String(row.text ?? "").trim().length > 0,
        ),
        `本地命令缺少输出投影\n${stderrTail}`,
      );

      // 2. 临时模型：sendText 携带 modelSelection 从 muse-spark 切到 glm-5.3-flash（会话级，不写 omp 配置）。
      const sendResult = (await harness.request("v4/command", {
        commandId: "real-model-send",
        clientId: "e2e-client",
        sessionId,
        type: "sendText",
        payload: {
          text: "只回复两个字：好的",
          modelSelection: {
            providerId: "zhipu-coding-plan",
            modelId: "glm-5.3-flash",
            options: { reasoningLevel: "max" },
          },
        },
        issuedAt: Date.now(),
      })) as { result: unknown };
      assert.equal(commandAckSchema.parse(sendResult.result).status, "accepted");
      await harness.waitUntil(() => {
        const rows = [...harness.rows().values()];
        const header = rows.filter((row) => row.kind === "turnHeader");
        return header.length >= 2 && header[header.length - 1]!.state === "completedSuccess"
          ? true
          : undefined;
      });
      const rows = [...harness.rows().values()];
      const marker = rows.find(
        (row) =>
          row.kind === "timelineMarker" &&
          (row as { marker?: { type?: string } }).marker?.type === "modelChange",
      ) as { marker?: { toProvider?: string; toModel?: string } } | undefined;
      assert.ok(marker, `缺少 modelChange 标记\n${stderrTail}`);
      assert.equal(marker!.marker!.toProvider, "zhipu-coding-plan");
      assert.equal(marker!.marker!.toModel, "glm-5.3-flash");
      assert.equal(
        (harness.state().config as { model?: string } | undefined)?.model,
        "glm-5.3-flash",
      );
      const lastTurnText = rows
        .filter((row) => row.kind === "assistantText")
        .reduce((total, row) => total + String(row.text ?? "").length, 0);
      assert.ok(lastTurnText > 0, `glm-5.3-flash 无流式输出\n${stderrTail}`);

      // 3. omp 原生 /model 本地命令：config_update 回投会话模型状态（不写 omp 配置文件）。
      const modelCmd = (await harness.request("v4/command", {
        commandId: "real-model-cmd",
        clientId: "e2e-client",
        sessionId,
        type: "sendText",
        payload: { text: "/model opencode-zen/muse-spark-1.2-contributor-free:medium" },
        issuedAt: Date.now(),
      })) as { result: unknown };
      assert.equal(commandAckSchema.parse(modelCmd.result).status, "accepted");
      await harness.waitUntil(() =>
        (harness.state().config as { model?: string } | undefined)?.model ===
        "muse-spark-1.2-contributor-free"
          ? true
          : undefined,
      );
      await harness.waitUntil(() =>
        [...harness.rows().values()].some(
          (row) => row.kind === "assistantText" && /Model set to/.test(String(row.text ?? "")),
        ),
      );
    } finally {
      child.kill();
      await new Promise((done) => setTimeout(done, 300));
    }
  },
);
