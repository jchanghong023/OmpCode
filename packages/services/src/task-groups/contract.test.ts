import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGroupRepository } from "#src/task-groups/index.js";
import type { GroupTaskRef } from "#src/task-groups/contract.js";
import { CRON_DEFAULT_GROUP_ID } from "@zcode/shared";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const directory = await mkdtemp(join(tmpdir(), "task-groups-test-"));
  directories.push(directory);
  await runTasksDatabaseMigrations(db, join(directory, "tasks.sqlite"));
  let time = 100;
  const repo = new TaskGroupRepository(db, () => ++time);
  const task = (id: string, hostId = "local"): GroupTaskRef => ({
    taskId: id,
    hostId,
    workspacePath: "/repo",
    ...(hostId === "local" ? {} : { workspaceIdentity: "remote:server:other:/repo" }),
  });
  return { db, repo, task };
}
const taskNode = (task: GroupTaskRef) => ({ type: "task" as const, task });
describe("controller-owned task groups", async () => {
  it("reads legacy empty groups without bootstrap or writes", async () => {
    const { db, repo } = await fixture();
    db.exec("INSERT INTO task_groups VALUES ('old','Old','blue',1,2)");
    const before = db.prepare("SELECT total_changes() AS n").get();
    expect(repo.read().groups).toEqual([
      { id: "old", title: "Old", color: "blue", createdAt: 1, updatedAt: 2 },
    ]);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.prepare("SELECT * FROM task_group_workspace_bootstraps").all()).toEqual([]);
  });
  it("organizes local and remote tasks independently without changing task facts", async () => {
    const { db, repo, task } = await fixture();
    const a = task("same"),
      b = task("same", "remote:server:other");
    repo.admit([a, b]);
    const group = repo.save({ title: "Mixed", color: "purple" });
    for (const ref of [a, b])
      repo.move({ node: taskNode(ref), sourceGroupId: null, groupId: group.id });
    expect(repo.read().members).toHaveLength(2);
    expect(new Set(repo.read().members.map((m) => m.workspaceKey)).size).toBe(2);
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual([]);
    repo.ungroup(group.id);
    expect(repo.read().members).toEqual([]);
    expect(repo.read().order.filter((n) => n.type === "task")).toHaveLength(2);
  });
  it("preserves invisible members and rejects stale source or anchors atomically", async () => {
    const { repo, task } = await fixture();
    const a = task("a"),
      hidden = task("hidden"),
      b = task("b");
    repo.admit([a, hidden, b]);
    const first = repo.save({ title: "First" }),
      second = repo.save({ title: "Second" });
    for (const ref of [a, hidden])
      repo.move({ node: taskNode(ref), sourceGroupId: null, groupId: first.id });
    repo.move({ node: taskNode(a), sourceGroupId: first.id, groupId: second.id });
    expect(repo.read().members.find((m) => m.taskId === "hidden")?.groupId).toBe(first.id);
    const before = repo.read();
    expect(() => repo.move({ node: taskNode(a), sourceGroupId: first.id, groupId: null })).toThrow(
      "stale",
    );
    expect(() =>
      repo.move({
        node: taskNode(b),
        sourceGroupId: null,
        groupId: first.id,
        anchor: { node: taskNode(a), side: "after" },
      }),
    ).toThrow("anchor");
    expect(repo.read()).toEqual(before);
  });
  it("registers system tasks once and never undoes explicit ungrouping", async () => {
    const { repo, task } = await fixture();
    const ref = task("cron");
    repo.admit([ref]);
    repo.admit([{ ...ref, cronAutomationId: "schedule" }]);
    expect(repo.read().members[0]?.groupId).toBe(CRON_DEFAULT_GROUP_ID);
    repo.move({ node: taskNode(ref), sourceGroupId: CRON_DEFAULT_GROUP_ID, groupId: null });
    repo.admit([{ ...ref, cronAutomationId: "schedule" }]);
    expect(repo.read().members).toEqual([]);
    repo.ungroup(CRON_DEFAULT_GROUP_ID);
    repo.admit([{ ...ref, cronAutomationId: "schedule" }]);
    expect(repo.read().groups).toEqual([]);
  });
  it("does not autoassign a late system marker after a manual placement", async () => {
    const { repo, task } = await fixture();
    const ref = task("manual");
    repo.admit([ref]);
    const group = repo.save({ title: "Manual" });
    repo.move({ node: taskNode(ref), sourceGroupId: null, groupId: group.id });
    repo.move({ node: taskNode(ref), sourceGroupId: group.id, groupId: null });
    repo.admit([{ ...ref, cronAutomationId: "late" }]);
    expect(repo.read().members).toEqual([]);
  });
  it("applies creation placement once and falls back to root only when its group is gone", async () => {
    const { repo, task } = await fixture();
    const ref = task("new"),
      group = repo.save({ title: "Draft" });
    const placement = { task: ref, groupId: group.id, creationId: "create-one" };
    repo.admit([ref], placement);
    repo.move({ node: taskNode(ref), sourceGroupId: group.id, groupId: null });
    repo.admit([ref], placement);
    expect(repo.read().members).toEqual([]);
    repo.ungroup(group.id);
    repo.admit([task("late")], { ...placement, task: task("late"), creationId: "create-two" });
    expect(repo.read().members).toEqual([]);
    expect(repo.read().groups).toEqual([]);
  });
  it("keeps archive membership but removes only explicitly deleted references", async () => {
    const { repo, task } = await fixture();
    const ref = task("kept"),
      group = repo.save({ title: "Keep" });
    repo.admit([ref], { task: ref, groupId: group.id, creationId: "create" });
    repo.admit([{ ...ref, archived: true }]);
    repo.admit([]);
    expect(repo.read().members).toHaveLength(1);
    repo.admit([{ ...ref, deleted: true }]);
    expect(repo.read().members).toEqual([]);
    expect(repo.read().order.filter((n) => n.type === "task")).toEqual([]);
  });
  it("ungroups at the original block position including hidden members", async () => {
    const { repo, task } = await fixture();
    const refs = [task("a"), task("hidden"), task("tail")];
    repo.admit(refs);
    const group = repo.save({ title: "Block" });
    for (const ref of refs.slice(0, 2))
      repo.move({ node: taskNode(ref), sourceGroupId: null, groupId: group.id });
    repo.ungroup(group.id);
    const order = repo
      .read()
      .order.filter((n) => n.type === "task")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    expect(order.map((n) => JSON.parse(n.key)[1])).toEqual(["hidden", "a", "tail"]);
  });
});

