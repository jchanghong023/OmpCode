# sqlite-migrations

CLI 与 Host 共用的 SQLite 升级基础设施；不理解 session、project 或业务归属。

- 只由启动 composition 调用，业务服务不能自行触发恢复。调用时数据库不在事务中，连接已设置 busy_timeout。
- BEGIN IMMEDIATE 先串行化迁移 admission，取得锁后重读版本；备份通过独立连接落盘，读取来源仍在同一快照内，失败回滚不丢备份。
- 历史 checksum 只由 SQL.trim() 计算。新增 apply 必须以对应 sql 记录不可变版本，声明所有写入表，且加列步骤可在表级恢复后重入。
- 只备份 touchedTables；调用者负责完整声明，fixture 哈希测试机械验证。schema_migration 由 runner 独占。
- touchedTables 缺失、为空或含非法表名在任何 SQL 写入前拒绝。Host 可指定 tasks_schema_migration，保留其 time_applied 与无 app_version 的历史形状；备份元数据记录 journal，恢复只清理对应账本。
- previousIds 仅用于开发分支迁移后移：所有已存在 ID 校验同一 SQL checksum，旧 ID 已完成时复制记账到新 ID，不重跑转换，不改旧记录。
- 空间不足尝试后续卷；全部不足记录 skipped，调用者必须提示。正常读取及正常降级不消费备份。
- 恢复保留加法 schema，新列取默认；恢复后删除相应 migration 记录。未知迁移 ID 保留。
- index.ts 是启动组合与 SQLite 公共入口，contract.ts 是迁移稳定端口。唯一驱动按完整合同能力选择：Node 22.16+ 的 22.x 与 Node 24+ 原样导出 node:sqlite 构造器与 backup；其余 runtime 懒加载 better-sqlite3 9.6.0。Node 22.5 仅代表模块出现，不代表具备 backup/isTransaction/timeout；这些能力在 [22.16 版本文档](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html) 标注新增于 22.16，主线为 24.0，不能据此假设 23.x 支持。原生加载或打开失败直接抛错，绝不切换驱动、复制数据库或双写。
- 兼容连接只拥有驱动句柄，保持同步 SQL、只读/延迟打开/关闭、事务状态、外键、WAL 和 busy_timeout；statement 保留位置/具名前缀绑定、整数范围错误、BigInt、BLOB、NULL 及迭代生命周期。在线 backup 异步分批复制，source/rate/progress 明确映射，非 main target 与原生新目标库一样拒绝。文件系统操作均异步。
- 兼容驱动在唯一边界为真实 SqliteError 补充 native errcode，锁竞争（含 BUSY 扩展码）的低八位保持 5，供既有 admission 异步等锁；保留同一错误对象、message、stack、cause 和原 code，不改变原生路径、不截获无关异常。行结果使用原生 null prototype，不复制行。

启动进程共用 storage-migrate 命令名及 version=1 的严格 JSON 完成 schema；SQL 仍只由持库 CLI 的 runner 执行。完成结果传 applied / backupPath / backupSkipped，错误以非零退出呈现，不伪造完成帧。
