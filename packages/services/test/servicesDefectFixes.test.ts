import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createCommandsService } from "../src/commands/commandsService.js";
import { createGitCheckpointRepo } from "../src/git/repo/gitCheckpointRepo.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import type { OffPeakServerClient } from "../src/session/offPeakServerClient.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { setDataBaseDir } from "../src/paths.js";

/** 把 HOME/USERPROFILE 重定向到临时目录，隔离 commandsService 对用户目录的读写。 */
async function withIsolatedHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "services-defect-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await run(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await rm(home, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const noopLogger: ServiceLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---- F22：commandsService name 白名单 + delete 收容 ----

test("F22: command name 白名单拒绝穿越名", async () => {
  await withIsolatedHome(async () => {
    const service = createCommandsService();
    await assert.rejects(
      service.writeCommandFile({ config: { name: "../evil", prompt: "p" } }),
      /Invalid command name/,
    );
    await assert.rejects(
      service.writeCommandFile({ config: { name: "a/../../b", prompt: "p" } }),
      /Invalid command name/,
    );
    await assert.rejects(
      service.writeCommandFile({ config: { name: "", prompt: "p" } }),
      /Invalid command name/,
    );
    // 合法名不受影响。
    const { command } = await service.writeCommandFile({
      config: { name: "/my-cmd_1", prompt: "p" },
    });
    assert.equal(command.name, "/my-cmd_1");
  });
});

test("F22: deleteCommandFile 拒绝命令目录外路径且不删除目标", async () => {
  await withIsolatedHome(async (home) => {
    const service = createCommandsService();
    const decoy = join(home, "decoy.md");
    await writeFile(decoy, "keep me", "utf-8");
    await assert.rejects(
      service.deleteCommandFile({ commandId: "x", filePath: decoy, agentSource: "zcodeAgent" }),
      /outside command directories/,
    );
    assert.equal(await pathExists(decoy), true, "目录外文件必须原样保留");
  });
});

test("F22: deleteCommandFile 允许用户级与 project 级命令目录内的路径", async () => {
  await withIsolatedHome(async (home) => {
    const service = createCommandsService();
    const { command } = await service.writeCommandFile({
      config: { name: "/del-me", prompt: "p" },
    });
    await service.deleteCommandFile({
      commandId: command.id,
      filePath: command.filePath,
      agentSource: "zcodeAgent",
    });
    assert.equal(await pathExists(command.filePath), false, "用户级命令文件应被删除");

    // project 级命令文件位于 <workspace>/.ompcode/commands 下；delete 参数不含
    // workspacePath，按目录结构收容放行。
    const projectCommand = join(home, "proj", ".ompcode", "commands", "p.md");
    await mkdir(join(home, "proj", ".ompcode", "commands"), { recursive: true });
    await writeFile(projectCommand, "---\n---\n", "utf-8");
    await service.deleteCommandFile({
      commandId: "x",
      filePath: projectCommand,
      agentSource: "zcodeAgent",
    });
    assert.equal(await pathExists(projectCommand), false, "project 级命令文件应被删除");

    // workspace 内非命令目录的文件仍然拒绝。
    const outside = join(home, "proj", "docs", "note.md");
    await mkdir(join(home, "proj", "docs"), { recursive: true });
    await writeFile(outside, "keep", "utf-8");
    await assert.rejects(
      service.deleteCommandFile({ commandId: "x", filePath: outside, agentSource: "zcodeAgent" }),
      /outside command directories/,
    );
    assert.equal(await pathExists(outside), true);
  });
});

// ---- F23：updateCommandFile 先查重再删旧 ----

