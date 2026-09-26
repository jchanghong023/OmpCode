import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

test("omp 临时任务迁移 UUID 时保留产品壳状态和分组顺序", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-task-rekey-"));
  const path = join(root, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  const workspacePath = join(root, "workspace");
  const fromTaskId = "omp-session-temp";
  const toTaskId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  try {
    await repo.syncTaskMeta({
      meta: {
        taskId: fromTaskId,
        traceId: "trace-temp",
        title: "原任务",
        workspacePath,
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        provider: "glm",
        cronAutomationId: "cron-1",
      },
    });
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE tasks SET pinned = 1, archived = 1, unread_at = 42 WHERE task_id = ?").run(
        fromTaskId,
      );
      db.prepare(
        "INSERT INTO task_groups (group_id, title, created_at, updated_at) VALUES ('custom', '自定义', 1, 1)",
      ).run();
      db.prepare(
        "UPDATE task_group_members SET group_id = 'custom' WHERE workspace_key = ? AND task_id = ?",
      ).run(workspacePath, fromTaskId);
      db.prepare(
        "INSERT INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at) VALUES ('task', ?, 7, 1, 1)",
      ).run(JSON.stringify([workspacePath, fromTaskId]));
    } finally {
      db.close();
    }
    const migrated = await repo.rekeyTaskId({ workspacePath, fromTaskId, toTaskId });
    assert.equal(migrated?.cronAutomationId, "cron-1");
    assert.equal(migrated?.unreadAt, 42);
    assert.equal(await repo.getTaskMeta({ workspacePath, taskId: fromTaskId }), null);
    const verify = new DatabaseSync(path);
    try {
      const row = verify
        .prepare(
          "SELECT pinned, archived, cron_automation_id, unread_at, meta_json FROM tasks WHERE task_id = ?",
        )
        .get(toTaskId) as {
        pinned: number;
        archived: number;
        cron_automation_id: string;
        unread_at: number;
        meta_json: string;
      };
      assert.deepEqual(
        [row.pinned, row.archived, row.cron_automation_id, row.unread_at],
        [1, 1, "cron-1", 42],
      );
      assert.equal(JSON.parse(row.meta_json).taskId, toTaskId);
      assert.equal(
        (
          verify
            .prepare("SELECT task_id FROM task_group_members WHERE group_id = 'custom'")
            .get() as {
            task_id: string;
          }
        ).task_id,
        toTaskId,
      );
      assert.equal(
        (
          verify
            .prepare(
              "SELECT sort_order FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
            )
            .get(JSON.stringify([workspacePath, toTaskId])) as { sort_order: number }
        ).sort_order,
        7,
      );
    } finally {
      verify.close();
    }
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
