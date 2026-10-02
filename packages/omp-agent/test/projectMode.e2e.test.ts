// 项目模式 E2E（omp-project-mode.md / rpc-ui-protocol §11.2）：真实拉起 omp-agent 子进程
// 与 fake OMP 项目核心（--mode rpc-ui --rpc-project），验证「单项目进程多会话、事件按
// sessionId 路由、execute_command 严格分发、complete_command 补全、子代理只读详情与控制、
// 模型双入口、删除与 EOF」的协议链路。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { commandAckSchema } from "@zcode/shared/zcode-protocol-v4";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapterEntry = join(packageRoot, "src", "adapters", "cliMain.ts");
const fakeOmpPath = join(packageRoot, "test", "fixtures", "fakeOmpProject.mjs");
const tsxCliPath = join(
  dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
  "dist",
  "cli.mjs",
);

interface WireFrame {
  topic: string;
  payload: {
    kind: "snapshot" | "deltas";
    snapshot?: {
      rows?: { window?: unknown[] };
      sessions?: { sessionId: string }[];
      subagents?: unknown;
    };
    deltas?: unknown[];
  };
}

class AdapterHarness {
  readonly frames: unknown[] = [];
  private nextRequestId = 100;
  private readonly child: ReturnType<typeof spawn>;
  readonly exited: Promise<number | null>;