test("F23: 改名撞上已存在文件时报错且旧文件保留", async () => {
  await withIsolatedHome(async () => {
    const service = createCommandsService();
    const { command: alpha } = await service.writeCommandFile({
      config: { name: "/alpha", prompt: "alpha-prompt" },
    });
    await service.writeCommandFile({ config: { name: "/beta", prompt: "beta-prompt" } });

    await assert.rejects(
      service.updateCommandFile({
        commandId: alpha.id,
        config: { name: "/beta", prompt: "alpha-prompt" },
        oldFilePath: alpha.filePath,
      }),
      /Command file already exists/,
    );
    assert.equal(await pathExists(alpha.filePath), true, "查重失败时旧源文件必须保留");

    // 无撞车的正常改名不受影响。
    const { command: gamma } = await service.updateCommandFile({
      commandId: alpha.id,
      config: { name: "/gamma", prompt: "alpha-prompt" },
      oldFilePath: alpha.filePath,
    });
    assert.equal(await pathExists(alpha.filePath), false, "正常改名后旧文件应删除");
    assert.equal(await pathExists(gamma.filePath), true);
  });
});

// ---- F24：queryGroupedTaskView SELECT 缺 off_peak_task_id ----

test("F24: queryGroupedTaskView 能读出仅存在于投影列的 offPeakTaskId", async () => {
  const root = await mkdtemp(join(tmpdir(), "services-defect-index-"));
  const repo = new TaskIndexRepo(join(root, "tasks-index.sqlite"));
  try {
    const workspacePath = join(root, "ws");
    await repo.syncTaskMeta({
      meta: {
        traceId: "trace-f24",
        workspacePath,
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        provider: "glm",
        taskId: "task-f24",
        title: "F24 task",
      },
    });
    // 模拟存量回填：投影列有值而 meta_json 未写该字段（读取必须依赖 SELECT 列兜底）。
    const raw = new DatabaseSync(join(root, "tasks-index.sqlite"));
    raw.prepare("UPDATE tasks SET off_peak_task_id = 'opt-f24' WHERE task_id = 'task-f24'").run();
    raw.close();

    const view = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath }],
    });
    const tasks = view.nodes.flatMap((node) => (node.type === "group" ? node.tasks : [node.task]));
    const target = tasks.find((task) => task.taskId === "task-f24");
    assert.ok(target, "grouped 视图应包含目标任务");
    assert.equal(target.offPeakTaskId, "opt-f24");
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---- F25：applyGroupedTaskViewOrder 的 group 排序清理越 scope ----

test("F25: A scope 提交排序后 B scope 的 group 排序保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "services-defect-grouped-"));
  const repo = new TaskIndexRepo(join(root, "tasks-index.sqlite"));
  try {
    const wsA = join(root, "ws-a");
    const wsB = join(root, "ws-b");
    for (const [workspacePath, taskId] of [
      [wsA, "task-a"],
      [wsB, "task-b"],
    ] as const) {
      await repo.syncTaskMeta({
        meta: {
          traceId: "trace-f25",
          workspacePath,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
          taskId,
          title: taskId,
        },
      });
    }
    // 首次查询触发 workspace group bootstrap：每个 workspace 各得一个绑定 group 及其排序。
    await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: wsA }, { workspacePath: wsB }],
    });
    const before = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: wsA }, { workspacePath: wsB }],
    });
    const groupIdByTask = new Map(
      before.members.map((member) => [member.taskId, member.groupId] as const),
    );
    const groupAId = groupIdByTask.get("task-a");
    const groupBId = groupIdByTask.get("task-b");
    assert.ok(
      groupAId && groupBId && groupAId !== groupBId,
      "bootstrap 应产出两个 workspace group",
    );

    // 只对 A scope 提交排序；B 的 group 不在 payload 内。
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: wsA }],
      topLevelNodes: [
        { type: "group", groupId: groupAId },
        { type: "task", task: { workspacePath: wsA, taskId: "task-a" } },
      ],
      groups: [{ groupId: groupAId, taskRefs: [{ workspacePath: wsA, taskId: "task-a" }] }],
    });

    const after = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: wsA }, { workspacePath: wsB }],
    });
    const groupOrderIds = after.topLevelOrders
      .filter((order) => order.type === "group")
      .map((order) => order.groupId);
    assert.equal(
      groupOrderIds.includes(groupBId),
      true,
      "B scope 的 group 排序不能被 A scope 的提交误删",
    );
    assert.equal(groupOrderIds.includes(groupAId), true, "payload 覆盖的 A scope group 排序应重建");
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---- R7-1：空 workspaceScopes 保存排序不得因跳过 group 清理触发 UNIQUE 回滚 ----

