import assert from "node:assert/strict";
import test from "node:test";
import {
  zcodeWorkspaceTaskListChangedSchema,
  zcodeTaskMetaSchema,
  workspaceTaskListInvalidatedEventSchema,
} from "../src/index.js";

const event = {
  type: "workspace_task_list_changed",
  workspacePath: "/same/path",
  workspaceIdentity: "remote-a",
  taskId: "uuid-task",
  reason: "task_meta_changed",
  taskIdMigration: { fromTaskId: "omp-session-temp", toTaskId: "uuid-task" },
} as const;

test("task migration survives the existing workspace event JSON boundary", () => {
  assert.deepEqual(
    zcodeWorkspaceTaskListChangedSchema.parse(JSON.parse(JSON.stringify(event))),
    event,
  );
  assert.ok(
    zcodeWorkspaceTaskListChangedSchema.safeParse({ ...event, taskIdMigration: undefined }).success,
  );
});

test("persisted/realtime metadata preserves migration and validates its canonical ID", () => {
  const meta = {
    taskId: "uuid-task",
    traceId: "trace",
    title: "task",
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    taskIdMigration: event.taskIdMigration,
  };
  assert.deepEqual(zcodeTaskMetaSchema.parse(meta).taskIdMigration, event.taskIdMigration);
  assert.equal(zcodeTaskMetaSchema.safeParse({ ...meta, taskId: "wrong" }).success, false);
  const envelope = {
    type: "workspace_task_list_invalidated",
    eventId: "event",
    workspacePath: "/workspace",
    workspaceKey: "/workspace",
    traceId: "trace",
    createdAt: 1,
    reason: "task_meta_changed",
    taskMeta: meta,
  };
  assert.deepEqual(
    workspaceTaskListInvalidatedEventSchema.parse(envelope).taskMeta?.taskIdMigration,
    event.taskIdMigration,
  );
  assert.equal(
    workspaceTaskListInvalidatedEventSchema.safeParse({
      ...envelope,
      taskMeta: { ...meta, taskId: "wrong" },
    }).success,
    false,
  );
});

test("migration rejects unknown fields, empty/self IDs, wrong destination and remote scope", () => {
  for (const invalid of [
    { ...event, taskIdMigration: { ...event.taskIdMigration, extra: true } },
    { ...event, taskIdMigration: { fromTaskId: " ", toTaskId: "uuid-task" } },
    { ...event, taskIdMigration: { fromTaskId: "uuid-task", toTaskId: "uuid-task" } },
    { ...event, taskId: "other-task" },
    {
      ...event,
      taskMeta: {
        taskId: "uuid-task",
        traceId: "trace",
        title: "task",
        workspacePath: "/same/path",
        workspaceIdentity: "remote-b",
        createdAt: 1,
        updatedAt: 1,
        mode: "build",
      },
    },
  ])
    assert.equal(zcodeWorkspaceTaskListChangedSchema.safeParse(invalid).success, false);
});
