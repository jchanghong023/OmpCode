// 冷存储投影 store 级 UT（S7-2 / S7-3 / S1-3）：
// - 标题优先级（S7-2，对齐 omp 权威语义）：首行 type:"title" 固定槽位 > 最后一条
//   title_change > header.title > 首条用户消息；rpc-project-sessions 冷改名只原地
//   重写首行槽位不追加条目，重扫必须取到新标题。
// - 崩溃中断收尾（S7-3，§8.2/§15.2(5)）：无落盘 toolResult 的 toolCall 行收尾为
//   cancelled（不得据无进度推断成功）；session_exit.pendingToolCalls（omp
//   exit-diagnostics.ts teardown 写入）并入中断集合；有结果的行按 isError 收尾。
// - sessionsRoot XDG 规则（S1-3，omp DirResolver dirs.ts）：linux/darwin 且
//   $XDG_DATA_HOME/omp（命名 profile 为 $XDG_DATA_HOME/omp/profiles/<p>）锚点存在时
//   data 根改指锚点并扁平化 agent/ 前缀；锚点不存在回退 ~/.omp 布局；win32 不参与。

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { createOmpStore, ompSessionsRoot } from "../src/adapters/ompStore.js";
import {
  rowsFromOmpEntries,
  titleFromOmpEntries,
  transcriptFromOmpEntries,
} from "../src/domain/coldHistory.js";

// ── omp session-title-slot.ts 同形首行槽位（含 pad 补齐到 256 字节）。──

const TITLE_SLOT_BYTES = 256;

function titleSlotLine(title: string, updatedAt: string, source?: string): string {
  const slot = (pad: string) =>
    source
      ? { type: "title", v: 1, title, source, updatedAt, pad }
      : { type: "title", v: 1, title, updatedAt, pad };
  const unpadded = JSON.stringify(slot(""));
  const padBytes = TITLE_SLOT_BYTES - Buffer.byteLength(unpadded, "utf8") - 1;
  assert.ok(padBytes >= 0, "测试槽位标题超长");
  return `${JSON.stringify(slot(" ".repeat(padBytes)))}\n`;
}

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

// ── S7-2：标题优先级。──

test("titleFromOmpEntries：首行 title 槽位胜过后续 title_change / header.title / 首条用户消息", () => {
  const entries = [
    {
      type: "title",
      v: 1,
      title: "槽位标题",
      source: "auto",
      updatedAt: "2026-09-24T00:00:00.000Z",
      pad: "",
    },
    {
      type: "session",
      id: SESSION_ID,
      title: "头标题",
      timestamp: "2026-09-24T00:00:00.000Z",
      cwd: "/w",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-09-24T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "首条用户消息" }], timestamp: 1 },
    },
    {
      type: "title_change",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-09-24T00:00:02.000Z",
      title: "旧改名",
      source: "user",
    },
    {
      type: "title_change",
      id: "m3",
      parentId: "m1",
      timestamp: "2026-09-24T00:00:03.000Z",
      title: "新改名",
      source: "user",
    },
  ];
  assert.equal(titleFromOmpEntries(entries), "槽位标题");
});

test("titleFromOmpEntries：无槽位时取最后一条 title_change，其次 header.title，再次首条用户消息", () => {
  const header = {
    type: "session",
    id: SESSION_ID,
    title: "头标题",
    timestamp: "2026-09-24T00:00:00.000Z",
    cwd: "/w",
  };
  const user = {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-24T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "首条用户消息" }], timestamp: 1 },
  };
  // 最后一条 title_change 胜出（不是第一条）。
  assert.equal(
    titleFromOmpEntries([
      header,
      user,
      {
        type: "title_change",
        id: "m2",
        parentId: "m1",
        timestamp: "t",
        title: "旧改名",
        source: "user",
      },
      {
        type: "title_change",
        id: "m3",
        parentId: "m1",
        timestamp: "t",
        title: "新改名",
        source: "user",
      },
    ]),
    "新改名",
  );
  // 无 title_change → header.title。
  assert.equal(titleFromOmpEntries([header, user]), "头标题");
  // 无 header.title → 首条用户消息。
  assert.equal(
    titleFromOmpEntries([{ type: "session", id: SESSION_ID, timestamp: "t", cwd: "/w" }, user]),
    "首条用户消息",
  );
});

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

test("titleFromOmpEntries：槽位只认物理首行，中部 title 条目不作为槽位", () => {
  const entries = [
    { type: "session", id: SESSION_ID, timestamp: "t", cwd: "/w" },
    { type: "title", v: 1, title: "伪槽位", updatedAt: "t", pad: "" },
    {
      type: "title_change",
      id: "m1",
      parentId: null,
      timestamp: "t",
      title: "改名",
      source: "user",
    },
  ];
  assert.equal(titleFromOmpEntries(entries), "改名");
});