  constructor(child: ReturnType<typeof spawn>) {
    this.child = child;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      if (line.trim().length === 0) return;
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
      this.waitUntil(() =>
        this.frames.find(
          (frame) =>
            (frame as { id?: number }).id === id &&
            ("result" in (frame as object) || "error" in (frame as object)),
        ),
      )
        .then(resolveRequest)
        .catch(rejectRequest);
    });
  }

  endStdin(): void {
    this.child.stdin.end();
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

  topicFrames(topic: string): WireFrame[] {
    return this.frames
      .filter(
        (frame): frame is { method: string; params: { frame?: WireFrame } & WireFrame } =>
          typeof frame === "object" &&
          frame !== null &&
          (frame as { method?: string }).method === "v4/conversation/frame" &&
          ((frame as { params?: { frame?: WireFrame } }).params?.frame?.topic ??
            (frame as { params?: WireFrame }).params?.topic) === topic,
      )
      .map((frame) => frame.params.frame ?? (frame.params as WireFrame));
  }

  collectRows(topic: string): Map<number, Record<string, unknown>> {
    const rows = new Map<number, Record<string, unknown>>();
    for (const frame of this.topicFrames(topic)) {
      if (frame.payload.kind === "snapshot") {
        for (const row of (frame.payload.snapshot?.rows?.window ?? []) as Record<
          string,
          unknown
        >[]) {
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

  collectState(topic: string): Record<string, unknown> {
    let state: Record<string, unknown> = {};
    for (const frame of this.topicFrames(topic)) {
      if (frame.payload.kind === "snapshot") {
        state = { ...((frame.payload.snapshot ?? {}) as Record<string, unknown>) };
      } else if (frame.payload.kind === "deltas") {
        for (const delta of frame.payload.deltas as { op?: string; patch?: unknown }[]) {
          if (delta.op === "state.updated" && delta.patch && typeof delta.patch === "object") {
            state = { ...state, ...(delta.patch as Record<string, unknown>) };
          }
        }
      }
    }
    return state;
  }

  indexDeltas(): { op: string; sessionId?: string }[] {
    return this.frames
      .filter(
        (frame): frame is { method: string; params: { frame?: WireFrame } & WireFrame } =>
          typeof frame === "object" &&
          (frame as { method?: string }).method === "v4/conversation/frame",
      )
      .map((frame) => frame.params.frame ?? (frame.params as WireFrame))
      .filter((frame) => frame.topic.startsWith("sessions-index/"))
      .flatMap((frame) => (frame.payload.deltas ?? []) as { op: string; sessionId?: string }[]);
  }
}

const scratchRoot = mkdtempSync(join(tmpdir(), "omp-project-e2e-"));
process.on("exit", () => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface AdapterRun {
  harness: AdapterHarness;
  /** fake 项目核的进程标记文件：`start <pid>` / `exit <pid>` 行。 */
  markerPath: string;
}

async function startAdapter(extraEnv: Record<string, string> = {}): Promise<AdapterRun> {
  const runDir = mkdtempSync(join(scratchRoot, "run-"));
  const markerPath = join(runDir, "marker.log");
  const child = spawn(process.execPath, [tsxCliPath, adapterEntry, "app-server", "--stdio"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      OMP_RPC_BINARY_PATH: process.execPath,
      OMP_RPC_ARGS_JSON: JSON.stringify([fakeOmpPath]),
      ZCODE_WORKSPACE_IDENTITY: "test-workspace",
      PI_CONFIG_DIR: join(packageRoot, ".test-omp-home"),
      FAKE_OMP_MARKER: markerPath,
      FAKE_OMP_SESSION_DIR: join(runDir, "sessions"),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const harness = new AdapterHarness(child);
  await harness.waitUntil(() =>
    harness.frames.find(
      (frame) =>
        (frame as { method?: string; params?: { phase?: string } }).method ===
          "startup/storageState" &&
        (frame as { params?: { phase?: string } }).params?.phase === "ready",
    ),
  );
  return { harness, markerPath };
}

function markerStarts(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("start")).length;
  } catch {
    return 0;
  }
}

async function createSession(
  harness: AdapterHarness,
  commandId: string,
  firstInput?: string,
): Promise<string> {
  const created = (await harness.request("v4/command", {
    commandId,
    clientId: "test-client",
    sessionId: null,
    type: "createSession",
    payload: {
      workspaceId: "test-workspace",
      ...(firstInput !== undefined ? { firstInput: { text: firstInput } } : {}),
    },
    issuedAt: Date.now(),
  })) as { result: unknown };
  const ack = commandAckSchema.parse(created.result);
  assert.equal(ack.status, "accepted", JSON.stringify(created));
  return (ack.result as { sessionId: string }).sessionId;
}

async function sendText(
  harness: AdapterHarness,
  sessionId: string,
  commandId: string,
  text: string,
): Promise<void> {
  const sent = (await harness.request("v4/command", {
    commandId,
    clientId: "test-client",
    sessionId,
    type: "sendText",
    payload: { text },
    issuedAt: Date.now(),
  })) as { result: unknown };
  const ack = commandAckSchema.parse(sent.result);
  assert.equal(ack.status, "accepted", JSON.stringify(sent));
}

function subscribe(harness: AdapterHarness, topic: string, connectionId: string): Promise<unknown> {
  return harness.request("v4/conversation/subscribe", {
    topic,
    connectionId,
    clientMode: "desktop-continuous",
  });
}

test("Z01: 三个会话共享一个 OMP 项目进程，事件按会话路由不串话", async () => {
  const { harness, markerPath } = await startAdapter();
  try {
    const first = await createSession(harness, "create-1", "hello one");
    const second = await createSession(harness, "create-2");
    const third = await createSession(harness, "create-3");
    assert.notEqual(first, second);
    assert.notEqual(second, third);
    await subscribe(harness, `conversation/${first}`, "z01-first");
    await subscribe(harness, `conversation/${second}`, "z01-second");
    await sendText(harness, second, "send-second", "only to second");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(`conversation/${second}`);
      return [...rows.values()].some((row) => JSON.stringify(row).includes("echo:only to second"));
    });
    const firstRows = harness.collectRows(`conversation/${first}`);
    assert.ok(
      ![...firstRows.values()].some((row) => JSON.stringify(row).includes("echo:only to second")),
      "第二个会话的输出不得出现在第一个会话",
    );
    // 会话数不与主进程数绑定：三个会话仍只有一个 OMP 项目进程。
    await harness.waitUntil(() => markerStarts(markerPath) >= 1);
    assert.equal(markerStarts(markerPath), 1, "三个会话必须共享同一个 OMP 项目进程");
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z08: 普通消息流式回答、工具过程与完成态", async () => {
  const { harness } = await startAdapter();
  try {
    const sessionId = await createSession(harness, "create-message", "hello world");
    const topic = `conversation/${sessionId}`;
    await subscribe(harness, topic, "z08");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(topic);
      return [...rows.values()].some((row) => JSON.stringify(row).includes("echo:hello world"));
    });
    const state = harness.collectState(topic);
    assert.equal(
      (state as { control?: { phase?: string } }).control?.phase,
      "completedSuccess",
      JSON.stringify(state.control),
    );
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z03/O32: 斜杠输入走 execute_command；未知命令报错不进模型", async () => {
  const { harness } = await startAdapter();
  try {
    const sessionId = await createSession(harness, "create-command");
    const topic = `conversation/${sessionId}`;
    await subscribe(harness, topic, "z03");
    await sendText(harness, sessionId, "send-help", "/help");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(topic);
      return [...rows.values()].some((row) =>
        JSON.stringify(row).includes("fake help: try /model"),
      );
    });
    // 修复（G12）：fake help 为本地命令（agentInvoked=false），输出可见后该轮次必须
    // 异步收口为 completedSuccess，不得永久挂起。
    await harness.waitUntil(() => {
      const state = harness.collectState(topic) as { control?: { phase?: string } };
      return state.control?.phase === "completedSuccess" ? state.control : undefined;
    }, 30000);
    await sendText(harness, sessionId, "send-unknown", "/definitely-not-a-command");
    await harness.waitUntil(() =>
      JSON.stringify(harness.collectState(topic)).includes("Unknown command"),
    );
    // 未知命令不得进入模型：没有 assistant 输出新增。
    const rows = harness.collectRows(topic);
    assert.ok(
      ![...rows.values()].some((row) =>
        JSON.stringify(row).includes("echo:/definitely-not-a-command"),
      ),
    );
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z03: complete_command 名称与参数级补全（经 workspace/completeOmpCommand）", async () => {
  const { harness } = await startAdapter();
  try {
    const byName = (await harness.request("workspace/completeOmpCommand", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      text: "/he",
      cursor: 3,
    })) as { result: { items: { label: string; kind?: string }[] } };
    assert.ok(
      byName.result.items.some((item) => item.label === "/help"),
      JSON.stringify(byName),
    );
    const byArgument = (await harness.request("workspace/completeOmpCommand", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      text: "/help ",
      cursor: 6,
    })) as { result: { items: { label: string; kind?: string }[] } };
    assert.ok(
      byArgument.result.items.some((item) => item.kind === "argument" && item.label === "commands"),
      JSON.stringify(byArgument),
    );
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z02: 技能目录来自项目进程命令目录（source=skill）", async () => {
  const { harness } = await startAdapter();
  try {
    const catalog = (await harness.request("skills/referenceCatalog", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
    })) as { result: { skills: { name: string; scope: string }[] } };
    assert.ok(
      catalog.result.skills.some((skill) => skill.name === "greet" && skill.scope === "omp"),
      JSON.stringify(catalog.result.skills),
    );
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z09/Z10/Z15: 子代理过程卡片、只读详情、目录与控制入口", async () => {
  const { harness } = await startAdapter();
  try {
    const sessionId = await createSession(harness, "create-subagent", "spawn subagent please");
    const topic = `conversation/${sessionId}`;
    await subscribe(harness, topic, "z09");
    await harness.waitUntil(() => {
      const state = harness.collectState(topic);
      const subagents = (state as { subagents?: { childSessionIds?: string[] } }).subagents;
      return Array.isArray(subagents?.childSessionIds) && subagents.childSessionIds.length > 0;
    });
    const state = harness.collectState(topic);
    const viewId = ((state as { subagents?: { childSessionIds?: string[] } }).subagents
      ?.childSessionIds ?? [])[0];
    assert.match(viewId, /^omp-subagent:sa-1@/);
    // 只读详情：合成地址可订阅，内容来自 get_subagent_messages 记录。
    await subscribe(harness, `conversation/${viewId}`, "z09-view");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(`conversation/${viewId}`);
      return [...rows.values()].some((row) => JSON.stringify(row).includes("scanned 3 files"));
    });
    // 已结束目录：OMP 持久目录条目同样使用合成地址。
    const directory = (await harness.request("session/subagents", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      sessionId,
    })) as { result: { ended: { items: { childSessionId: string }[] } } };
    assert.ok(
      directory.result.ended.items.some(
        (item) => item.childSessionId === `omp-subagent:sa-done@${sessionId}`,
      ),
      JSON.stringify(directory.result.ended),
    );
    // 控制入口（Z15）：send_message / stop 返回真实状态。
    const control = (await harness.request("session/controlSubagent", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      sessionId,
      subagentId: "sa-1",
      action: "stop",
    })) as { result: { status: string } };
    assert.equal(control.result.status, "stopped");
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z09b: 子代理只读详情实时增长——subagent_event 触发重读合并且不产生重复行", async () => {
  const { harness } = await startAdapter();
  try {
    const sessionId = await createSession(harness, "create-sub-live", "spawn subagent please");
    const topic = `conversation/${sessionId}`;
    await subscribe(harness, topic, "z09b");
    await harness.waitUntil(() => {
      const state = harness.collectState(topic);
      const subagents = (state as { subagents?: { childSessionIds?: string[] } }).subagents;
      return Array.isArray(subagents?.childSessionIds) && subagents.childSessionIds.length > 0;
    });
    const viewId = ((harness.collectState(topic) as { subagents?: { childSessionIds?: string[] } })
      .subagents?.childSessionIds ?? [])[0];
    const viewTopic = `conversation/${viewId}`;
    await subscribe(harness, viewTopic, "z09b-view");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(viewTopic);
      return [...rows.values()].some((row) => JSON.stringify(row).includes("scanned 3 files"));
    });
    const before = harness.collectRows(viewTopic);
    assert.equal(before.size, 2, `首轮水合应恰 2 行：${JSON.stringify([...before.values()])}`);
    // 第二轮 spawn（同一 subagentId）：fake 在记录中追加尾条目并重发 subagent_event；
    // 详情视图必须经重读合并实时增长，且旧行内容与 row.appended 次数保持不变。
    await sendText(harness, sessionId, "spawn-again", "spawn subagent please");
    await harness.waitUntil(() => {
      const rows = harness.collectRows(viewTopic);
      return (
        rows.size >= 3 &&
        [...rows.values()].some((row) =>
          String(row.text ?? "").includes("scanned 3 files in run 2"),
        )
      );
    });
    const after = harness.collectRows(viewTopic);
    assert.equal(
      after.size,
      3,
      `增长后应恰 3 个不同 rowId：${JSON.stringify([...after.values()])}`,
    );
    assert.deepEqual(after.get(1), before.get(1), "旧行 1 内容不得变化");
    assert.deepEqual(after.get(2), before.get(2), "旧行 2 内容不得变化");
    // 不重复：无论增量还是恢复快照承载（事件转发的 state op 与合并同批 conflat 时协议
    // 会对水位缺口回整快照，属既有语义），每帧行窗口内 rowId 均不得重复，行 3 恰出现一次。
    const windowDuplicateRows: number[] = [];
    const row3Deliveries: string[] = [];
    for (const frame of harness.topicFrames(viewTopic)) {
      if (frame.payload.kind === "snapshot") {
        const window = (frame.payload.snapshot?.rows?.window ?? []) as { rowId: number }[];
        const seen = new Set<number>();
        for (const row of window) {
          if (seen.has(row.rowId)) windowDuplicateRows.push(row.rowId);
          seen.add(row.rowId);
          if (row.rowId === 3)
            row3Deliveries.push(`snapshot@${frame.payload.snapshot?.seq ?? "?"}`);
        }
      } else {
        for (const delta of frame.payload.deltas as { op?: string; row?: { rowId?: number } }[]) {
          if (delta.op === "row.appended" && delta.row?.rowId === 3) {
            row3Deliveries.push(`appended@${delta.row.rowId}`);
          }
        }
      }
    }
    assert.deepEqual(windowDuplicateRows, [], "快照行窗口不得出现重复 rowId");
    assert.equal(
      row3Deliveries.length,
      1,
      `新行 3 应恰投递一次：${JSON.stringify(row3Deliveries)}`,
    );
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z11/Z12/Z13: 临时切模型按会话隔离；role 目录与逐 role 持久保存", async () => {
  const { harness } = await startAdapter();
  try {
    const first = await createSession(harness, "create-model-a", "warm first");
    const second = await createSession(harness, "create-model-b", "warm second");
    const firstTopic = `conversation/${first}`;
    const secondTopic = `conversation/${second}`;
    await subscribe(harness, firstTopic, "z11-a");
    await subscribe(harness, secondTopic, "z11-b");
    // 会话 A 临时切到 fake-pro；会话 B 保持默认。
    // switchModelConfig 是 CAS 命令：baseRevision 取当前会话投影修订。
    const baseRevision = Number(harness.collectState(firstTopic).revision ?? 0);
    const switched = (await harness.request("v4/command", {
      commandId: "switch-model-a",
      clientId: "test-client",
      sessionId: first,
      type: "switchModelConfig",
      baseRevision,
      payload: { provider: "fake", model: "fake-pro", thought: "low" },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const ack = commandAckSchema.parse(switched.result);
    assert.equal(ack.status, "accepted", JSON.stringify(switched));
    await harness.waitUntil(() => {
      const state = harness.collectState(firstTopic);
      return (state as { config?: { model?: string } }).config?.model === "fake-pro";
    });
    const secondState = harness.collectState(secondTopic);
    assert.equal((secondState as { config?: { model?: string } }).config?.model, "fake-model");
    // role 目录：全部 role（含未配置 smol）与逐 role 保存。
    const roles = (await harness.request("workspace/ompModelRoles", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
    })) as { result: { roles: { roleId: string; unresolvedReason?: string }[] } };
    const roleIds = roles.result.roles.map((role) => role.roleId);
    assert.ok(roleIds.includes("default") && roleIds.includes("smol"), JSON.stringify(roleIds));
    assert.ok(roles.result.roles.some((role) => role.roleId === "smol" && role.unresolvedReason));
    const saved = (await harness.request("workspace/ompSetModelRole", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      roleId: "default",
      scope: "user",
      selection: { kind: "model", model: { provider: "fake", modelId: "fake-pro" } },
    })) as { result: { persisted: boolean; role: { explicitValue?: string } } };
    assert.equal(saved.result.persisted, true);
    assert.equal(saved.result.role.explicitValue, "fake/fake-pro");
  } finally {
    harness.endStdin();
    await harness.exited;
  }
});

