import { expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";
import type { ProjectTask, ProjectTree } from "#src/project-storage/contract.js";

it("windows CLI activity inclusively, retains scoped exceptions and pages without writing tombstones", async () => {
  const { db, add, context } = await fixture();
  for (const id of ["boundary", "recent", "old", "pinned", "opened", "deleted", "archived"])
    add(id, "/repo");
  const otherIdentity = "remote:ssh:other:22:user:/repo";
  // 同 Host 的 taskId 必须唯一；用不同 ID 保留跨 identity 的例外匹配反例。
  add("foreign-opened", "/repo", otherIdentity);
  await port.migrate(db, context);
  db.exec(`UPDATE tasks SET cli_updated_at=9,updated_at=9999;
    UPDATE tasks SET cli_updated_at=10 WHERE task_id='boundary';
    UPDATE tasks SET cli_updated_at=11 WHERE task_id='recent';
    UPDATE tasks SET pinned=1 WHERE task_id='pinned';
    UPDATE tasks SET archived=1 WHERE task_id='archived';
    UPDATE tasks SET deleted=1 WHERE task_id='deleted';`);
  db.prepare("UPDATE tasks SET host_id='local' WHERE workspace_key=?").run(otherIdentity);
  const repository = port.repository(db);
  const before = db.prepare("SELECT total_changes() AS count").get();
  const query = {
    updatedSince: 10,
    taskLimit: 2,
    includeDeletedTasks: true,
    includeTaskIds: [
      { workspacePath: "/repo", taskId: "opened" },
      { workspacePath: "/repo", taskId: "foreign-opened" },
    ],
  };
  const tasks: ProjectTask[] = [];
  let cursor: ProjectTree["nextTaskCursor"];
  do {
    const page = repository.readTree({ ...query, taskCursor: cursor });
    tasks.push(...page.tasks);
    cursor = page.nextTaskCursor;
    expect(page.tasks.length).toBeLessThanOrEqual(2);
    expect(page.deletedTasks?.map((task) => task.taskId)).toContain("deleted");
  } while (cursor);
  expect(tasks.map((task) => task.taskId).sort()).toEqual([
    "boundary",
    "opened",
    "pinned",
    "recent",
  ]);
  expect(tasks.find((task) => task.taskId === "opened")?.workspaceIdentity).toBeUndefined();
  expect(repository.readTree().tasks.map((task) => task.taskId)).toContain("archived");
  expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
});
