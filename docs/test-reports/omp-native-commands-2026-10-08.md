# OMP rpc-ui 核心命令验收（2026-10-08）

需求权威：[omp-native-commands.md](../requirements/omp-native-commands.md)。本次用户明确选择仅验收 Windows，并授权验收后合并本地 `main`、删除工作树；CentOS 7 未执行，不计通过。产品的平台要求不变。

## 环境与边界

- Windows；Node 24.14.0、pnpm 10.33.2。
- 实际安装 OMP `18.8.4+fork.304`（built 2026-10-08T11:07Z）。桌面暂存二进制与安装文件 SHA256 相同：`7AB71C738968279788C179E78EA9778F9EEE4A0B40CA215E706DECC82D15F7FD`。
- 真实模型 `zhipu-coding-plan/glm-5.3-flash`，凭据仅经内存传递，不写入报告或仓库；所有修改、索引、计划及会话均在独立临时测试根内。桌面使用本工作树 Vite 5194、专用 CDP 9257，不连接日常实例。
- 真实 Web 边界是公开 v4 `web-remote-replayable` 订阅与恢复；本次没有另行进行 Web 浏览器 GUI 验收、发布打包或 CentOS 7 验收。

## 已执行验证

| 范围                                         | 实际结果                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| omp-agent 非真实模型 UT / 协议模拟           | 297/297 通过，零跳过，包含最终协议修复回归                                                                 |
| UI 命令路由、模型目录及事实回投              | 10/10 通过；使用 `tsx --tsconfig packages/ui/tsconfig.json --test`                                         |
| workspace identity 环境与真实 stdio 集成     | 2/2 通过                                                                                                   |
| `real-omp.e2e.test.ts`                       | 3/3 真实通过：流式、write、审批、文件落盘，临时模型切换及目录能力                                          |
| `realNativeCommands.e2e.test.ts` N01/N03/N05 | 1/1 通过：全部核心目录、补全、未知/TUI/附件拒绝、wiki/repo 索引交互、停止与双链路冷恢复                    |
| 核心命令 GUI live                            | catalog、local、models、compact、team、plan、loop、goal 已通过；修复后完整 GUI capture 采集 155 条助手记录 |
| 真实 compact                                 | 参数与新增原生 journal summary 验证通过；13197→8233 tokens，压缩后真实模型输出增加 8 tokens                |
| 真实计划控制与完整模型冷恢复                 | 真实复验通过：批准、拒绝、草稿确认、暂停、关闭与两链路完整历史相等                                         |
| GUI 全量冷恢复                               | 155 条助手记录内容、顺序和重复次数完全一致                                                                 |
| typecheck、lint、全量架构检查                | 通过；Lint 零警告/错误，架构零新违反                                                                       |
| 变更文件格式与差异空白检查                   | 通过                                                                                                       |
| 全仓 `pnpm fmt:check`                        | 失败：14 个本次未修改的既有文件；未将其改写为通过                                                          |

## 保留的失败与修复依据

- 最初 `/team` 子调用返回 `schema_violation: factDifferences.0.topic: is required`，是真实 OMP 失败，已原样显示。测试去掉与完整 schema 冲突的三句限制后，同一 GUI 公共入口完成五阶段并产生完整选择报告。该次 180 秒等待曾超时；随后只读 GUI 观察严格核对五阶段顺序及最新成功报告，保留超时在 `coverage.team.previousFailure`，没有重复发命令、替换结果或注入模型输出。
- `/plan` GUI 辅助断言曾遗漏 OMP 合法 `Advisor "default" is running.` 状态。修正测试状态匹配后，计划正文、拒绝不执行、批准后的模型回复与 `low → high → low` 事实回投实际通过。
- 原生历史的 `entityId` 是行类别，不能作为所有历史的全局唯一键。修复合并算法后保留每条原生行，仅对派生输出按自身记录 ID 去重。离线真实历史重放属于合并算法验证，不能代替实际模型或 GUI 验收。
- 接口审查发现 canonical UUID 与 logical alias 可能恢复出两个引擎。现在双向及并发复用同一 owner，关闭与删除覆盖别名屏障；顺序、并发、唯一进程 lease、删除、关闭及身份隔离回归通过。
- 计划 API 曾出现 journal 已暂停但可见暂停文本缺失。修复上下文回读只捕获完整 `/context` 报告，业务输出正常交付；ACK 前后交错回归修复前失败、修复后通过，真实计划与双链路完整冷恢复复验通过。
- 先前压缩后自然语言回忆题失败已保留；该题不是 rpc-ui 参数与压缩终态的确定性验收条件。当前验收使用实际 summary 参数、唯一新增压缩条目及后续真实模型轮，未将旧失败记成通过。

- 首次完整 GUI 冷恢复比较失败，原生 custom 数据存在但共用模型 turn 分组，界面隐藏了旧报告。已为每条原生 custom 分配独立稳定显示组，保留模型轮；旧 150 行基线与失败已存档。最新构建经真实 Composer 执行本地 `/advisor off` 后采集 155 行，再重启同根严格比较通过。原失败见 [失败证据](evidence-omp-native-commands-20261008/before-custom-group-fix-failure.json)，未通过重写旧基线来消除差异。

## 证据与复现

测试入口与隔离启动前提见 [AGENTS.md](../../AGENTS.md)。GUI 顺序为 `live → capture → 重启同一测试根 → cold`，`capture` 只读取真实 timeline；cold 比较完整文本数组的内容、顺序与重复次数。不能以跨进程重建的 rowId 或仅选择过的输出子集充当恢复基线。

Windows 范围验收完成。脱敏证据： [目录与索引/双链路](evidence-omp-native-commands-20261008/native-local-result.json)、[真实计划](evidence-omp-native-commands-20261008/native-plan-model-result.json)、[压缩](evidence-omp-native-commands-20261008/compact-native-result.json)、[GUI 覆盖](evidence-omp-native-commands-20261008/gui-coverage.json)、[GUI 完整冷恢复](evidence-omp-native-commands-20261008/gui-cold-result.json)、[最终 UT](evidence-omp-native-commands-20261008/unit-final-summary.txt)。
