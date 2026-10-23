import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import type {
  ProjectRepositoryContract,
  ProjectStorageContract,
} from "#src/project-storage/contract.js";
import { reconcileLegacy, admitTaskIdentity } from "#src/project-storage/legacy-tasks.js";
import { migrateProjects } from "#src/project-storage/migrate-projects.js";
import {
  INITIAL_WORKSPACE_ORDER_SQL,
  migrateInitialWorkspaceOrder,
} from "#src/project-storage/migration-order/migration.js";
import {
  DEFAULT_WORKSPACE_CANDIDATES_SQL,
  migrateDefaultWorkspaceTasks,
} from "#src/project-storage/default-workspace/migration.js";
import {
  PROJECT_MIGRATION_TABLES,
  PROJECT_SCHEMA_SQL,
  TASK_PROJECT_COLUMNS,
} from "#src/project-storage/schema.js";

export type {
  ProjectMigrationContext,
  ProjectRepositoryContract,
  ProjectStorageContract,
} from "#src/project-storage/contract.js";
export const projectStorage: ProjectStorageContract = {
  migrate: async (db, context) => {
    let firstProjectMigration = false;
    const result = await sqliteMigrations.migrate(
      db,
      [
        {
          id: "0005_projects",
          previousIds: ["0001_projects"],
          appVersion: "3.12.0",
          touchedTables: PROJECT_MIGRATION_TABLES,
          sql: `${PROJECT_SCHEMA_SQL}\n-- tasks columns: ${JSON.stringify(TASK_PROJECT_COLUMNS)}\n-- v3 workspace/group first assignment and CLI intent handoff`,
          apply: (database) => {
            migrateProjects(database, context);
            firstProjectMigration = true;
          },
        },
        {
          id: "0006_default_workspace_tasks",
          appVersion: "3.12.0",
          touchedTables: ["tasks", "projects"],
          sql: `${DEFAULT_WORKSPACE_CANDIDATES_SQL}\n-- v1 clear project ownership and soft-delete the unedited system container; preserve task facts`,
          apply: (database) => migrateDefaultWorkspaceTasks(database, context),
        },
        {
          id: "0007_initial_workspace_order",
          appVersion: "3.16.2",
          touchedTables: ["projects", "remote_project_entries"],
          sql: `${INITIAL_WORKSPACE_ORDER_SQL}\n-- seed mixed order only when 0005 runs in this transaction`,
          apply: (database) => {
            database.exec(INITIAL_WORKSPACE_ORDER_SQL);
            if (firstProjectMigration) migrateInitialWorkspaceOrder(database, context);
          },
        },
      ],
      {
        database: "tasks_index",
        backupDirectories: context.backupDirectories,
        now: context.now,
        onBackupSkipped: () => context.warn?.("项目迁移备份因可写卷空间不足跳过"),
      },
    );
    reconcileLegacy(db, context.hostId);
    return result;
  },
  admitTaskIdentity,
  repository: (db, hostId) => new ProjectRepository(db, hostId),
};

type WorkspaceScopeTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
};

/** 复用 TaskIndex 的真实 owner 解析；不解析 storageScope，也不缓存另一份项目域事实。 */
export async function resolveProjectWorkspaceSource(
  owner: {
    getWorkspaceTargets(): WorkspaceScopeTarget[];
    getProjectRepository(target: WorkspaceScopeTarget): Promise<ProjectRepositoryContract>;
  },
  repository: ProjectRepositoryContract,
  preferred?: WorkspaceScopeTarget,
): Promise<WorkspaceScopeTarget> {
  const key = (target: WorkspaceScopeTarget) =>
    target.workspaceIdentity?.trim() || target.workspacePath;
  const targets = owner.getWorkspaceTargets();
  const preferredKey = preferred && key(preferred);
  // 原因：只从已登记 workspace 中选活源；不能为 caller 任意路径启动替代 runtime 或重绑已有 profile。
  const candidates = [
    ...targets.filter((target) => key(target) === preferredKey),
    ...targets.filter((target) => key(target) !== preferredKey),
  ];
  for (const target of candidates) {
    try {
      if ((await owner.getProjectRepository(target)) === repository) return target;
    } catch {
      // 已退出/域事实未知的源不是可继承的 owner，继续查找同一项目域的其他活源。
    }
  }
  throw new Error("project.workspace-source-unavailable");
}