import { createTaskGroupService } from "#src/task-groups/index.js";
it("validates identities and current task facts before a controller write", async () => {
  const { db, repo, task } = await fixture();
  const group = repo.save({ title: "Target" });
  const ref = task("real");
  const service = createTaskGroupService({
    database: async () => ({ database: db, storageScope: "scope-a" }),
    resolveTasks: async (refs) => refs.filter((r) => r.taskId === ref.taskId),
    afterChange: async () => {},
  });
  await expect(
    service.move({
      target: { workspacePath: "/repo" },
      node: taskNode(task("missing")),
      sourceGroupId: null,
      groupId: group.id,
    }),
  ).rejects.toThrow("unavailable");
  await expect(service.admit({ tasks: [{ ...ref, hostId: "wrong" }] })).rejects.toThrow("mismatch");
  await service.admit({ tasks: [ref] });
  await service.move({
    target: { workspacePath: "/repo" },
    node: taskNode(ref),
    sourceGroupId: null,
    groupId: group.id,
  });
  expect(repo.read().members).toHaveLength(1);
});

it("rejects a mismatched authority result even when the task count matches", async () => {
  const { db, repo, task } = await fixture();
  const group = repo.save({ title: "Target" });
  const service = createTaskGroupService({
    database: async () => ({ database: db, storageScope: "scope-a" }),
    resolveTasks: async () => [{ ...task("requested"), workspacePath: "/wrong" }],
    afterChange: async () => {},
  });
  await expect(
    service.move({
      target: { workspacePath: "/repo" },
      node: taskNode(task("requested")),
      sourceGroupId: null,
      groupId: group.id,
    }),
  ).rejects.toThrow("unavailable");
  expect(repo.read().members).toEqual([]);
});
it("initial discovery keeps newest-created tasks first without reordering known tasks", async () => {
  const { repo, task } = await fixture();
  repo.admit([
    { ...task("new"), createdAt: 30 },
    { ...task("old"), createdAt: 10 },
    { ...task("middle"), createdAt: 20 },
  ]);
  expect(repo.read().order.map((n) => JSON.parse(n.key)[1])).toEqual(["new", "middle", "old"]);
  const before = repo.read();
  repo.admit([
    { ...task("old"), createdAt: 10 },
    { ...task("new"), createdAt: 30 },
  ]);
  expect(repo.read()).toEqual(before);
});

