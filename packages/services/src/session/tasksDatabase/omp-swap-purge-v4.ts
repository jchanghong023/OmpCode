// omp 换核（FORK.md）：omp 是唯一 agent 核心，tasks 库中换核前的旧 CLI 派生数据
// 不再有任何消费方，且会穿透自动化页/会话列表（用户明确要求下次启动后不可见）。
// 一次性清理：旧 CLI 会话行（sess_*）、定时/错峰任务与运行记录（omp 无此能力）。
// omp 会话行（omp uuid / omp-session-*）由 sessions-index 对账负责，这里不碰。
export const OMP_SWAP_LEGACY_PURGE_SQL = `
DELETE FROM tasks WHERE task_id LIKE 'sess_%';
DELETE FROM automation_runs;
DELETE FROM automations;
DELETE FROM off_peak_tasks;
`;
