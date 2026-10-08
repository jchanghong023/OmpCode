# 2026-10-08 子代理与 Todo 的 ZCode 界面适配

子代理已接入原有独立智能体面板、主对话 Agent 卡片与只读详情侧栏；Todo 已接入原有独立「进程」待办面板。Windows 真实 GUI 的运行、完成与冷恢复验收通过。第一阶段复用 ZCode 常用界面的产品目标已写入 [Fork 需求](../requirements/FORK.md#分阶段产品目标)。

## 实现与所有者

- OMP 的成功 todo 结果同时投影工具行清单与会话 v4 `plan`；独立面板不受「显示待办」工具行开关影响。失败或畸形结果保留已确认清单，明确空结果清除；冷恢复取最后有效结果。
- 每个子代理行携带既有可订阅 `childSessionId` 和明确的 `parentToolCallId`。一对多 task 按真实 ID 各显示一张 Agent 卡片，不按事件顺序配对；已关联的泛化父 task 卡片不重复展示，父工具失败仍保留详情。跨轮完成保留启动轮归属。
- 全部子代理结束且没有其他状态时，保留智能体面板与已结束目录的胶囊入口；组件回归覆盖 panel / mini 两种形态。
- 状态由 `ConversationEngine` 的同一会话投影持有，UI 只派生展示；工具/子代理行与状态通过同一 seq 发布，Desktop 连续交付与 Web 快照/增量恢复复用同一事实。没有修改 OMP 仓库、二进制或用户配置。

## 环境与真实 GUI 证据

Node 24.14.0、pnpm 10.33.2，内嵌 OMP `v18.8.3+fork.300`，模型 `zhipu-coding-plan/glm-5.3-flash`，使用已有凭据。隔离应用身份为 `OmpCode UI Acceptance`，CDP 9231，renderer localhost:5194；data/home/userData/sessionData 均位于 `%TEMP%/ompcode-ui-adaptation-20261008/`。测试调用模型并新增测试会话，任务只执行等待与输出标记，不修改项目文件。原有日常 GUI 未被停止或替换。

| 验收            | 实际结果                                                                                                   | 证据                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Todo 运行与完成 | 独立面板显示三项，状态由 inProgress/pending 更新到全部 completed，进度 0/3 → 3/3；时间线 todo 仍按缺省隐藏 | [运行](evidence-20261008-ui-adaptation/live-todo-running.png)、[完成](evidence-20261008-ui-adaptation/live-completed.png)                                                                                                                   |
| 并发子代理      | 独立面板记录两个运行项，主对话每个任务一张 Agent 卡片，结束后运行计数为零                                  | [运行](evidence-20261008-ui-adaptation/live-agents-running.png)、[实际状态](evidence-20261008-ui-adaptation/live-result.json)                                                                                                               |
| 详情            | 两张卡片分别打开自己的只读侧栏，展开真实工具结果，分别看到 UI_ALPHA 与 UI_BETA                             | [Alpha](evidence-20261008-ui-adaptation/live-detail-0.png)、[Beta](evidence-20261008-ui-adaptation/live-detail-1.png)                                                                                                                       |
| 重启恢复        | 重启同一隔离桌面后，独立 Todo 保持 3/3；两个子代理卡片与各自工具结果仍可查看，没有重新执行模型             | [面板](evidence-20261008-ui-adaptation/cold-completed.png)、[Alpha](evidence-20261008-ui-adaptation/cold-detail-0.png)、[Beta](evidence-20261008-ui-adaptation/cold-detail-1.png)、[结果](evidence-20261008-ui-adaptation/cold-result.json) |

公开 GUI 验收入口为 `packages/desktop/test/ompStatusPanels.gui.e2e.mjs`；以 `OMP_E2E_CDP_URL` 与 `OMP_E2E_EVIDENCE_DIR` 指定隔离实例及证据目录，默认 live，重启后用 `OMP_E2E_PHASE=cold`。检查仅通过 UI 操作及读取 DOM，不注入投影、工具结果或状态；详情结果限定在对应子代理侧栏，不能用父任务正文里的标记冒充结果。

## 自动化验证及边界

- `pnpm --filter @zcode/omp-agent test`：250/250，通过，0 fail、0 skip，包含现有真实内嵌核心测试。[输出](evidence-20261008-ui-adaptation/core-tests.txt)
- `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/ompStatusPanels.test.tsx`：4/4，通过，覆盖独立 Todo、仅已结束子代理面板、各终态 Agent 卡片、一对多关联与失败父工具。[输出](evidence-20261008-ui-adaptation/ui-tests.txt)
- `pnpm lint`、`pnpm architecture:check --changed`、变更文件格式检查、`git diff --check`：通过；架构 baseline 0、new 0。生产变更在 omp-agent 与 ui，desktop 仅增加 GUI 测试入口。
- packages 下代码、测试与模块契约的变更规模为新增 641 行、删除 24 行，净增 617 行；文档与截图另计。主要新增内容为可复现的 GUI/组件/投影回归场景。
- `pnpm typecheck`：未通过，唯一错误为已有 `packages/desktop/src/host/index.ts:2062` 的 logger `debug` 索引类型错误；本次修改的 omp-agent / ui 项目无新增类型错误。[输出](evidence-20261008-ui-adaptation/typecheck.txt)
- 没有生成安装包，没有测试 CentOS 7 GUI 或独立 Web GUI 重连。Web 证据限于同一投影的有效 snapshot/delta、现有重放测试与严格 schema 校验；没有将这些检查称为 Web GUI 验收。
