import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { TaskGroupRepository, createTaskGroupService } from "#src/task-groups/index.js";
import type { GroupTaskRef } from "#src/task-groups/contract.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

export async function fixture() {
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

export const taskNode = (task: GroupTaskRef) => ({ type: "task" as const, task });

export function builtInDomainService(a: { db: DatabaseSync }, b: { db: DatabaseSync }) {
  return createTaskGroupService({
    database: async (target) =>
      target.workspacePath === "/a"
        ? { database: a.db, storageScope: "a" }
        : { database: b.db, storageScope: "b" },
    resolveTasks: async (refs) => refs.map((ref) => ({ ...ref, cronAutomationId: "cron" })),
    afterChange: async () => {},
  });
}