test("store 级：真实形状 JSONL 取槽位标题；冷改名原地重写首行后重扫取新标题", async (context) => {
  const { configDirEnv, sessionPath, testRoot } = await scratchStoreLayout();
  context.after(() => cleanup(testRoot));
  await writeFile(
    sessionPath,
    jsonl(
      JSON.parse(titleSlotLine("冷改前标题", "2026-09-24T00:00:00.000Z", "auto")),
      { type: "session", id: SESSION_ID, timestamp: "2026-09-24T00:00:00.000Z", cwd: "/w" },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-09-24T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "帮我算题" }], timestamp: 1 },
      },
      {
        type: "title_change",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-09-24T00:00:02.000Z",
        title: "自动标题",
        source: "auto",
      },
      {
        type: "title_change",
        id: "m3",
        parentId: "m1",
        timestamp: "2026-09-24T00:00:03.000Z",
        title: "手工改名",
        source: "user",
      },
    ),
  );

  const store = createOmpStore({ PI_CONFIG_DIR: configDirEnv });
  const before = (await store.listSessions(homedir())).find((s) => s.sessionId === SESSION_ID);
  assert.equal(before?.title, "冷改前标题");
  assert.equal(before?.firstUserText, "冷改前标题");

  // rpc-project-sessions.updateSessionTitle 语义：只原地重写首行槽位，不追加条目。
  const lines = (await readFile(sessionPath, "utf8")).split("\n");
  lines[0] = titleSlotLine("冷改后标题", "2026-09-24T12:00:00.000Z", "user").trimEnd();
  await writeFile(sessionPath, lines.join("\n"));

  const after = (await store.listSessions(homedir())).find((s) => s.sessionId === SESSION_ID);
  assert.equal(after?.title, "冷改后标题");
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

// ── 冷恢复 live/冷一致回归（GUI 全量冷恢复实测，2026-10-08 合并后复验）──

test("rowsFromOmpEntries：team-dispatch 仅存 journal，不进入冷时间线；其他可见 custom 保留", () => {
  const entries = [
    {
      type: "custom_message",
      customType: "team-dispatch",
      content: "/team 多模型讨论已启动（任务 bg_1）。",
      display: true,
      attribution: "agent",
      id: "dispatch-1",
      timestamp: 1,
    },
    {
      type: "custom_message",
      customType: "team-result",
      content: "## /team 多模型讨论结果（team-result）",
      display: true,
      attribution: "agent",
      id: "result-1",
      timestamp: 2,
    },
  ];
  const texts = rowsFromOmpEntries(entries).map((row) => ("text" in row ? row.text : ""));
  assert.ok(!texts.some((text) => text.includes("多模型讨论已启动")), "调度通知不得进入冷时间线");
  assert.ok(
    texts.some((text) => text.includes("team-result")),
    "可见 team-result 仍须显示",
  );
});

test("rowsFromOmpEntries：/skill: 轮只有 skill-prompt（attribution=user）时推进轮边界，模型回复不并入上一用户轮", () => {
  const entries = [
    {
      type: "message",
      message: { role: "user", content: "ultrathink 正文提问", timestamp: 1 },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NATIVE_BODY_RESULT" }],
        timestamp: 2,
      },
    },
    {
      type: "custom_message",
      customType: "skill-prompt",
      content: "[IMPORTANT: User invoked the skill]\n\nPRIVATE_SKILL_BODY",
      display: true,
      attribution: "user",
      details: { name: "native-command-fixture", prompt: "/skill:native-command-fixture  参数" },
      id: "skill-1",
      timestamp: 3,
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NATIVE_SKILL_RESULT" }],
        timestamp: 4,
      },
    },
  ];
  const rows = rowsFromOmpEntries(entries);
  const turnOf = (text: string) => rows.find((row) => "text" in row && row.text === text)?.turnId;
  const bodyTurn = turnOf("NATIVE_BODY_RESULT");
  const skillTurn = turnOf("NATIVE_SKILL_RESULT");
  assert.ok(bodyTurn && skillTurn, "两条模型回复都必须生成行");
  assert.notEqual(
    bodyTurn,
    skillTurn,
    "skill 回复不得与上一用户轮同组（组内 latest-assistant 会隐藏旧回复）",
  );
  assert.equal(
    rows.filter((row) => row.turnId === bodyTurn && row.kind === "assistantText").length,
    1,
    "上一用户轮内只保留自身回复",
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    ["ultrathink 正文提问", "/skill:native-command-fixture  参数"],
  );
  assert.ok(
    rows.every((row) => !("text" in row) || !row.text.includes("PRIVATE_SKILL_BODY")),
    "技能正文不进入历史显示",
  );
});