test("Z05: 删除会话反映到 sessions-index；draft 不进索引；EOF 有序退出", async () => {
  const { harness } = await startAdapter();
  try {
    // draft（无 firstInput 的预热会话）不得进入 sessions-index：上游 isDraftSession
    // 网关过滤的换核等价实现。漏进索引会让宿主 task-index 留下「New session」幽灵行。
    // 先建订阅再建 draft，泄漏才会以 session.upserted delta 暴露给观察者。
    await harness.request("v4/conversation/subscribe", {
      topic: "sessions-index/test-workspace",
      connectionId: "z05-index",
      clientMode: "desktop-continuous",
    });
    const draftId = await createSession(harness, "create-draft");
    await new Promise((sleep) => setTimeout(sleep, 150));
    const upsertedIds = () =>
      harness
        .indexDeltas()
        .map((delta) =>
          delta.op === "session.upserted"
            ? (delta as { session?: { sessionId?: string } }).session?.sessionId
            : delta.sessionId,
        )
        .filter((id): id is string => typeof id === "string");
    const draftUpserts = upsertedIds().filter((sessionId) => sessionId === draftId);
    assert.equal(draftUpserts.length, 0, "draft 会话不得出现在 sessions-index");

    // 首发提升后（draft→running）才可入索引；删除反映为 session.removed。
    await sendText(harness, draftId, "promote-draft", "hello draft");
    await harness.waitUntil(() => upsertedIds().includes(draftId));
    const removed = (await harness.request("v4/command", {
      commandId: "delete-session",
      clientId: "test-client",
      sessionId: draftId,
      type: "deleteSession",
      payload: {},
      issuedAt: Date.now(),
    })) as { result: unknown };
    const ack = commandAckSchema.parse(removed.result);
    assert.equal(ack.status, "accepted", JSON.stringify(removed));
    await harness.waitUntil(() =>
      harness
        .indexDeltas()
        .some((delta) => delta.op === "session.removed" && delta.sessionId === draftId),
    );

    // legacy session/list 同样不得泄漏 draft。
    const listed = (await harness.request("session/list", {})) as {
      result?: { sessions?: { sessionId: string }[] };
    };
    const legacyIds = listed.result?.sessions?.map((session) => session.sessionId) ?? [];
    assert.ok(!legacyIds.includes(draftId), "draft 会话不得出现在 legacy session/list");
  } finally {
    harness.endStdin();
    const code = await harness.exited;
    assert.ok(code === 0 || code === null, `adapter exit code ${code}`);
  }
});

