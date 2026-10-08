import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

test("任务索引按有效 OMP 根目录和 profile 隔离，默认根保持旧路径", () => {
  const root = join(tmpdir(), "omp-root-index");
  const custom = getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: root });
  const original = getTasksIndexDatabasePath({});
  assert.notEqual(custom, original);
  assert.notEqual(custom, getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: `${root}-other` }));
  assert.notEqual(
    custom,
    getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: root, OMP_PROFILE: "work" }),
  );
  assert.equal(custom, getTasksIndexDatabasePath({ PI_CONFIG_DIR: root }));
  assert.equal(
    custom,
    getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: ` ${root}/ `, PI_CONFIG_DIR: "ignored" }),
  );
  assert.equal(
    custom,
    getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: "relative", PI_CONFIG_DIR: root }),
  );
  assert.equal(
    getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: "~/root-index" }),
    getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: join(homedir(), "root-index") }),
  );
  assert.equal(original, getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: join(homedir(), ".omp") }));
  for (const OMP_CONFIG_ROOT of ["", " ", "relative", "../relative"]) {
    assert.equal(original, getTasksIndexDatabasePath({ OMP_CONFIG_ROOT }));
  }
  if (process.platform === "win32") {
    assert.equal(custom, getTasksIndexDatabasePath({ OMP_CONFIG_ROOT: root.toUpperCase() }));
  }
});

test("切换 OMP 根目录不显示旧 UUID，切回后保留任务组织信息", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-root-index-"));
  setDataBaseDir(root);
  const environments = [
    {},
    { OMP_CONFIG_ROOT: join(root, "omp-a") },
    { OMP_CONFIG_ROOT: join(root, "omp-b") },
  ];
  const workspacePath = join(root, "workspace");
  const taskId = "01a11a4d-abf8-7721-a10f-c36fb542a031";
  let repo: TaskIndexRepo | null = null;
  try {
    for (const [index, env] of environments.entries()) {
      repo = new TaskIndexRepo(getTasksIndexDatabasePath(env));
      assert.deepEqual(await repo.listTaskMetas({ workspacePath }), []);
      assert.equal(await repo.getTaskMeta({ workspacePath, taskId }), null);
      await repo.syncTaskMeta({
        meta: {
          traceId: "root-isolation",
          workspacePath,
          taskId,
          title: `Root ${index}`,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          provider: "glm",
        },
      });
      await repo.updateTaskState({
        workspacePath,
        taskId,
        patch: { pinned: true, archived: true, unreadAt: 10 + index },
      });
      repo.close();
      repo = null;
    }
    for (const [index, env] of environments.entries()) {
      repo = new TaskIndexRepo(getTasksIndexDatabasePath(env));
      const rows = await repo.listTaskMetas({ workspacePath, pinned: true, archived: true });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].taskId, taskId);
      assert.equal(rows[0].title, `Root ${index}`);
      assert.equal(rows[0].unreadAt, 10 + index);
      repo.close();
      repo = null;
    }
  } finally {
    repo?.close();
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
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
