import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAppConfigDir, getTasksIndexDatabasePath, setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

test("omp profiles have separate task index projections", () => {
  const root = getAppConfigDir();
  assert.equal(
    getTasksIndexDatabasePath({ OMP_PROFILE: "default" }),
    join(root, "tasks-index.sqlite"),
  );
  assert.equal(
    getTasksIndexDatabasePath({ OMP_PROFILE: "work" }),
    join(root, "tasks-index-omp-work.sqlite"),
  );
  assert.equal(
    getTasksIndexDatabasePath({ OMP_PROFILE: "personal" }),
    join(root, "tasks-index-omp-personal.sqlite"),
  );
  assert.equal(
    getTasksIndexDatabasePath({ PI_PROFILE: "legacy" }),
    join(root, "tasks-index-omp-legacy.sqlite"),
  );
  assert.equal(
    getTasksIndexDatabasePath({ OMP_PROFILE: "", PI_PROFILE: "legacy" }),
    join(root, "tasks-index.sqlite"),
  );
  assert.throws(
    () => getTasksIndexDatabasePath({ OMP_PROFILE: "../escape" }),
    /omp_profile_invalid/,
  );
});

test("restarting into another omp profile shows only its task projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-profile-index-"));
  setDataBaseDir(root);
  const defaultRepo = new TaskIndexRepo(getTasksIndexDatabasePath({ OMP_PROFILE: "default" }));
  const workRepo = new TaskIndexRepo(getTasksIndexDatabasePath({ OMP_PROFILE: "work" }));
  try {
    const baseMeta = {
      traceId: "profile-e2e",
      workspacePath: join(root, "workspace"),
      createdAt: 1,
      updatedAt: 2,
      mode: "build" as const,
      provider: "glm" as const,
    };
    await defaultRepo.syncTaskMeta({
      meta: { ...baseMeta, taskId: "default-task", title: "Default task" },
    });
    await workRepo.syncTaskMeta({ meta: { ...baseMeta, taskId: "work-task", title: "Work task" } });
    assert.deepEqual(
      (await workRepo.listTaskMetas({})).map((item) => item.taskId),
      ["work-task"],
    );
    defaultRepo.close();
    await defaultRepo.ensureReady();
    assert.deepEqual(
      (await defaultRepo.listTaskMetas({})).map((item) => item.taskId),
      ["default-task"],
    );
  } finally {
    defaultRepo.close();
    workRepo.close();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
});
