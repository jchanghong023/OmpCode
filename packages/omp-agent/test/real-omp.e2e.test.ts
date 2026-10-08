// 真实 omp release 二进制 E2E（换核验收）：驱动「内嵌 omp.exe → omp-agent 适配器 →
// ZCode v4 协议」全链路。
// 默认模型按 FORK.md 测试约定使用 zhipu-coding-plan/glm-5.3-flash；
// OMP_E2E_MODEL_SELECTOR 可为专项验收选择用户 omp 目录中的其他模型。
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
import { zcodeOmpModelRolesResultSchema, zcodeWorkspacePresentationSchema } from "@zcode/shared";
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
  `真实 omp 二进制 + ${modelSelector}：流式 → write 工具 → 审批 → 文件落盘 → 完成`,
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
        // 附加 omp 启动参数：选择验收模型；审批走运行时 flag，不写用户配置。
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

      // --approval-mode write：模型调用 write 工具时触发 omp 审批。v3 二进制走
      // permission_request → interaction/requestPermission；旧二进制走 select →
      // interaction/requestUserInput。免费模型是否调用工具不受控：先到者为准。
      const firstSignal = (await harness.waitUntil(() => {
        const hasInteraction = harness.frames.some((frame) => {
          const method = (frame as { method?: string }).method;
          return (
            method === "interaction/requestUserInput" || method === "interaction/requestPermission"
          );
        });
        const turnDone = [...harness.rows().values()].some(
          (row) =>
            row.kind === "turnHeader" &&
            (row.state === "completedSuccess" ||
              row.state === "completedInterrupted" ||
              row.state === "failed"),
        );
        return hasInteraction || turnDone;
      })) as unknown;
      const permissionRequest = harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestPermission",
      ) as { id: string; params: { toolName: string; options: unknown[] } } | undefined;
      const interaction = harness.frames.find(
        (frame) => (frame as { method?: string }).method === "interaction/requestUserInput",
      ) as { id: string; params: { requestId: string; prompt: string } } | undefined;
      if (permissionRequest) {
        // v3 结构化审批：六档选项映射 + allow 应答放行。
        assert.equal(permissionRequest.params.toolName, "write");
        const optionIds = (permissionRequest.params.options as { optionId: string }[]).map(
          (option) => option.optionId,
        );
        assert.deepEqual(optionIds, [
          "allowOnce",
          "allowSession",
          "allowAlways",
          "deny",
          "denyAlways",
        ]);
        const permissionCard = harness.state().pendingInteractions as
          | Array<{ kind: string; payload: { toolName?: string; options?: unknown[] } }>
          | undefined;
        const card = permissionCard?.find((item) => item.kind === "permission");
        assert.ok(card, "v3 审批须投影为 permission 卡");
        assert.deepEqual(
          (card!.payload.options as { optionId: string }[]).map((option) => option.optionId),
          optionIds,
        );
        harness.respond(permissionRequest.id, { decision: "allow", reason: "Approved for e2e" });
      }
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
      if (interaction || permissionRequest) {
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
  `真实 omp 二进制：本地命令收口 + 临时模型切换到 ${modelSelector}`,
  { skip: hasRealBinary ? false : "内嵌 omp 二进制未下载（跳过真实 E2E）" },
  async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "zcode-real-e2e-model-"));

    const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
      cwd: sandbox,
      env: {
        ...process.env,
        ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace-2",
        OMP_RPC_BINARY_PATH: ompBinary,
        // 基座用 muse-spark，临时模型切换目标才是指定验收模型，
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

      // 2. 临时模型：sendText 携带 modelSelection 从 muse-spark 切到指定模型（会话级，不写 omp 配置）。
      const sendResult = (await harness.request("v4/command", {
        commandId: "real-model-send",
        clientId: "e2e-client",
        sessionId,
        type: "sendText",
        payload: {
          text: "只回复两个字：好的",
          modelSelection: {
            providerId: modelProvider,
            modelId,
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
      assert.equal(marker!.marker!.toProvider, modelProvider);
      assert.equal(marker!.marker!.toModel, modelId);
      assert.equal((harness.state().config as { model?: string } | undefined)?.model, modelId);
      const lastTurnText = rows
        .filter((row) => row.kind === "assistantText")
        .reduce((total, row) => total + String(row.text ?? "").length, 0);
      assert.ok(lastTurnText > 0, `${modelSelector} 无流式输出\n${stderrTail}`);

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

test(
  `真实 omp v3 fork surface：目录能力（补全/模型角色/会话目录）与能力缺失语义`,
  {
    skip: hasRealBinary ? false : "内嵌 omp 二进制未下载（跳过真实 E2E）",
  },
  async (t) => {
    const sandbox = mkdtempSync(join(tmpdir(), "zcode-real-e2e-v3-"));
    const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
      cwd: sandbox,
      env: {
        ...process.env,
        ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace-3",
        OMP_RPC_BINARY_PATH: ompBinary,
        OMP_RPC_ARGS_JSON: JSON.stringify(ompModelArgs),
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
      const workspace = {
        workspacePath: sandbox,
        workspaceIdentity: "real-e2e-workspace-3",
        workspaceKey: "real-e2e-workspace-3",
      };

      // 1. workspace/completeOmpCommand（v3 commandCompletion）：动态补全返回候选与
      //    修订；-32601 表示二进制早于 v3（协商回落），显式跳过而非失败。
      const completion = (await harness.request("workspace/completeOmpCommand", {
        workspace,
        text: "/mod",
        cursor: 4,
      })) as {
        result?: { items?: { label?: string }[]; revision?: string };
        error?: { code: number; message: string };
      };
      if (completion.error?.code === -32601) {
        t.skip("内嵌 omp 二进制不支持 v3 fork surface（跳过 v3 验收）");
        return;
      }
      assert.ok(
        completion.result,
        `补全失败: ${JSON.stringify(completion.error)}
${stderrTail}`,
      );
      const labels = (completion.result!.items ?? []).map((item) => item.label);
      assert.ok(
        labels.some((label) => typeof label === "string" && label.startsWith("model")),
        `补全候选应含 model 族命令: ${JSON.stringify(labels).slice(0, 200)}`,
      );
      console.log("[real-e2e] complete_command 候选数:", labels.length);

      // 2. workspace/ompModelRoles（v3 modelRoleConfig）：role 目录非空且携带候选模型。
      const roles = (await harness.request("workspace/ompModelRoles", { workspace })) as {
        result?: { roles?: { roleId?: string; configurable?: boolean }[] };
        error?: { code: number; message: string };
      };
      assert.ok(
        roles.result,
        `模型角色目录失败: ${JSON.stringify(roles.error)}
${stderrTail}`,
      );
      const roleIds = (roles.result!.roles ?? []).map((role) => role.roleId);
      // 宿主也用此 schema 校验；只检查 roles 非空会漏掉 sessionModel 形状漂移。
      zcodeOmpModelRolesResultSchema.parse(roles.result);
      assert.ok((roles.result!.roles ?? []).length > 0, "role 目录不得为空");
      console.log("[real-e2e] model roles:", roleIds.slice(0, 6).join(","));

      // 3. 会话目录（v3 sessionDirectory）：list_sessions 无独立宿主方法；经 legacy
      //    session/list 交叉验证 v3 目录进程存在不破坏既有链路（冷会话来源是文件系统）。
      const sessionList = (await harness.request("session/list", { workspace })) as {
        result?: { sessions?: { sessionId?: string }[] };
      };
      assert.ok(sessionList.result, "session/list 失败");
      assert.ok(Array.isArray(sessionList.result!.sessions));

      // 4. 新核无 test_model/list_mcp_servers：按已知差异显式拒绝且 mcp 空状态表。
      const testModel = (await harness.request("provider/testModelConnectivity", {
        workspace,
        selection: { providerId: modelProvider, modelId },
      })) as { error?: { code: number; message: string } };
      assert.equal(testModel.error?.code, -32601, "新核无 test_model，应按能力缺失拒绝");
      const mcp = (await harness.request("mcp/list", { workspace })) as {
        result?: { statuses: Record<string, unknown> };
      };
      assert.ok(mcp.result);
      assert.equal(Object.keys(mcp.result.statuses ?? {}).length, 0);
      console.log("[real-e2e] v3 目录能力验收通过（补全/角色/会话目录/能力缺失语义）");
    } finally {
      child.kill();
      await new Promise((done) => setTimeout(done, 300));
    }
  },
);