test("项目模式拒绝预热创建（create_session 立即落盘）；旧拓扑预热照常接受", async () => {
  // (a) 项目模式：draftPrewarm 标记的 createSession 被拒绝，不产生 omp 会话。
  const { harness, markerPath } = await startAdapter();
  try {
    const rejected = (await harness.request("v4/command", {
      commandId: "create-prewarm",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", draftPrewarm: true },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const ack = commandAckSchema.parse(rejected.result);
    assert.equal(ack.status, "rejected", JSON.stringify(rejected));
    assert.equal(ack.reasonCode, "fault.command.draftPrewarmUnsupportedByOmpCore");
    // 携带 firstInput 的真实创建不受影响。
    const realId = await createSession(harness, "create-real", "hello after prewarm reject");
    assert.ok(realId);
  } finally {
    harness.endStdin();
    await harness.exited;
  }
  // (b) 旧核（无项目模式）：惰性进程保证 draft 不落盘，预热创建照常接受。
  const legacy = await startAdapter({ FAKE_OMP_NO_PROJECT_MODE: "1" });
  try {
    const accepted = (await legacy.harness.request("v4/command", {
      commandId: "create-prewarm-legacy",
      clientId: "test-client",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "test-workspace", draftPrewarm: true },
      issuedAt: Date.now(),
    })) as { result: unknown };
    const ack = commandAckSchema.parse(accepted.result);
    assert.equal(ack.status, "accepted", JSON.stringify(accepted));
  } finally {
    legacy.harness.endStdin();
    await legacy.harness.exited;
  }
  assert.ok(markerPath);
});

test("项目方法错误语义：旧核 -32601 永久缺失；进程启动失败 -32000 可重试", async () => {
  // (a) 旧核（ready 无 rpc-ui-project）：能力永久缺失，按 -32601 报错，不伪造结果。
  const oldCore = await startAdapter({ FAKE_OMP_NO_PROJECT_MODE: "1" });
  try {
    const unsupported = (await oldCore.harness.request("workspace/completeOmpCommand", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      text: "/he",
      cursor: 3,
    })) as { error?: { code: number; message: string } };
    assert.ok(unsupported.error, JSON.stringify(unsupported));
    assert.equal(unsupported.error.code, -32601);
    assert.match(unsupported.error.message, /not supported by omp core/);
  } finally {
    oldCore.harness.endStdin();
    await oldCore.harness.exited;
  }

  // (b) 二进制缺失（spawn 失败）：与旧核不同，这是暂时不可用——按 -32000 报可重试
  // 错误且不打崩适配器；退避窗口内重复调用同样快速失败，不反复拉起进程。
  const broken = await startAdapter({
    OMP_RPC_BINARY_PATH: join(scratchRoot, "missing-omp-binary.exe"),
  });
  try {
    const transient = (await broken.harness.request("workspace/completeOmpCommand", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
      text: "/he",
      cursor: 3,
    })) as { error?: { code: number; message: string } };
    assert.ok(transient.error, JSON.stringify(transient));
    assert.equal(transient.error.code, -32000);
    assert.match(transient.error.message, /omp project process unavailable/);
    const again = (await broken.harness.request("workspace/ompModelRoles", {
      workspace: { workspacePath: packageRoot, workspaceKey: "test-workspace" },
    })) as { error?: { code: number; message: string } };
    assert.ok(again.error, JSON.stringify(again));
    assert.equal(again.error.code, -32000);
    assert.match(again.error.message, /omp project process unavailable/);
  } finally {
    broken.harness.endStdin();
    const code = await broken.harness.exited;
    assert.ok(code === 0 || code === null, `adapter exit code ${code}`);
  }
});
