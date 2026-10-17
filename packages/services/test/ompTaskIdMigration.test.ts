import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
    assert.deepEqual(migrated?.taskIdMigration, { fromTaskId, toTaskId });
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

test("committed identity survives cold list/grouped reads and cannot be forged by snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-task-rekey-"));
  const path = join(root, "tasks.sqlite");
  let repo = new TaskIndexRepo(path);
  const scope = { workspacePath: join(root, "workspace"), workspaceIdentity: "remote-a" };
  const fromTaskId = "omp-session-original";
  const toTaskId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
  const originalMeta = {
    ...scope,
    taskId: fromTaskId,
    traceId: "trace",
    title: "task",
    createdAt: 1,
    updatedAt: 1,
    mode: "build" as const,
    provider: "glm" as const,
  };
  try {
    const forged = { fromTaskId: "forged", toTaskId: fromTaskId };
    assert.equal(
      (await repo.syncTaskMeta({ meta: { ...originalMeta, taskIdMigration: forged } }))
        .taskIdMigration,
      undefined,
    );
    const migrated = await repo.rekeyTaskId({ ...scope, fromTaskId, toTaskId });
    assert.ok(migrated);
    const migration = { fromTaskId, toTaskId };
    assert.deepEqual(migrated.taskIdMigration, migration);
    assert.deepEqual(
      (await repo.rekeyTaskId({ ...scope, fromTaskId, toTaskId }))?.taskIdMigration,
      migration,
    );
    const synchronized = await repo.syncTaskMeta({
      meta: { ...migrated, updatedAt: 2, taskIdMigration: { fromTaskId: "forged", toTaskId } },
    });
    assert.deepEqual(synchronized.taskIdMigration, migration);
    assert.deepEqual(
      (await repo.syncTaskMeta({ meta: { ...migrated, updatedAt: 3, taskIdMigration: undefined } }))
        .taskIdMigration,
      migration,
    );
    repo.close();
    repo = new TaskIndexRepo(path);
    assert.deepEqual(
      (await repo.getTaskMeta({ ...scope, taskId: toTaskId }))?.taskIdMigration,
      migration,
    );
    const list = await repo.queryTaskList({
      kind: "timeline",
      workspaceScopes: [scope],
      sortBy: "updated",
    });
    assert.deepEqual(
      list.items.find((item) => item.taskId === toTaskId)?.taskIdMigration,
      migration,
    );
    const grouped = await repo.queryGroupedTaskView({ workspaceScopes: [scope] });
    const groupedTasks = grouped.nodes.flatMap((node) =>
      node.type === "group" ? node.tasks : [node.task],
    );
    assert.deepEqual(
      groupedTasks.find((item) => item.taskId === toTaskId)?.taskIdMigration,
      migration,
    );
    const otherScope = { ...scope, workspaceIdentity: "remote-b" };
    await repo.syncTaskMeta({ meta: { ...originalMeta, ...otherScope, taskId: toTaskId } });
    assert.equal(
      (await repo.getTaskMeta({ ...otherScope, taskId: toTaskId }))?.taskIdMigration,
      undefined,
    );
    assert.equal(
      (
        await repo.seedTaskMetaIfMissing({
          ...originalMeta,
          taskId: "untrusted-seed",
          taskIdMigration: { fromTaskId, toTaskId: "untrusted-seed" },
        })
      ).taskIdMigration,
      undefined,
    );
  } finally {
    repo.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("omp-task-rekey-"));
    await rm(root, { recursive: true, force: true });
  }
});

