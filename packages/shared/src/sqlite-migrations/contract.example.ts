import { DatabaseSync, backup } from "./index.js";
import type { SqliteMigrationsContract } from "./contract.js";

export async function exampleSqliteMigrations(
  port: SqliteMigrationsContract,
  db: DatabaseSync,
  backupDirectory: string,
): Promise<void> {
  await port.migrate(
    db,
    [
      {
        id: "example_add_title",
        appVersion: "1",
        touchedTables: ["example"],
        sql: "create table if not exists example (id text primary key, title text)",
      },
    ],
    { database: "example", backupDirectories: [backupDirectory] },
  );
}

/** 连接与在线备份共用同一驱动选择；调用者仍独占连接关闭及业务停写时机。 */
export async function exampleSqliteOnlineBackup(
  path: string,
  destination: string,
): Promise<number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return await backup(db, destination, { source: "main", rate: 100 });
  } finally {
    db.close();
  }
}
