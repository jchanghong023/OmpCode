import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createDatabaseSync } from "../src/session/tasksDatabase/sqlite.js";
import { OMP_SWAP_LEGACY_PURGE_SQL } from "../src/session/tasksDatabase/omp-swap-purge-v4.js";

for (const alreadyApplied of [false, true]) {
  test(`omp upgrade preserves automation consumers (0004 applied=${alreadyApplied})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-automation-upgrade-"));
    const path = join(root, "tasks.sqlite");
    const workspacePath = join(root, "workspace");
    const automations = new AutomationRepo(path);
    const tasks = new TaskIndexRepo(path);
    try {
      const plan = await automations.create(
        {
          title: "Preserved schedule",
          cronExpr: "0 0 * * *",
          prompt: "Read only",
          workspacePath,
          recurring: true,
        },
        { nextRunAt: 123456 },
      );
      await automations.setEnabled(plan.automationId, false);
      const expected = await automations.list({ workspacePath });
      for (const taskId of ["sess_old-cli", "session-not-old-cli", "omp-session-current"]) {
        await tasks.syncTaskMeta({
          meta: {
            taskId,
            title: taskId,
            workspacePath,
            traceId: "upgrade",
            provider: "glm",
            mode: "build",
            createdAt: 1,
            updatedAt: 2,
          },
        });
      }
      tasks.close();
      automations.close();
      const raw = createDatabaseSync(path);
      try {
        const frozenChecksum = createHash("sha256")
          .update(JSON.stringify([OMP_SWAP_LEGACY_PURGE_SQL]))
          .digest("hex");
        assert.equal(
          raw
            .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
            .get("0004_omp_swap_legacy_purge")?.checksum,
          frozenChecksum,
        );
        if (!alreadyApplied) {
          raw
            .prepare("DELETE FROM tasks_schema_migration WHERE id=?")
            .run("0004_omp_swap_legacy_purge");
        }
        for (const outcome of ["succeeded", "failed"]) {
          raw
            .prepare(
              `INSERT INTO automation_runs
             (run_id, automation_id, workspace_key, outcome, dispatch_status, session_id,
              error, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'dispatched', ?, ?, 1, 2)`,
            )
            .run(
              `run-${outcome}`,
              plan.automationId,
              workspacePath,
              outcome,
              `session-${outcome}`,
              outcome === "failed" ? "existing failure" : null,
            );
        }
      } finally {
        raw.close();
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // 通过真实 Repo 初始化消费者升级/重开，而不是直接断言 SQL 常量。
        assert.deepEqual(await automations.list({ workspacePath }), expected);
        const runs = await automations.listRuns(plan.automationId);
        assert.equal(runs.length, 2);
        assert.deepEqual(runs.map((run) => run.outcome).sort(), ["failed", "succeeded"]);
        assert.equal(
          (await tasks.getTaskMeta({ workspacePath, taskId: "sess_old-cli" })) !== null,
          alreadyApplied,
        );
        assert.ok(await tasks.getTaskMeta({ workspacePath, taskId: "session-not-old-cli" }));
        assert.ok(await tasks.getTaskMeta({ workspacePath, taskId: "omp-session-current" }));
        automations.close();
        tasks.close();
      }
    } finally {
      automations.close();
      tasks.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