for (const targetExists of [false, true]) {
  test(`missing temp row cannot manufacture a committed migration (UUID exists: ${targetExists})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-task-rekey-"));
    const path = join(root, "tasks.sqlite");
    let repo = new TaskIndexRepo(path);
    const scope = { workspacePath: join(root, "workspace"), workspaceIdentity: "remote-a" };
    const fromTaskId = "omp-session-native-first";
    const toTaskId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
    try {
      if (targetExists) {
        await repo.syncTaskMeta({
          meta: {
            ...scope,
            taskId: toTaskId,
            traceId: "uuid-trace",
            title: "native first input",
            createdAt: 1,
            updatedAt: 2,
            mode: "build",
            provider: "glm",
          },
        });
      }
      const result = await repo.rekeyTaskId({ ...scope, fromTaskId, toTaskId });
      assert.equal(result?.taskIdMigration, undefined, "no source row was transactionally moved");
      assert.equal(result?.taskId ?? null, targetExists ? toTaskId : null);
      assert.equal(await repo.getTaskMeta({ ...scope, taskId: fromTaskId }), null);
      repo.close();
      repo = new TaskIndexRepo(path);
      const list = await repo.queryTaskList({
        kind: "timeline",
        workspaceScopes: [scope],
        sortBy: "updated",
      });
      assert.deepEqual(
        list.items.map((item) => item.taskId),
        targetExists ? [toTaskId] : [],
      );
      assert.ok(list.items.every((item) => item.taskIdMigration === undefined));
      const grouped = await repo.queryGroupedTaskView({ workspaceScopes: [scope] });
      const tasks = grouped.nodes.flatMap((node) =>
        node.type === "group" ? node.tasks : [node.task],
      );
      assert.deepEqual(
        tasks.map((item) => item.taskId),
        targetExists ? [toTaskId] : [],
      );
      assert.ok(tasks.every((item) => item.taskIdMigration === undefined));
    } finally {
      repo.close();
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("omp-task-rekey-"));
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const targetExists of [false, true]) {
  test(`owned alias without source waits for the committed scoped UUID (exists: ${targetExists})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-task-rekey-"));
    const path = join(root, "tasks.sqlite");
    let repo = new TaskIndexRepo(path);
    const scope = { workspacePath: join(root, "workspace"), workspaceIdentity: "remote-a" };
    const otherScope = { ...scope, workspaceIdentity: "remote-b" };
    const fromTaskId = "omp-session-owned-native";
    const toTaskId = "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c";
    const migration = { fromTaskId, toTaskId };
    const canonicalMeta = {
      ...scope,
      taskId: toTaskId,
      traceId: "trace-uuid",
      title: "native first input",
      createdAt: 1,
      updatedAt: 2,
      mode: "build" as const,
      provider: "glm" as const,
    };
    const params = { ...scope, ...migration, isCurrent: () => true };
    try {
      // A target in another remote workspace is not a committed target in this scope.
      await repo.syncTaskMeta({ meta: { ...canonicalMeta, ...otherScope } });
      assert.equal(await repo.commitOwnedTaskIdAlias(params), null);
      if (targetExists) await repo.syncTaskMeta({ meta: canonicalMeta });
      const first = await repo.commitOwnedTaskIdAlias(params);
      if (targetExists) assert.deepEqual(first?.taskIdMigration, migration);
      else {
        assert.equal(first, null);
        await repo.syncTaskMeta({ meta: canonicalMeta });
      }
      const committed = await repo.commitOwnedTaskIdAlias(params);
      assert.deepEqual(committed?.taskIdMigration, migration);
      assert.deepEqual((await repo.commitOwnedTaskIdAlias(params))?.taskIdMigration, migration);
      assert.equal(
        await repo.commitOwnedTaskIdAlias({ ...params, fromTaskId: "omp-session-unrelated" }),
        null,
        "a later alias must not replace the committed tuple",
      );
      assert.equal(await repo.getTaskMeta({ ...scope, taskId: fromTaskId }), null);
      assert.equal(
        (await repo.getTaskMeta({ ...otherScope, taskId: toTaskId }))?.taskIdMigration,
        undefined,
      );
      assert.deepEqual(
        (
          await repo.syncTaskMeta({
            meta: {
              ...canonicalMeta,
              taskIdMigration: { fromTaskId: "forged", toTaskId },
            },
          })
        ).taskIdMigration,
        migration,
      );
      repo.close();
      repo = new TaskIndexRepo(path);
      assert.deepEqual(
        (await repo.getTaskMeta({ ...scope, taskId: toTaskId }))?.taskIdMigration,
        migration,
      );
      const list = await repo.queryTaskList({
        kind: "timeline",
        workspaceScopes: [scope],
        sortBy: "updated",
      });
      assert.deepEqual(
        list.items.map((item) => [item.taskId, item.taskIdMigration]),
        [[toTaskId, migration]],
      );
      const grouped = await repo.queryGroupedTaskView({ workspaceScopes: [scope] });
      assert.deepEqual(
        grouped.nodes.flatMap((node) =>
          node.type === "group"
            ? node.tasks.map((task) => [task.taskId, task.taskIdMigration])
            : [[node.task.taskId, node.task.taskIdMigration]],
        ),
        [[toTaskId, migration]],
      );
    } finally {
      repo.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("owned alias rejects stale ownership and rolls back a failed migration write", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-task-rekey-"));
  const path = join(root, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  const scope = { workspacePath: join(root, "workspace") };
  const migration = {
    fromTaskId: "omp-session-owned-native",
    toTaskId: "01a0d6d2-37bb-73c0-b13b-9f4fb3ea388c",
  };
  try {
    await repo.syncTaskMeta({
      meta: {
        ...scope,
        taskId: migration.toTaskId,
        traceId: "trace",
        title: "canonical",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        provider: "glm",
      },
    });
    let checks = 0;
    assert.equal(
      await repo.commitOwnedTaskIdAlias({
        ...scope,
        ...migration,
        isCurrent: () => ++checks < 3,
      }),
      null,
      "ownership is checked again inside the transaction, not just before queueing",
    );
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TRIGGER fail_owned_alias BEFORE UPDATE OF meta_json ON tasks
        WHEN json_extract(NEW.meta_json, '$.taskIdMigration') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'owned alias commit rejected'); END;
      `);
      await assert.rejects(
        repo.commitOwnedTaskIdAlias({ ...scope, ...migration, isCurrent: () => true }),
        /owned alias commit rejected/,
      );
    } finally {
      db.close();
    }
    repo.close();
    assert.equal(
      (await repo.getTaskMeta({ ...scope, taskId: migration.toTaskId }))?.taskIdMigration,
      undefined,
    );
    assert.equal(await repo.getTaskMeta({ ...scope, taskId: migration.fromTaskId }), null);
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
