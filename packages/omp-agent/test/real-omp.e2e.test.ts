// 真实 omp release 二进制 E2E（换核验收）：驱动「内嵌 omp.exe → omp-agent 适配器 →
// ZCode v4 协议」全链路。
// 默认模型按 FORK.md 测试约定使用 zhipu-coding-plan/glm-5.3-flash；
// OMP_E2E_MODEL_SELECTOR 可为专项验收选择用户 omp 目录中的其他模型。
// （走用户 omp 既有凭据，行为与日常 omp 一致）；
// 审批模式用运行时 flag --approval-mode always-ask（不持久化，不改用户配置）；
// 工作区为沙箱目录，不触碰用户文件。
// 测试使用独立临时 OMP 根；只把本机既有 GLM 凭据放入子进程环境，不写密钥到磁盘。
// 本机没有安装核时跳过，门禁将跳过视为未验证。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { realOmpCredential } from "./fixtures/realOmpCredential.mjs";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { zcodeUserInputRequestParamsSchema } from "@zcode/shared";
import { z } from "zod";
import { commandAckSchema, pendingInteractionSchema } from "@zcode/shared/zcode-protocol-v4";

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
// 默认不依赖 commandcode 免费模型（每日配额耗尽后 429 会污染验收结果）。
const modelSelector = process.env.OMP_E2E_MODEL_SELECTOR ?? "zhipu-coding-plan/glm-5.3-flash";
const modelSeparator = modelSelector.indexOf("/");
if (modelSeparator <= 0 || modelSeparator === modelSelector.length - 1) {
  throw new Error("OMP_E2E_MODEL_SELECTOR must be provider/model");
}
const modelProvider = modelSelector.slice(0, modelSeparator);
const modelId = modelSelector.slice(modelSeparator + 1);
const ompModelArgs = ["--provider", modelProvider, "--model", modelId];

const hasRealBinary = process.env.OMP_AGENT_SKIP_REAL_E2E !== "1" && existsSync(ompBinary);

class Harness {
  readonly frames: unknown[] = [];
  private nextId = 1;
  constructor(private child: ChildProcessWithoutNullStreams) {
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
  `真实 omp 二进制 + ${modelSelector}：流式 → write 工具 → 审批 → 文件落盘 → 完成`,
  { skip: hasRealBinary ? false : "内嵌 omp 二进制未下载（跳过真实 E2E）" },
  async () => {
    const credentials = await realOmpCredential(ompBinary);
    const root = await mkdtemp(join(tmpdir(), "zcode-real-e2e-"));
    const sandbox = join(root, "workspace");
    const configRoot = join(root, "omp");
    await Promise.all([mkdir(sandbox), mkdir(join(configRoot, "agent"), { recursive: true })]);
    const targetFile = join(sandbox, "greeting-real.txt");

    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, adapterEntry, "app-server", "--stdio"],
      {
        cwd: sandbox,
        env: {
          ...process.env,
          ...credentials,
          OMP_CONFIG_ROOT: configRoot,
          OMP_PROFILE: "",
          PI_PROFILE: "",
          PI_CONFIG_DIR: "",
          PI_CODING_AGENT_DIR: "",
          ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace",
          OMP_RPC_BINARY_PATH: ompBinary,
          // 附加 omp 启动参数：选择验收模型；审批走运行时 flag，不写用户配置。
          OMP_RPC_ARGS_JSON: JSON.stringify([
            ...ompModelArgs,
            "--thinking",
            "low",
            "--approval-mode",
            "always-ask",
          ]),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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

      const createResult = (await harness.request("v4/command", {
        commandId: "real-create-1",
        clientId: "e2e-client",
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: "real-e2e-workspace",
          firstInput: {
            text: "请用 write 工具创建文件 greeting-real.txt，内容为一行：real omp wrote this。工具执行成功后只回复 REAL_OMP_WRITE_DONE。",
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

      // OMP 的 write 模式自动放行工作区写入；验证 write 审批必须用 always-ask。
      // 模型直接结束而没有调用工具时必须失败，不能把文本答复算作工具验收。
      await harness.waitUntil(() => {
        const hasInteraction = harness.frames.some(
          (frame) =>
            frame !== null &&
            typeof frame === "object" &&
            "method" in frame &&
            frame.method === "interaction/requestUserInput",
        );
        const turnDone = [...harness.rows().values()].some(
          (row) =>
            row.kind === "turnHeader" &&
            (row.state === "completedSuccess" ||
              row.state === "completedInterrupted" ||
              row.state === "failed"),
        );
        return hasInteraction || turnDone;
      });
      const interaction = harness.frames.find(
        (frame) =>
          frame !== null &&
          typeof frame === "object" &&
          "method" in frame &&
          frame.method === "interaction/requestUserInput",
      );
      assert.ok(
        interaction &&
          typeof interaction === "object" &&
          "id" in interaction &&
          typeof interaction.id === "string" &&
          "params" in interaction,
        `write 必须经过真实审批\n${stderrTail}`,
      );
      const params = zcodeUserInputRequestParamsSchema.parse(interaction.params);
      const { options } = z
        .object({
          options: z.array(z.object({ optionId: z.string(), label: z.string() })),
        })
        .parse(params.input);
      const approve = options.find((option) => option.optionId === "Approve");
      assert.ok(approve, "真实核必须提供允许一次写入的选项");
      const card = pendingInteractionSchema.parse(
        await harness.waitUntil(() =>
          pendingInteractionSchema
            .array()
            .parse(harness.state().pendingInteractions ?? [])
            .find((item) => item.interactionId === params.requestId),
        ),
      );
      assert.ok(card.payload.kind === "userInput", "审批必须投影为可操作交互卡");
      assert.deepEqual(card.payload.options, options, "投影卡须保留真实审批选项");
      // stdio 的选择应答位于 content.optionId；value 是自由文本，不能冒充选项。
      harness.respond(interaction.id, {
        action: "accept",
        content: { optionId: approve.optionId },
      });

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

      // 必须同时证明流式输出、成功工具结果、精确文件内容与成功终态。
      const rows = [...harness.rows().values()];
      const toolRow = rows.find((row) => row.kind === "toolCall" && row.toolName === "write");
      const headerRow = rows.find((row) => row.kind === "turnHeader");
      const assistantText = rows
        .filter((row) => row.kind === "assistantText")
        .map((row) => String(row.text ?? ""))
        .join("");
      assert.equal(headerRow?.state, "completedSuccess", `真实轮次必须成功完成\n${stderrTail}`);
      assert.match(
        assistantText,
        /REAL_OMP_WRITE_DONE/u,
        `缺少真实成功确认的流式文本\n${stderrTail}`,
      );
      assert.equal(
        toolRow?.status,
        "success",
        `write 工具未成功: ${JSON.stringify(toolRow)}\n${stderrTail}`,
      );
      assert.equal((await readFile(targetFile, "utf8")).trim(), "real omp wrote this");
      console.log("[real-e2e] 成功流式输出、审批通过、write 成功且文件内容精确匹配");
    } finally {
      // taskkill 返回不代表原生 SQLite 句柄已释放；走真实 EOF dispose，等待 adapter 及核退出后删沙箱。
      if (child.exitCode === null) {
        const closed = once(child, "close");
        child.stdin.end();
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