test("R7-1: 空 workspaceScopes 保存排序时全局 group 排序替换、scope 绑定 group 排序保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "services-defect-r71-"));
  const repo = new TaskIndexRepo(join(root, "tasks-index.sqlite"));
  try {
    const wsA = join(root, "ws-a");
    await repo.syncTaskMeta({
      meta: {
        traceId: "trace-r71",
        workspacePath: wsA,
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        provider: "glm",
        taskId: "task-a",
        title: "task-a",
      },
    });
    // 首次查询 bootstrap 产出绑定 wsA 的 group（带排序行）；createTaskGroup 产出无
    // bootstrap 绑定的全局 group（同样带排序行），两者都已在 task_group_view_node_orders。
    await repo.queryGroupedTaskView({ workspaceScopes: [{ workspacePath: wsA }] });
    const globalGroup = await repo.createTaskGroup({ title: "global" });
    const before = await repo.queryGroupedTaskViewStructure({ workspaceScopes: [] });
    const boundOrderBefore = before.topLevelOrders.find(
      (order) => order.type === "group" && order.groupId !== globalGroup.id,
    );
    assert.ok(
      boundOrderBefore && boundOrderBefore.type === "group",
      "bootstrap 应已产出绑定 group 的排序行",
    );
    const globalOrderBefore = before.topLevelOrders.find(
      (order) => order.type === "group" && order.groupId === globalGroup.id,
    );
    assert.ok(globalOrderBefore && globalOrderBefore.type === "group", "全局 group 应已有排序行");

    // 视图内任务全部归档/删除只剩空分组时，UI 合法产出空 scopes + 仅含全局 group 的 payload。
    // 回归机制：外层守卫跳过全部 group 排序清理，而 insertOrder 仍对该已存在排序行的
    // group 无 ON CONFLICT 地 INSERT → UNIQUE(node_type, node_key) 异常 → 事务 ROLLBACK。
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [],
      topLevelNodes: [{ type: "group", groupId: globalGroup.id }],
      groups: [],
    });

    const after = await repo.queryGroupedTaskViewStructure({ workspaceScopes: [] });
    const globalOrderAfter = after.topLevelOrders.find(
      (order) => order.type === "group" && order.groupId === globalGroup.id,
    );
    assert.ok(globalOrderAfter && globalOrderAfter.type === "group");
    assert.equal(
      globalOrderAfter.sortOrder,
      1000, // GROUPED_TASK_ORDER_STEP：payload 首个节点的新排序
      "全局 group 排序应被 payload 新值替换",
    );
    assert.notEqual(globalOrderAfter.sortOrder, globalOrderBefore.sortOrder, "新值必须实际生效");
    const boundOrderAfter = after.topLevelOrders.find(
      (order) =>
        order.type === "group" &&
        boundOrderBefore.type === "group" &&
        order.groupId === boundOrderBefore.groupId,
    );
    assert.ok(
      boundOrderAfter && boundOrderAfter.type === "group",
      "scope 绑定 group 的旧排序必须保留",
    );
    assert.equal(
      boundOrderAfter.sortOrder,
      boundOrderBefore.sortOrder,
      "绑定 group 旧排序值不能被改写",
    );
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---- F26：rowToAutomation 脏 schedule_rule 守卫 ----

