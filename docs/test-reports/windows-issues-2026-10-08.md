# 2026-10-08 Windows 报错修复与三项交互验收

## 结论

模型设置目录读取与消息队列显示已修复，Windows 开发态的三项指定交互通过。`/loop` 仍不支持：内嵌 OMP 将它声明为 TUI-only，本次确认其按既有能力限制拒绝，未实现新的终端循环功能。全仓类型检查失败，因此不宣称全仓门禁通过或安装包已发布。

## 环境与范围

- 基线 `main@0f1fc94` 加本次工作区改动；Node 24.14.0、pnpm 10.33.2；`pnpm dev:desktop:test` 重建当前适配器后启动，CDP 9230。
- 内嵌核心 `v18.8.3+fork.300`；未修改 OMP 配置文件。
- 应用 data base、home、userData、sessionData 均隔离到 `%TEMP%/ompcode-issues-20261008/`。GUI 文件操作的实际 cwd 为 `data/.ompcode/workspace/default`，未修改用户项目文件。
- 历史会话链路创建了新的 OMP 会话桶和隔离应用历史；测试产生的三个文件最后均已删除。测试实例结束时停止，数据和证据保留。本次没有生成、安装或发布安装包，没有测试 CentOS 7。

## 原因与修复

1. 角色目录实际返回 `sessionModel: { model: { provider, modelId } }`。宿主错误地要求 `sessionId`，导致合法数据被报为“角色目录暂不可用”。协议将身份改为可选，保留身份与模型字段的类型校验；真实核心 E2E 增加宿主 schema 校验。
2. OMP 已处理 follow-up，但适配器只登记内部等待轮，没有发布 `queue.items`；UI 因此把等待输入显示为“工作中”。现在从同一投影派生队列，等待消息只在现有面板显示，核心消费该用户消息后关联后续输出。相同文本由 command ID 区分。首发接受到 `agent_start` 之间也按 busy 路由，新 run 开始不会提前清空全部等待输入。
3. 队列编辑、排序、删除与立即发送继续按已有能力门控不可用。状态所有者和 Desktop/Web 事件顺序见 [会话恢复需求](../requirements/session-recovery.md)。

## Windows GUI 结果

| 场景           | 实际结果                                                                                                  | 证据                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型设置       | 全部角色选择器正常加载，没有目录校验错误；未更改角色配置                                                  | [设置页](evidence-20261008-issues/models-final.png)                                                                                                                                                                                                     |
| Todo           | 开启“显示待办”后进度从 0/6 到 6/6；三个实际文件内容为 1、2、3，完成后确认三个文件均不存在                 | [运行进度](evidence-20261008-issues/todo-progress.png)、[完成](evidence-20261008-issues/todo-completed.png)、[文件与界面事实](evidence-20261008-issues/extra-result.json)                                                                               |
| 连续三次 hello | 第一条按钮为“发送”，后两条为“加入队列”；两个独立 command ID 同时显示等待，随后逐项消费，队列清空          | [等待](evidence-20261008-issues/queue-waiting.png)、[完成](evidence-20261008-issues/queue-completed.png)、[发送时间与 ID](evidence-20261008-issues/queue-result.json)                                                                                   |
| Sub Agent      | 历史会话链路中，子代理 AcceptedApe 运行约 6.7 秒，UI 投影从运行中到完成，卡片显示 success，记录入口可展开 | [运行中](evidence-20261008-issues/subagent-running.png)、[完成卡片](evidence-20261008-issues/subagent-completed-final.png)、[记录](evidence-20261008-issues/subagent-record-final.png)、[运行投影日志](evidence-20261008-issues/subagent-lifecycle.txt) |
| /loop          | 原始报错可复现，明确提示需要终端运行时；输入结束，没有挂住会话                                            | [拒绝结果](evidence-20261008-issues/loop-rejected.png)                                                                                                                                                                                                  |

`wait` 曾被后台完成通知抢占，核心返回 interrupted/error，界面忠实显示“执行失败”；它不是子代理失败。此次只验证创建、结果和记录展示，没有测试子代理停止或发送消息控制。

## 自动化检查

- `pnpm --filter @zcode/omp-agent test`：246/246 pass、0 fail、0 skip，包括三项真实核心 E2E、协议级模拟、队列时序与 Web 重放相关用例。[摘要](evidence-20261008-issues/core-summary.txt)
- shared 角色校验两项及 UI 等待行展示一项：3/3 pass。
- `pnpm exec tsc -b packages/shared packages/omp-agent packages/ui`：通过。
- `pnpm lint`、`pnpm architecture:check --changed`、`git diff --check`：通过。
- 变更模块为 omp-agent、shared、ui；三个包（含回归测试与模块契约）增加 312 行、删除 20 行，净增 292 行。架构检查 baseline 0、new 0，没有新增违规。
- `pnpm typecheck`：未通过。既有 `packages/desktop/src/host/index.ts:2062` 的 `logger[logLevel]` 可能索引 `debug`，但 logger 类型只有 info/warn/error（TS7053）。本次未修改该文件。[实际输出](evidence-20261008-issues/typecheck.txt)
- 没有运行 Web GUI 重连验收；Web 证据限于同源投影快照/增量重放及已有协议测试。没有将模拟测试等同于 Web GUI 验收。

## 历史入口与当前规程

历史 GUI 证据由 `evidence-20261008-issues/gui-queue.mjs` 与 `evidence-20261008-issues/gui-extra.mjs` 留存。脚本通过 agent-browser/CDP 操作真实编辑器和按钮，不注入队列或模拟工具结果；证据保存在脚本同目录，仅针对隔离实例。

当前自动化验收使用真实 OMP 与本地模拟模型；外部调用规程仅见 [E2E 规程](../requirements/e2e.md)。本报告保留历史验收状态，不将其改记为本地模拟模型验收结果。
