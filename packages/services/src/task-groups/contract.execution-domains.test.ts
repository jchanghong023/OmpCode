import { DatabaseSync } from "@zcode/shared/sqlite-migrations";
import { afterEach, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskGroupService, TaskGroupRepository } from "#src/task-groups/index.js";
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
