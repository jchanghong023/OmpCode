import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
// D48 一等行打点：offPeakTaskId 作为持久 task meta 字段的仓库契约（MR1，无 UI 行为变化）。
// 镜像 cronAutomationId 的三条不变量：meta_json 为准 + 索引列兜底、运行态快照不带标记时
// 保全已有值、bootstrap 幂等回填存量 off-peak 会话。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskGroupRepository } from "#src/task-groups/index.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";
import { createSettingService } from "#src/setting/settingService.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-off-peak-marker-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function task(params: { taskId: string; offPeakTaskId?: string }): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    provider: "glm",
    status: "running",
    ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
  };
}

function getRepoDatabase(target: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
} {
  return (
    target as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          get(...params: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
}

describe("TaskIndexRepo off-peak marker (D48)", () => {
  it("seedTaskIndex 持久化 offPeakTaskId 并投影到索引列", async () => {
    await seedTaskIndex(repo, { meta: task({ taskId: "s-1", offPeakTaskId: "offpeak-1" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-1",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-1");

    const row = getRepoDatabase(repo)
      .prepare(`SELECT off_peak_task_id FROM tasks WHERE task_id = ?`)
      .get("s-1") as { off_peak_task_id: string | null };
    expect(row.off_peak_task_id).toBe("offpeak-1");
  });

  it("运行态快照不带标记时保全已有 offPeakTaskId", async () => {
    await seedTaskIndex(repo, { meta: task({ taskId: "s-2", offPeakTaskId: "offpeak-2" }) });
    // 运行态 protocol snapshot 的 meta 不携带 off-peak 标记；同步不得把归属冲掉。
    await seedTaskIndex(repo, { meta: task({ taskId: "s-2" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-2",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-2");
  });

  it("meta_json 缺字段时以索引列兜底（backfill 只写列即可生效）", async () => {
    await seedTaskIndex(repo, { meta: task({ taskId: "s-3" }) });
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = ? WHERE task_id = ?`)
      .run("offpeak-3", "s-3");

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-3",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-3");
  });

  it("bootstrap 幂等回填存量 off-peak 会话的标记", async () => {
    // 存量形态：off_peak_tasks 已绑定 session，但 tasks 行诞生于打点之前、无标记。
    // 先做一次 repo 操作触发懒初始化，getRepoDatabase 才能拿到句柄。
    await seedTaskIndex(repo, { meta: task({ taskId: "s-legacy" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "legacy",
        prompt: "legacy",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-legacy" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-legacy", "offpeak-legacy");
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = NULL WHERE task_id = ?`)
      .run("s-legacy");
    repo.close();

    // 重新 bootstrap（等价于升级后首次启动）：回填必须命中且可重复执行。
    repo = new TaskIndexRepo();
    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-legacy",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-legacy");

    offPeakRepo.close();
  });

  it("回填不覆盖已有标记且对无关任务无副作用", async () => {
    // 已有显式标记的任务（值不同）与普通任务都不得被回填改写。
    await seedTaskIndex(repo, { meta: task({ taskId: "s-4", offPeakTaskId: "offpeak-explicit" }) });
    await seedTaskIndex(repo, { meta: task({ taskId: "s-plain" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "other",
        prompt: "other",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-other" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-4", "offpeak-other");
    repo.close();

    repo = new TaskIndexRepo();
    const explicit = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-4",
    });
    expect(explicit?.offPeakTaskId).toBe("offpeak-explicit");
    const plain = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-plain",
    });
    expect(plain?.offPeakTaskId).toBeUndefined();

    offPeakRepo.close();
  });
});

describe("TaskIndexRepo off-peak project ownership", () => {
  it("off-peak 首次标记加入系统组，不改变项目归属，重复同步不复活手动移出", async () => {
    const projectRepo = await repo.getProjectRepository();
    const project = projectRepo.saveProject({ roots: ["/workspace/project"] });
    const meta = task({ taskId: "project-offpeak" });
    projectRepo.reserveCreatedTask({ task: meta, projectId: project.id });
    await repo.applyCliFacts({ meta, lastOutcome: "completed" });
    await repo.updateTaskPresentation({ ...meta, presentation: { offPeakTaskId: "offpeak-1" } });
    expect(projectRepo.readTree().tasks[0]).toMatchObject({
      projectId: project.id,
      offPeakTaskId: "offpeak-1",
    });
    expect(getRepoDatabase(repo).prepare("SELECT count(*) AS n FROM task_groups").get()?.n).toBe(1);
    expect(
      getRepoDatabase(repo).prepare("SELECT count(*) AS n FROM task_group_members").get()?.n,
    ).toBe(1);
    const groups = new TaskGroupRepository(await repo.getOrganizationDatabase());
    const groupId = groups.read().members[0]!.groupId;
    groups.move({
      node: { type: "task", task: { ...meta, hostId: "local" } },
      sourceGroupId: groupId,
      groupId: null,
    });
    await repo.updateTaskPresentation({ ...meta, presentation: { offPeakTaskId: "offpeak-1" } });
    expect(groups.read().members).toEqual([]);
    await repo.applyCliDeletion(meta);
    expect(groups.read().order.filter((node) => node.type === "task")).toEqual([]);
  });
});

describe("TaskIndexRepo OMP profile binding", () => {
  it("旧未知不等于默认，只有明确事实绑定后允许相同 profile", async () => {
    const meta = task({ taskId: "profile-unknown" });
    await seedTaskIndex(repo, { meta });
    expect(await repo.readTaskOmpProfile(meta)).toBeUndefined();
    await expect(repo.assertTaskOmpProfile(meta, null)).rejects.toMatchObject({
      code: "omp.profileUnknown",
    });
    await repo.bindTaskOmpProfile(meta, null);
    expect(await repo.readTaskOmpProfile(meta)).toBeNull();
    await expect(repo.assertTaskOmpProfile(meta, null)).resolves.toBeUndefined();
    await expect(repo.bindTaskOmpProfile(meta, "work")).rejects.toMatchObject({
      code: "omp.profileMismatch",
    });
  });

  it("原生事实及展示更新遗漏 binding 时保全，并跨 Host 重启保留", async () => {
    const meta = task({ taskId: "profile-persistent", offPeakTaskId: "marker" });
    await seedTaskIndex(repo, { meta });
    await repo.bindTaskOmpProfile(meta, "work");
    await repo.applyCliFacts({ meta: { ...meta, updatedAt: 30 } });
    await repo.updateTaskPresentation({ ...meta, presentation: { model: "new-model" } });
    repo.close();
    repo = new TaskIndexRepo();
    expect(await repo.getTaskMeta(meta)).toMatchObject({
      ompProfile: "work",
      model: "new-model",
      offPeakTaskId: "marker",
    });
  });

  it("异 profile 事实写入拒绝，原有标题与绑定不改变", async () => {
    const meta = { ...task({ taskId: "profile-conflict" }), ompProfile: "work" };
    await seedTaskIndex(repo, { meta });
    await expect(
      repo.applyCliFacts({ meta: { ...meta, title: "wrong profile", ompProfile: null } }),
    ).rejects.toMatchObject({ code: "omp.profileMismatch" });
    expect(await repo.getTaskMeta(meta)).toMatchObject({
      title: "profile-conflict",
      ompProfile: "work",
    });
  });

  it("不同 profile 与旧未知的历史行和标签全部保留", async () => {
    const first = task({ taskId: "profile-first", offPeakTaskId: "tag-first" });
    const second = task({ taskId: "profile-second", offPeakTaskId: "tag-second" });
    const unknown = task({ taskId: "profile-old" });
    await seedTaskIndex(repo, { meta: { ...first, ompProfile: null } });
    await seedTaskIndex(repo, { meta: { ...second, ompProfile: "work" } });
    await seedTaskIndex(repo, { meta: unknown });
    expect(await repo.listTaskMetas({ workspacePath: first.workspacePath })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: first.taskId,
          ompProfile: null,
          offPeakTaskId: "tag-first",
        }),
        expect.objectContaining({
          taskId: second.taskId,
          ompProfile: "work",
          offPeakTaskId: "tag-second",
        }),
        expect.objectContaining({ taskId: unknown.taskId }),
      ]),
    );
    await expect(repo.bindTaskOmpProfile({ ...first, taskId: "missing" }, "work")).rejects.toThrow(
      "不存在 task",
    );
  });
});

describe("TaskIndexRepo actual OMP storage domains", () => {
  it("两实际根和两运行 profile 使用真实 SQLite 保全项目、分组、排序及任务组织态", async () => {
    const firstRoot = join(tempDir, "native-a");
    const secondRoot = join(tempDir, "native-b");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    const scopes = [
      { configRoot: firstRoot, profileId: null },
      { configRoot: firstRoot, profileId: "work" },
      { configRoot: secondRoot, profileId: null },
      { configRoot: secondRoot, profileId: "work" },
    ];
    let actual = scopes[0]!;
    const resolveActual = async () => actual;
    repo.setOmpScopeResolver(resolveActual);
    const saved: Array<{ projectId: string; groupId: string; taskId: string; unreadAt: number }> =
      [];
    for (const [index, scope] of scopes.entries()) {
      actual = scope;
      const owner = await repo.forWorkspace({ workspacePath: "/workspace/project" });
      const projects = await owner.getProjectRepository();
      expect(projects.readTree().projects).toEqual([]);
      const project = projects.saveProject({
        roots: ["/workspace/project"],
        name: `domain-${index}`,
      });
      const meta = { ...task({ taskId: `domain-task-${index}` }), ompProfile: scope.profileId };
      projects.reserveCreatedTask({ task: meta, projectId: project.id });
      await repo.applyCliFacts({ meta, lastOutcome: "completed" });
      const sibling = {
        ...task({ taskId: `domain-sibling-${index}` }),
        ompProfile: scope.profileId,
      };
      await repo.applyCliFacts({ meta: sibling, lastOutcome: "completed" });
      const groups = new TaskGroupRepository(await owner.getOrganizationDatabase());
      const group = groups.save({ title: `group-${index}` });
      groups.move({
        node: { type: "task", task: { ...meta, hostId: "local" } },
        sourceGroupId: null,
        groupId: group.id,
      });
      groups.move({
        node: { type: "task", task: { ...sibling, hostId: "local" } },
        sourceGroupId: null,
        groupId: group.id,
        anchor: { node: { type: "task", task: { ...meta, hostId: "local" } }, side: "before" },
      });
      const updated = await repo.updateTaskState({
        ...meta,
        patch: { pinned: true, archived: index % 2 === 1, unreadAt: 100 + index },
      });
      saved.push({
        projectId: project.id,
        groupId: group.id,
        taskId: meta.taskId,
        unreadAt: updated.unreadAt!,
      });
      expect(
        (await repo.listTaskMetas({ workspacePath: meta.workspacePath }))
          .map((item) => item.taskId)
          .sort(),
      ).toEqual([meta.taskId, sibling.taskId].sort());
    }
    // 偏好保存不是原生重启；选择发生变化但实际域与其组织信息保持不变。
    actual = scopes[0]!;
    const settings = createSettingService();
    await settings.update({ ompProfileSelections: { "/workspace/project": "work" } });
    expect((await settings.get()).ompProfileSelections?.["/workspace/project"]).toBe("work");
    expect(actual.profileId).toBeNull();
    expect(
      (await repo.listTaskMetas({ workspacePath: "/workspace/project" })).map(
        (item) => item.taskId,
      ),
    ).toContain(saved[0]!.taskId);
    repo.close();
    repo = new TaskIndexRepo();
    repo.setOmpScopeResolver(resolveActual);
    for (const [index, scope] of scopes.entries()) {
      actual = scope;
      const record = saved[index]!;
      const owner = await repo.forWorkspace({ workspacePath: "/workspace/project" });
      const projects = await owner.getProjectRepository();
      expect(projects.readTree().projects.map((project) => project.id)).toEqual([record.projectId]);
      expect(projects.readTree().tasks.find((item) => item.taskId === record.taskId)).toMatchObject(
        {
          projectId: record.projectId,
          pinned: true,
          archived: index % 2 === 1,
          unreadAt: record.unreadAt,
        },
      );
      const structure = new TaskGroupRepository(await owner.getOrganizationDatabase()).read();
      expect(structure.groups.map((group) => group.id)).toEqual([record.groupId]);
      expect(structure.members.map((member) => member.taskId)).toEqual([
        `domain-sibling-${index}`,
        record.taskId,
      ]);
      expect(structure.members.map((member) => member.sortOrder)).toEqual([0, 1]);
      const list = await repo.queryTaskList({
        workspaceScopes: [{ workspacePath: "/workspace/project" }],
        kind: index % 2 === 1 ? "archived" : "pinned",
        sortBy: "updated",
      });
      expect(list.items.map((item) => item.taskId)).toEqual([record.taskId]);
      await expect(
        repo.assertTaskOmpProfile(
          { workspacePath: "/workspace/project", taskId: record.taskId },
          scope.profileId === null ? "work" : null,
        ),
      ).rejects.toMatchObject({ code: "omp.profileMismatch" });
      await expect(
        repo.assertTaskOmpProfile(
          {
            workspacePath: "/workspace/project",
            taskId: saved[(index + 1) % saved.length]!.taskId,
          },
          scope.profileId,
        ),
      ).rejects.toMatchObject({ code: "omp.profileUnknown" });
    }
  });

  it("同 Host 多 workspace 根据各自实际域查询，旧域连接不会混入全局置顶或分页", async () => {
    const a = { workspacePath: "/workspace/a", workspaceIdentity: "identity-a" };
    const b = { workspacePath: "/workspace/b", workspaceIdentity: "identity-b" };
    let aProfile: string | null = null;
    repo.setOmpScopeResolver(async (target) => ({
      configRoot: join(tempDir, "native-root"),
      profileId: target.workspaceIdentity === a.workspaceIdentity ? aProfile : "work",
    }));
    for (const [index, target] of [a, b].entries()) {
      await repo.applyCliFacts({
        meta: {
          ...task({ taskId: `task-${index}` }),
          ...target,
          ompProfile: index === 0 ? null : "work",
        },
      });
      await repo.updateTaskState({ ...target, taskId: `task-${index}`, patch: { pinned: true } });
    }
    expect((await repo.listTaskMetas({ pinned: true })).map((meta) => meta.taskId).sort()).toEqual([
      "task-0",
      "task-1",
    ]);
    aProfile = "work";
    expect(await repo.listTaskMetas({ ...a, pinned: true })).toEqual([]);
    expect((await repo.listTaskMetas({ pinned: true })).map((meta) => meta.taskId)).toEqual([
      "task-1",
    ]);
    const list = await repo.queryTaskList({
      workspaceScopes: [a, b],
      kind: "pinned",
      sortBy: "updated",
      limit: 1,
    });
    expect(list).toMatchObject({ total: 1, hasMore: false });
    expect(list.items.map((meta) => meta.taskId)).toEqual(["task-1"]);
    aProfile = null;
    expect((await repo.listTaskMetas({ ...a, pinned: true })).map((meta) => meta.taskId)).toEqual([
      "task-0",
    ]);
  });
  it("迟到原生事实不回写新运行域的活动投影，关闭 owner 后也不复活连接", async () => {
    const target = { workspacePath: "/workspace/project" };
    const oldScope = { configRoot: join(tempDir, "old-root"), profileId: null };
    const newScope = { configRoot: join(tempDir, "new-root"), profileId: "work" };
    const oldFacts = Promise.withResolvers<typeof oldScope>();
    let calls = 0;
    repo.setOmpScopeResolver(async () => (++calls === 1 ? oldFacts.promise : newScope));
    const delayed = repo.forWorkspace(target);
    const current = await repo.forWorkspace(target);
    await current.applyCliFacts({
      meta: { ...task({ taskId: "new-scope-task" }), ompProfile: "work" },
    });
    oldFacts.resolve(oldScope);
    await delayed;
    expect(repo.getActiveRepositories()).toEqual([current]);
    expect(
      (await repo.getActiveRepositories()[0]!.listTaskMetas(target)).map((meta) => meta.taskId),
    ).toEqual(["new-scope-task"]);
    const pending = Promise.withResolvers<typeof oldScope>();
    repo.setOmpScopeResolver(() => pending.promise);
    const closedRequest = repo.forWorkspace(target);
    repo.close();
    pending.resolve(oldScope);
    await expect(closedRequest).rejects.toMatchObject({ code: "omp.storageScopeChanged" });
    expect(repo.getActiveRepositories()).toEqual([]);
  });
});
