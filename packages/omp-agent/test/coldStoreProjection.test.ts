// 冷存储投影 store 级 UT（S7-3 / S1-3）：
// - 崩溃中断收尾（S7-3，§8.2/§15.2(5)）：无落盘 toolResult 的 toolCall 行收尾为
//   cancelled（不得据无进度推断成功）；session_exit.pendingToolCalls（omp
//   exit-diagnostics.ts teardown 写入）并入中断集合；有结果的行按 isError 收尾。
// - sessionsRoot XDG 规则（S1-3，omp DirResolver dirs.ts）：linux/darwin 且
//   $XDG_DATA_HOME/omp（命名 profile 为 $XDG_DATA_HOME/omp/profiles/<p>）锚点存在时
//   data 根改指锚点并扁平化 agent/ 前缀；锚点不存在回退 ~/.omp 布局；win32 不参与。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { createOmpStore, ompSessionsRoot } from "../src/adapters/ompStore.js";
import {
  rowsFromOmpEntries,
  titleFromOmpEntries,
  transcriptFromOmpEntries,
} from "../src/domain/coldHistory.js";

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

const SESSION_ID = "cold-projection";
const FILE_NAME = `2026-09-24T00-00-00-000Z_${SESSION_ID}.jsonl`;

/** 建一个隔离的 ~/.omp 布局，返回 [configRoot 相对 PI_CONFIG_DIR, 会话文件路径, 临时根]。 */
async function scratchStoreLayout(): Promise<{
  configDirEnv: string;
  sessionPath: string;
  testRoot: string;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), "omp-cold-projection-"));
  assert.ok(resolve(testRoot).startsWith(`${resolve(tmpdir())}${sep}`));
  const sessionDir = join(testRoot, "agent", "sessions", "-");
  await mkdir(sessionDir, { recursive: true });
  return {
    configDirEnv: relative(homedir(), testRoot),
    sessionPath: join(sessionDir, FILE_NAME),
    testRoot,
  };
}

function cleanup(testRoot: string): Promise<void> {
  return rm(testRoot, { recursive: true, force: true });
}

test("当前 omp 合法字符串正文可恢复标题、历史与子代理 transcript", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "saved plain user", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [null, { type: "text", text: "saved answer" }],
        timestamp: 2,
      },
    },
  ];
  assert.equal(titleFromOmpEntries(entries), "saved plain user");
  assert.deepEqual(
    rowsFromOmpEntries(entries).map((row) => ("text" in row ? row.text : "")),
    ["saved plain user", "saved answer"],
  );
  assert.equal(
    transcriptFromOmpEntries(entries),
    "user: saved plain user\n\nassistant: saved answer",
  );
});

// ── S7-3：崩溃中断收尾。──

/** 一份会话文件：三个工具调用——有成功结果 / 有失败结果 / 崩溃无结果（在退出诊断中）。 */
function crashSessionLines(): string {
  return jsonl(
    { type: "session", id: "crash-1", timestamp: "2026-09-24T00:00:00.000Z", cwd: "/w" },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-09-24T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "跑三条命令" }], timestamp: 1000 },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-09-24T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "toolu_ok", name: "bash", arguments: { command: "echo ok" } },
          { type: "toolCall", id: "toolu_err", name: "bash", arguments: { command: "exit 1" } },
          { type: "toolCall", id: "toolu_lost", name: "bash", arguments: { command: "sleep 100" } },
        ],
        timestamp: 2000,
      },
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: "2026-09-24T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "toolu_ok",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3000,
      },
    },
    {
      type: "message",
      id: "m4",
      parentId: "m2",
      timestamp: "2026-09-24T00:00:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "toolu_err",
        toolName: "bash",
        content: [{ type: "text", text: "failed" }],
        isError: true,
        timestamp: 4000,
      },
    },
    // omp exit-diagnostics：teardown 写入 session_exit，pendingToolCalls 只含未收口的 toolu_lost。
    {
      type: "custom",
      id: "m5",
      parentId: "m2",
      timestamp: "2026-09-24T00:00:05.000Z",
      customType: "session_exit",
      data: {
        reason: "SIGKILL",
        kind: "process_exit",
        recordedAt: "2026-09-24T00:00:05.000Z",
        pendingToolCalls: [
          { toolCallId: "toolu_lost", toolName: "bash", args: { command: "sleep 100" } },
          { toolName: "no-id-call" },
        ],
      },
    },
  );
}