it("routes groups, membership, order and deletion only to actual active execution domains", async () => {
  const a = await fixture(),
    b = await fixture();
  const targetA = { workspacePath: "/a" },
    targetOtherA = { workspacePath: "/a-other" };
  const targetB = { workspacePath: "/b" };
  const refA = { ...a.task("same"), ...targetA };
  const otherA = { ...a.task("other"), ...targetOtherA };
  const refB = { ...b.task("same"), ...targetB };
  let profileA = true;
  let changes = 0;
  const service = createTaskGroupService({
    database: async (target) => {
      if (target.workspacePath === "/a" || target.workspacePath === "/a-other")
        return profileA
          ? { database: a.db, storageScope: "root-a/profile-a" }
          : { database: b.db, storageScope: "root-b/profile-b" };
      if (target.workspacePath === "/b")
        return { database: b.db, storageScope: "root-b/profile-b" };
      throw new Error("unknown-workspace");
    },
    resolveTasks: async (refs) => refs,
    afterChange: async () => {
      changes++;
    },
  });
  const groupA = await service.save({ target: targetA, title: "Same" });
  const groupB = await service.save({ target: targetB, title: "Same" });
  await service.admit({ tasks: [refA, otherA, refB] });
  await service.move({
    target: targetOtherA,
    node: taskNode(refA),
    sourceGroupId: null,
    groupId: groupA.id,
  });
  await service.move({
    target: targetA,
    node: taskNode(otherA),
    sourceGroupId: null,
    groupId: groupA.id,
    anchor: { node: taskNode(refA), side: "after" },
  });
  await service.move({
    target: targetB,
    node: taskNode(refB),
    sourceGroupId: null,
    groupId: groupB.id,
  });
  expect(a.repo.read().members.map((m) => m.taskId)).toEqual(["same", "other"]);
  expect(b.repo.read().members.map((m) => m.taskId)).toEqual(["same"]);
  const domains = await service.read([targetA, targetOtherA, targetB]);
  expect(domains.map((d) => d.storageScope)).toEqual(["root-a/profile-a", "root-b/profile-b"]);
  expect(domains).toHaveLength(2);
  expect(domains.map((d) => d.targets)).toEqual([[targetA, targetOtherA], [targetB]]);
  expect((await service.read([targetA]))[0]?.groups).toEqual([groupA]);
  const beforeA = a.repo.read(),
    beforeB = b.repo.read(),
    beforeChanges = changes;
  await expect(
    service.move({
      target: targetB,
      node: taskNode(refA),
      sourceGroupId: groupA.id,
      groupId: groupB.id,
    }),
  ).rejects.toThrow("cross-scope");
  await expect(
    service.move({
      target: targetA,
      node: taskNode(otherA),
      sourceGroupId: groupA.id,
      groupId: null,
      anchor: { node: taskNode(refB), side: "after" },
    }),
  ).rejects.toThrow("cross-scope");
  await expect(service.save({ target: targetB, id: groupA.id, title: "Wrong" })).rejects.toThrow(
    "not-found",
  );
  await expect(service.ungroup({ target: targetB, id: groupA.id })).rejects.toThrow("not-found");
  expect(a.repo.read()).toEqual(beforeA);
  expect(b.repo.read()).toEqual(beforeB);
  expect(changes).toBe(beforeChanges);
  profileA = false;
  expect((await service.read([targetA]))[0]?.groups).toEqual([groupB]);
  profileA = true;
  expect((await service.read([targetA]))[0]).toMatchObject(beforeA);
  await service.ungroup({ target: targetA, id: groupA.id });
  expect(a.repo.read().groups).toEqual([]);
  expect(a.repo.read().members).toEqual([]);
  expect(b.repo.read()).toEqual(beforeB);
  await expect(service.read([{ workspacePath: "/unknown" }])).rejects.toThrow("unknown-workspace");
  await expect(
    service.save({ target: { workspacePath: "/unknown" }, title: "No fallback" }),
  ).rejects.toThrow("unknown-workspace");
  expect(await service.read([])).toEqual([]);
  // @ts-expect-error 旧的无 workspace 创建调用必须在运行时拒绝，不能落入默认数据库。
  await expect(service.save({ title: "Missing target" })).rejects.toThrow();
});

it("keeps identical built-in group IDs separate across execution domains", async () => {
  const a = await fixture(),
    b = await fixture();
  const service = createTaskGroupService({
    database: async (target) =>
      target.workspacePath === "/a"
        ? { database: a.db, storageScope: "a" }
        : { database: b.db, storageScope: "b" },
    resolveTasks: async (refs) => refs.map((ref) => ({ ...ref, cronAutomationId: "cron" })),
    afterChange: async () => {},
  });
  await service.admit({
    tasks: [
      { ...a.task("cron"), workspacePath: "/a" },
      { ...b.task("cron"), workspacePath: "/b" },
    ],
  });
  const domains = await service.read([{ workspacePath: "/a" }, { workspacePath: "/b" }]);
  expect(domains.map((d) => d.groups[0]?.id)).toEqual([
    CRON_DEFAULT_GROUP_ID,
    CRON_DEFAULT_GROUP_ID,
  ]);
  await service.ungroup({ target: { workspacePath: "/a" }, id: CRON_DEFAULT_GROUP_ID });
  expect(a.repo.read().members).toEqual([]);
  expect(b.repo.read().members).toHaveLength(1);
});
