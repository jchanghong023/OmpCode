# 本地差异需求索引

`docs/requirements/` 是本 Fork 固定的需求权威目录。每项需求只在所属功能域维护；本索引不复制子需求。开发规则、源码入口和测试命令见 [AGENTS.md](../../AGENTS.md)。

| 文档                                               | 唯一维护的需求域                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [FORK.md](FORK.md)                                 | Fork 目的、上游同步策略与平台范围（单分支、界面统一、`OMP_OFFLINE` 环境门控）、上游基线、核心替换、双链路、产品身份、数据隔离、分发及尚不等价的能力边界 |
| [omp-core-integration.md](omp-core-integration.md) | OMP 核心接入：每会话一进程 + 目录进程 v3 能力、斜杠严格分发、交互回路（ask/审批）、子代理详情与控制、模型双入口及 Z01—Z17 验收                          |
| [omp-native-commands.md](omp-native-commands.md)   | 核心 rpc-ui 命令：wiki、repo、team、plan、loop、goal、advisor、ultrathink、orchestrate、workflowz、fullsend、skill 与 compact 的原生对接和验收          |
| [models-and-commands.md](models-and-commands.md)   | 账号移除、Profile 隔离、角色配置、模型目录与原生命令                                                                                                    |
| [composer.md](composer.md)                         | 桌面输入区、临时模型、计划命令入口、上下文、压缩与 Git 状态                                                                                             |
| [skills.md](skills.md)                             | omp 可执行技能目录、候选、调用与只读设置                                                                                                                |
| [integrations.md](integrations.md)                 | 子代理、工具交互、扩展/MCP、浏览器与钩子设置页、自动化、文件引用与附件                                                                                  |
| [agent-interactions.md](agent-interactions.md)     | 主会话 Agent 交互独立 tab、消息方向与时间、实时与历史观察、按需读取和视觉验收                                                                           |
| [session-recovery.md](session-recovery.md)         | 会话身份、历史恢复、轮次收口、Host/远端连接与故障处理                                                                                                   |
| [performance.md](performance.md)                   | 流式长会话、查找和界面响应性及一致性约束                                                                                                                |
| [centos7-release.md](centos7-release.md)           | CentOS 7 原生 glibc 2.17 兼容包、Electron 双轨构建、离线锁定与发布边界                                                                                  |
| [centos7-performance.md](centos7-performance.md)   | CentOS 7 无 GPU 桌面的动画、流式合批与日志性能策略                                                                                                      |

需求或预期用户可见行为变化时，先更新对应文档及验收场景；新独立功能域可新增文档并更新索引。实现设计可解释状态所有权和时序，但不得重复定义另一套产品规则。`docs/specs/` 中保留的一次性依赖升级和 Lint 清理资料是工程任务记录，不是长期产品需求或自动执行授权。

## 实现与验证状态

需求定义、实现状态与验证结论分别维护：各功能域文档末节记录其适用版本、已验证范围和缺口，详细结果链接到 `docs/test-reports/`；本索引不复制测试流水或子需求。尚未逐项证明本地需求由上游等价满足时，保留现有需求；不可用能力与未来开放前提以所属功能域为准，不据源码存在或补丁消失认定已经实现。

历史报告只证明其中记录的提交、二进制、平台与场景。UT、协议模拟、静态检查及局部组件验证不能代替真实核心和产品 GUI E2E；跳过、失败、未执行及环境不足均不能计为通过。当前工作树有未提交改动时，不沿用旧版本的通过结论作为整体验收。

旧索引中的实现、验证和需求迁移记录完整归档于 [历史验证记录](../test-reports/fork-baseline-validation.md#需求索引旧状态记录2026-10-09-归档)。当前草稿与性能续作的组合边界及未完成验证见 [阶段修复与未完成验收](../test-reports/performance-hot-paths-2026-10-09.md#审查后修复与复验)；正式需求仍在对应功能域维护。