test("F26: schedule_rule 脏 JSON 按无规则处理且不拖垮读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "services-defect-automation-"));
  const repo = new AutomationRepo(join(root, "automation.sqlite"));
  try {
    const created = await repo.create(
      {
        title: "f26",
        cronExpr: "0 9 * * *",
        prompt: "p",
        modelSelection: { providerId: "glm", modelId: "test-model" },
        workspacePath: join(root, "ws"),
        recurring: true,
      },
      { nextRunAt: null },
    );
    const raw = new DatabaseSync(join(root, "automation.sqlite"));
    raw.prepare("UPDATE automations SET schedule_rule = '{broken-json'").run();
    raw.close();

    const listed = await repo.list();
    assert.equal(listed.length, 1, "脏 schedule_rule 不能让列表为空或抛错");
    assert.equal(listed[0].automationId, created.automationId);
    assert.equal(listed[0].scheduleRule, undefined, "脏规则按无规则处理");
    const fetched = await repo.get(created.automationId);
    assert.ok(fetched);
    assert.equal(fetched.scheduleRule, undefined);
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---- F27：空任务分支停轮询 / outbox 未清空时保留补报 ----

function createOffPeakService(params: {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
}): OffPeakTaskService {
  return new OffPeakTaskService({
    repo: params.repo,
    client: params.client,
    resolveCodingPlanSupport: async () => {
      throw new Error("not used in sync cycle");
    },
    resolveTelemetryProviderName: async () => "",
    resolveModelSelection: () => {
      throw new Error("not used in sync cycle");
    },
    logger: noopLogger,
  });
}

test("F27: 无任务且 outbox 已清空时不再自排定时器", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "services-defect-offpeak-"));
  const repo = new OffPeakTaskRepo(join(root, "offpeak.sqlite"));
  try {
    // 用补报扫描次数观察循环是否停止：修复后首个周期结束即停，推进时钟不再触发。
    let flushCalls = 0;
    const originalFlush = repo.listUnsettledTerminal.bind(repo);
    repo.listUnsettledTerminal = async () => {
      flushCalls += 1;
      return originalFlush();
    };
    const service = createOffPeakService({ repo, client: createNoopClient() });
    // ensureSyncScheduled 受 syncStopped 守卫，必须 startSync 让自动重排循环进入运行态。
    service.startSync();
    t.mock.timers.tick(1);
    await drainAsync();
    assert.equal(flushCalls, 1, "启动扫描应完成一次 outbox 扫描");
    t.mock.timers.tick(10 * 60_000);
    await drainAsync();
    assert.equal(flushCalls, 1, "空任务且 outbox 已清空后不能自排下一个轮询周期");
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("F27: outbox 仍有未核销终态时保留周期补报", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "services-defect-offpeak-"));
  const repo = new OffPeakTaskRepo(join(root, "offpeak.sqlite"));
  try {
    let settleCalls = 0;
    const client = createNoopClient({
      settle: async () => {
        settleCalls += 1;
        throw new Error("network down");
      },
    });
    const service = createOffPeakService({ repo, client });
    // 用补报扫描次数观察循环是否按预期继续/停止。
    let flushCalls = 0;
    const originalFlush = repo.listUnsettledTerminal.bind(repo);
    repo.listUnsettledTerminal = async () => {
      flushCalls += 1;
      return originalFlush();
    };
    const workspacePath = join(root, "ws");
    const created = await repo.create(
      {
        title: "f27",
        prompt: "p",
        permissionMode: "build",
        modelSelection: { providerId: "glm", modelId: "test-model" },
        workspacePath,
      },
      { serverTicketId: "ticket-f27" },
    );
    await repo.markTerminal(created.offPeakTaskId, { status: "completed", endedAt: 1 });

    service.startSync();
    t.mock.timers.tick(1);
    await drainAsync();
    assert.equal(settleCalls, 1, "启动周期应尝试补报");
    assert.equal(flushCalls, 1);
    t.mock.timers.tick(5 * 60_000);
    await drainAsync();
    assert.equal(settleCalls, 2, "未核销完必须保留下一个补报周期");
    assert.equal(flushCalls, 2);

    // 补报成功后 outbox 清空，循环应当停止。
    client.settle = async () => undefined;
    t.mock.timers.tick(5 * 60_000);
    await drainAsync();
    assert.equal(settleCalls, 2, "成功周期不再调用失败的计数桩");
    assert.equal(flushCalls, 3, "outbox 未清空的最后一个周期仍应执行扫描");
    t.mock.timers.tick(10 * 60_000);
    await drainAsync();
    assert.equal(flushCalls, 3, "outbox 清空后应停止自排");
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** mock 定时器同步触发 async 回调，推进事件循环让 runSyncCycle 的 await 链走完。 */
async function drainAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createNoopClient(overrides?: Partial<OffPeakServerClient>): OffPeakServerClient {
  return {
    getTakeNumberAvailability: async () => {
      throw new Error("not used");
    },
    takeTicket: async () => {
      throw new Error("not used");
    },
    batchStatus: async () => ({ tickets: [] }),
    settle: async () => undefined,
    ...overrides,
  };
}

// ---- F34：updateCommandFile.oldFilePath 收容 ----

test("F34: updateCommandFile 拒绝命令目录外 oldFilePath 且 decoy 保留", async () => {
  await withIsolatedHome(async (home) => {
    const service = createCommandsService();
    const decoy = join(home, "secret-decoy.md");
    await writeFile(decoy, "keep me", "utf-8");
    await assert.rejects(
      service.updateCommandFile({
        commandId: "x",
        config: { name: "/renamed", prompt: "p" },
        oldFilePath: decoy,
      }),
      /outside command directories/,
    );
    assert.equal(await pathExists(decoy), true, "收容外 oldFilePath 不能被读取或删除");

    // 收容内的合法改名不受影响。
    const { command: alpha } = await service.writeCommandFile({
      config: { name: "/alpha", prompt: "alpha-prompt" },
    });
    const { command: beta } = await service.updateCommandFile({
      commandId: alpha.id,
      config: { name: "/beta", prompt: "alpha-prompt" },
      oldFilePath: alpha.filePath,
    });
    assert.equal(await pathExists(alpha.filePath), false, "合法改名后旧文件应删除");
    assert.equal(await pathExists(beta.filePath), true);
  });
});

// ---- F35：checkpoint 冲突检测与 git add 口径同源（diff dirty 判定） ----

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { windowsHide: true }, (error) => resolve(!error));
  });
}

