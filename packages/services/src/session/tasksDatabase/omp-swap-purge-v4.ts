// 历史 0004 的原始 SQL 仅用于冻结 checksum；已应用的库必须仍能校验这一记录。
// 修复原因：自动化由 Host 调度并持久化，换核不代表没有消费者，不能删除计划/运行记录。
export const OMP_SWAP_LEGACY_PURGE_SQL = `
DELETE FROM tasks WHERE task_id LIKE 'sess_%';
DELETE FROM automation_runs;
DELETE FROM automations;
DELETE FROM off_peak_tasks;
`;

// 新升级只清理旧 CLI 会话投影；错峰能力被禁用不等于允许删除其持久数据。
export const OMP_SWAP_LEGACY_TASK_PURGE_SQL = `
DELETE FROM tasks WHERE task_id GLOB 'sess_*';
`;