test("store 级：崩溃会话冷恢复——无落盘结果收尾 cancelled，有结果按 isError", async (context) => {
  const { configDirEnv, sessionPath, testRoot } = await scratchStoreLayout();
  context.after(() => cleanup(testRoot));
  await writeFile(sessionPath, crashSessionLines());

  const store = createOmpStore({ PI_CONFIG_DIR: configDirEnv });
  const entries = await store.readSessionEntries(sessionPath);
  const rows = rowsFromOmpEntries(entries);
  const statusOf = (toolCallId: string): string | undefined => {
    const row = rows.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
    );
    return row?.kind === "toolCall" ? row.status : undefined;
  };

  // 有落盘结果：完成事实恒胜出。
  assert.equal(statusOf("toolu_ok"), "success");
  assert.equal(statusOf("toolu_err"), "error");
  // 崩溃无结果：不再显示绿色 success（修复前硬编码 success），收尾中断终态 cancelled。
  assert.equal(statusOf("toolu_lost"), "cancelled");
});

test("rowsFromOmpEntries：无 session_exit 诊断时按配对扫描收尾 cancelled（§15.2(5) 只认已保存事实）", () => {
  const entries = [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "t",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_lost", name: "bash", arguments: {} }],
        timestamp: 1,
      },
    },
  ];
  const rows = rowsFromOmpEntries(entries);
  const row = rows.find((candidate) => candidate.kind === "toolCall");
  assert.equal(row?.kind, "toolCall");
  if (row?.kind !== "toolCall") return;
  assert.equal(row.status, "cancelled");
  // 无完成事实即无收尾事实：不得伪造 endedAt/output。
  assert.equal(row.endedAt, undefined);
  assert.equal(row.output, undefined);
});

// ── S1-3：sessionsRoot XDG 规则（ompSessionsRoot，platform/home/exists 注入）。──

test("ompSessionsRoot：linux/darwin 且 $XDG_DATA_HOME/omp 存在时扁平化 agent/ 前缀", () => {
  const xdg = "/xdg-data";
  const exists = (path: string): boolean =>
    path === join(xdg, "omp") || path === join(xdg, "omp", "profiles", "work");
  const base = {
    env: {
      XDG_DATA_HOME: xdg,
      OMP_CONFIG_ROOT: "/custom-root",
      PI_CONFIG_DIR: "/custom-omp",
    } as NodeJS.ProcessEnv,
    home: "/home/u",
    exists,
  };
  // 默认 profile：锚 $XDG_DATA_HOME/omp，sessions 扁平挂在锚点下（无 agent/ 段），
  // 且 OMP_CONFIG_ROOT / PI_CONFIG_DIR 不改变已迁移的 XDG data 根（当前 OMP 同源）。
  assert.equal(ompSessionsRoot({ ...base, platform: "linux" }), join(xdg, "omp", "sessions"));
  assert.equal(ompSessionsRoot({ ...base, platform: "darwin" }), join(xdg, "omp", "sessions"));
  // 命名 profile：锚 $XDG_DATA_HOME/omp/profiles/<p>。
  assert.equal(
    ompSessionsRoot({ ...base, env: { ...base.env, OMP_PROFILE: "work" }, platform: "linux" }),
    join(xdg, "omp", "profiles", "work", "sessions"),
  );
});

test("ompSessionsRoot：锚点不存在回退 ~/.omp 布局；XDG_DATA_HOME 为空不参与；win32 不受影响", () => {
  // Windows 的 /home/u 是当前盘根路径；共享解析器使用绝对路径，测试也采用宿主解析后的 home。
  const home = resolve("/home/u");
  const xdg = "/xdg-data";
  const never = (): boolean => false;
  const onlyAppRoot = (path: string): boolean => path === join(xdg, "omp");
  // 锚点不存在（未执行 omp config init-xdg 迁移）→ 回退 configRoot 布局。
  assert.equal(
    ompSessionsRoot({
      env: { XDG_DATA_HOME: xdg } as NodeJS.ProcessEnv,
      platform: "linux",
      home,
      exists: never,
    }),
    join(home, ".omp", "agent", "sessions"),
  );
  // 空串 XDG_DATA_HOME 不参与（omp resolveIf 对 falsy 直接跳过）。
  assert.equal(
    ompSessionsRoot({
      env: { XDG_DATA_HOME: "" } as NodeJS.ProcessEnv,
      platform: "linux",
      home,
      exists: onlyAppRoot,
    }),
    join(home, ".omp", "agent", "sessions"),
  );
  // 命名 profile 锚点不存在 → 回退 profiles/<p>/agent/sessions。
  assert.equal(
    ompSessionsRoot({
      env: { XDG_DATA_HOME: xdg, OMP_PROFILE: "work" } as NodeJS.ProcessEnv,
      platform: "linux",
      home,
      exists: onlyAppRoot,
    }),
    join(home, ".omp", "profiles", "work", "agent", "sessions"),
  );
  // win32 完全不参与 XDG（锚点存在也不改道）。
  assert.equal(
    ompSessionsRoot({
      env: { XDG_DATA_HOME: xdg } as NodeJS.ProcessEnv,
      platform: "win32",
      home,
      exists: onlyAppRoot,
    }),
    join(home, ".omp", "agent", "sessions"),
  );
});
