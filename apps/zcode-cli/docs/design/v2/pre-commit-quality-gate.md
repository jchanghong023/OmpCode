# 提交质量检查：仅手动执行

## 文档定位

本 fork 已移除 Git pre-commit 质量门，不再将其作为 `L1 Local Workflow Contract`。全部 Git 钩子的唯一现行契约见 [FORK-002](../../../../../fork.md)；本文不定义独立的钩子安装或执行机制。

## 当前约束

- `.husky/pre-commit` 及其他 Git 钩子不再安装或执行；依赖安装、开发和上游同步不得恢复。
- 根 `prepare` 不运行 Husky，根依赖不再包含 Husky；不初始化或修复 Git hook shims。
- Lint、类型检查和测试保留现有手动入口、执行范围及通过标准，仅按任务要求显式执行；不因提交或推送自动启动。
- 手动检查失败由命令返回非零退出码并报告错误，不通过 Git 钩子阻止提交或推送。
- 此变更不改变运行时 agent loop、tool runtime、权限系统或发布路径。