/**
 * 建立临时 git 仓 + 仓库外数据目录并执行断言。
 *
 * checkpoint 的临时 index 根由数据根（getGitCheckpointIndexRootDir）推导；生产拓扑中
 * 数据根位于用户 HOME，天然在 workspace 仓库之外。测试必须保持同一拓扑：若把数据目录
 * 指进仓库，`git add -A -- .` 会把临时 index 文件扫进 checkpoint tree 造成自污染，
 * 使冲突检测面对生产中不存在的路径。
 */
async function withCheckpointScenario<T>(run: (repoDir: string) => Promise<T>): Promise<T> {
  const scenarioRoot = await mkdtemp(join(tmpdir(), "services-defect-checkpoint-"));
  const dataDir = join(scenarioRoot, "data");
  const repoDir = join(scenarioRoot, "repo");
  await mkdir(dataDir, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  setDataBaseDir(dataDir);
  try {
    return await run(repoDir);
  } finally {
    setDataBaseDir(null);
    await rm(scenarioRoot, { recursive: true, force: true });
  }
}

/** 初始化提交了 CRLF 文件的临时仓；autocrlf 参数决定提交时的转换口径。 */
async function initCheckpointRepo(repoDir: string, autocrlf: string): Promise<string> {
  await runGit(repoDir, ["init"]);
  await runGit(repoDir, ["config", "core.autocrlf", autocrlf]);
  await runGit(repoDir, ["config", "user.name", "test"]);
  await runGit(repoDir, ["config", "user.email", "test@example.com"]);
  const file = join(repoDir, "note.md");
  await writeFile(file, "line-one\r\nline-two\r\n", "utf-8");
  await runGit(repoDir, ["add", "."]);
  await runGit(repoDir, ["commit", "-m", "init"]);
  return file;
}

async function restoreAndAssertBaseline(params: {
  repoDir: string;
  file: string;
  force?: boolean;
}): Promise<void> {
  const repo = createGitCheckpointRepo();
  const baseline = await repo.createCheckpoint({
    workspacePath: params.repoDir,
    checkpointId: "cp1",
  });
  await writeFile(params.file, "line-one\r\nline-two\r\nline-three\r\n", "utf-8");
  const edited = await repo.createCheckpoint({
    workspacePath: params.repoDir,
    checkpointId: "cp2",
  });

  const result = await repo.restoreBetweenCheckpoints({
    workspacePath: params.repoDir,
    from: edited,
    to: baseline,
    ...(params.force === true ? { force: true } : {}),
  });
  // 冲突检测哈希口径与 git add 的 clean filter 转换分叉时会误报 content-mismatch：
  // 非 force 被拒绝，force 则先写盘再在末次验证抛 "Checkpoint restore verification failed."
  assert.equal(result.success, true);
  assert.equal(result.conflicts, undefined);
  const restored = await readFile(params.file, "utf-8");
  assert.equal(restored.replace(/\r\n/g, "\n"), "line-one\nline-two\n", "restore 后应回到基线内容");
}

// 场景 A：autocrlf=true 建仓，checkpoint tree（add 过滤后 LF）vs worktree 原始 CRLF。
test("F35-A: autocrlf 仓 CRLF 文件 checkpoint 后无冲突且 restore 成功", async (t: TestContext) => {
  if (!(await gitAvailable())) {
    t.skip("git CLI 不可用，无法验证 checkpoint 冲突判定");
    return;
  }
  await withCheckpointScenario(async (repoDir) => {
    const file = await initCheckpointRepo(repoDir, "true");
    await restoreAndAssertBaseline({ repoDir, file });
  });
});

// 场景 B：autocrlf=false 提交 CRLF 后翻转为 true（Git for Windows 历史 CRLF 仓常见组合）。
// 此时 git add 的 CRLF→LF 转换被"index 内已有 CR 则不转换"启发式抑制，checkpoint tree
// 保留原始 CRLF；任何 hash-object 口径都与 add 口径分叉，只有 git 自身的 diff 判定同源。
test("F35-B: 历史 CRLF 仓翻转 autocrlf 后 restore 不误报冲突", async (t: TestContext) => {
  if (!(await gitAvailable())) {
    t.skip("git CLI 不可用，无法验证 checkpoint 冲突判定");
    return;
  }
  await withCheckpointScenario(async (repoDir) => {
    const file = await initCheckpointRepo(repoDir, "false");
    await runGit(repoDir, ["config", "core.autocrlf", "true"]);
    await restoreAndAssertBaseline({ repoDir, file });
  });
});

test("F35-B: force restore 不再在写盘后抛验证失败", async (t: TestContext) => {
  if (!(await gitAvailable())) {
    t.skip("git CLI 不可用，无法验证 checkpoint 冲突判定");
    return;
  }
  await withCheckpointScenario(async (repoDir) => {
    const file = await initCheckpointRepo(repoDir, "false");
    await runGit(repoDir, ["config", "core.autocrlf", "true"]);
    await restoreAndAssertBaseline({ repoDir, file, force: true });
  });
});

// ---- F37：subagentsService delete/update 收容 ----

test("F37: deleteAgent 拒绝 agent 目录外路径且 decoy 保留", async () => {
  await withIsolatedHome(async (home) => {
    const service = createSubagentsService();
    const decoy = join(home, "decoy.md");
    await writeFile(decoy, "keep me", "utf-8");
    await assert.rejects(
      service.deleteAgent({ agentId: "x", filePath: decoy }),
      /outside subagent directories/,
    );
    assert.equal(await pathExists(decoy), true, "目录外文件必须原样保留");

    // workspace 内非 agents 目录的文件同样拒绝：目录结构收容只放行 .ompcode/agents 形态。
    const outside = join(home, "proj", "docs", "note.md");
    await mkdir(join(home, "proj", "docs"), { recursive: true });
    await writeFile(outside, "keep", "utf-8");
    await assert.rejects(
      service.deleteAgent({ agentId: "x", filePath: outside }),
      /outside subagent directories/,
    );
    assert.equal(await pathExists(outside), true);
  });
});

test("F37: deleteAgent 允许用户级与 workspace 级 agent 目录内的路径", async () => {
  await withIsolatedHome(async (home) => {
    const service = createSubagentsService();
    const { agent } = await service.createAgent({
      config: { name: "del-me", description: "d", systemPrompt: "p" },
      provider: "glm",
      scope: "user",
    });
    await service.deleteAgent({ agentId: agent.id, filePath: agent.path });
    assert.equal(await pathExists(agent.path), false, "用户级 agent 文件应被删除");

    // AgentDeleteParams 不含 workspacePath，workspace 级按 <workspace>/.ompcode/agents
    // 目录结构收容放行（同 F22 project 级口径）。
    const workspaceAgent = join(home, "proj", ".ompcode", "agents", "ws-agent.md");
    await mkdir(join(home, "proj", ".ompcode", "agents"), { recursive: true });
    await writeFile(workspaceAgent, "---\n---\n", "utf-8");
    await service.deleteAgent({ agentId: "x", filePath: workspaceAgent });
    assert.equal(await pathExists(workspaceAgent), false, "workspace 级 agent 文件应被删除");
  });
});

test("F37: updateAgent 拒绝 agent 根外 oldFilePath 且 decoy 保留", async () => {
  await withIsolatedHome(async (home) => {
    const service = createSubagentsService();
    const decoy = join(home, "secret-decoy.md");
    await writeFile(decoy, "keep me", "utf-8");
    await assert.rejects(
      service.updateAgent({
        agentId: "x",
        config: { name: "renamed", description: "d", systemPrompt: "p" },
        oldFilePath: decoy,
        provider: "glm",
      }),
      /outside subagent directories/,
    );
    assert.equal(await pathExists(decoy), true, "收容外 oldFilePath 不能被删除");

    // update 携带 scope，可精确收容：user scope（缺省）下即使路径呈 .ompcode/agents 结构、
    // 位于别的 workspace 根内也必须拒绝（不做 delete 那样的目录结构退化）。
    const otherWorkspaceAgent = join(home, "proj-a", ".ompcode", "agents", "a.md");
    await mkdir(join(home, "proj-a", ".ompcode", "agents"), { recursive: true });
    await writeFile(otherWorkspaceAgent, "---\n---\n", "utf-8");
    await assert.rejects(
      service.updateAgent({
        agentId: "x",
        config: { name: "renamed", description: "d", systemPrompt: "p" },
        oldFilePath: otherWorkspaceAgent,
        provider: "glm",
      }),
      /outside subagent directories/,
    );
    assert.equal(await pathExists(otherWorkspaceAgent), true);

    // workspace scope 更新精确收容于本次更新的目标根：跨 workspace 的 oldFilePath 拒绝。
    await mkdir(join(home, "proj-b", ".ompcode", "agents"), { recursive: true });
    await assert.rejects(
      service.updateAgent({
        agentId: "x",
        config: { name: "beta-ws", description: "d", systemPrompt: "p" },
        oldFilePath: otherWorkspaceAgent,
        provider: "glm",
        scope: "workspace",
        workspacePath: join(home, "proj-b"),
      }),
      /outside subagent directories/,
    );
    assert.equal(await pathExists(otherWorkspaceAgent), true, "跨 workspace oldFilePath 必须拒绝");

    // 收容内的合法改名不受影响。
    const { agent } = await service.createAgent({
      config: { name: "alpha", description: "d", systemPrompt: "p" },
      provider: "glm",
      scope: "user",
    });
    const { agent: beta } = await service.updateAgent({
      agentId: agent.id,
      config: { name: "beta-agent", description: "d", systemPrompt: "p" },
      oldFilePath: agent.path,
      provider: "glm",
    });
    assert.equal(await pathExists(agent.path), false, "合法改名后旧文件应删除");
    assert.equal(await pathExists(beta.path), true);
  });
});
