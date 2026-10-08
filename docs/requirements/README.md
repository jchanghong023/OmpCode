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
| [session-recovery.md](session-recovery.md)         | 会话身份、历史恢复、轮次收口、Host/远端连接与故障处理                                                                                                   |
| [performance.md](performance.md)                   | 流式长会话、查找和界面响应性及一致性约束                                                                                                                |
| [centos7-release.md](centos7-release.md)           | CentOS 7 原生 glibc 2.17 兼容包、Electron 双轨构建、离线锁定与发布边界                                                                                  |
| [centos7-performance.md](centos7-performance.md)   | CentOS 7 无 GPU 桌面的动画、流式合批与日志性能策略                                                                                                      |

需求或预期用户可见行为变化时，先更新对应文档及验收场景；新独立功能域可新增文档并更新索引。实现设计可解释状态所有权和时序，但不得重复定义另一套产品规则。`docs/specs/` 中保留的一次性依赖升级和 Lint 清理资料是工程任务记录，不是长期产品需求或自动执行授权。

## 实现与验证状态

- 自建手机远控已从当前产品删除（范围见 [FORK.md](FORK.md#手机远控取消)）：专用中继、证书生成、侧栏入口、手机任务标记、IPC、客户端声明、离线门控字段、开发脚本及专用测试均移除；通用 Web、Host attachment 和 replayable 协议保留。根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与桌面 main/Host/preload/scheduler 的 tsup 构建通过；相关回归 17 项通过、0 跳过。Windows 隔离桌面实际打开工作区与设置，侧栏无手机入口、preload 无中继 API，原中继端口无监听且不生成手机证书；握手烟测接受 Desktop/Web、拒绝已删除的手机客户端声明。额外 `pnpm exec tsc -b packages/desktop` 未通过（main 的 rootDir/include、缺失类型导出及浏览器等类型错误），未将此结果记为通过；CentOS 7 真机和发布包未验收。
- 2026-10-07 OMP 核心接入重写（适配 omp v18.8.0+fork.298 RPC 大改）：OMP 删除项目宿主与旧 v3 fork 面，ZCode 侧删除项目模式层，目录能力（complete_command 补全、模型角色、会话目录）迁至常驻目录进程（`--mode rpc-ui --no-session` + v3），斜杠严格分发改适配层本地判定，ask 改经 `set_ask_dialog` + `extension_ui_request{method:"ask"}`，审批降级为通用询问（Approve/Deny），子代理详情/控制改父会话进程；详见 [omp-core-integration.md](omp-core-integration.md) 实现与验证状态。
- 2026-09-29/30 OMP 项目模式接入（Z1/Z2）完成（协议面已于 2026-10-07 失效，沿革备查）：omp-agent 内每 workspace 至多一个 OMP 项目进程承载全部会话（旧核自动回落旧拓扑），`/` 输入走 `execute_command` 严格分发，新增 complete_command 动态补全（含参数级）、子代理只读详情（`omp-subagent:<id>@<parent>` 合成地址）与 `control_subagent` 控制入口、模型角色 RPC 化（get_model_roles/set_model_role 逐 role 自动保存）。门禁全绿（typecheck/lint/fmt/architecture 0 违例），`@zcode/omp-agent` 123 项测试 0 失败 0 跳过；GUI 真实验收（OMP 源码进程 + glm-5.3-flash）逐项结果见当期归档记录。
- 2026-09-28 单分支统一重构完成：`experiment/centos7-no-proot` 已合回 `main`（合并提交 cd4a492）并删除本地与远端专有分支（既有 centos7 tag 保留），仓库恢复仅 `main` 一个产品分支；CentOS 7 发布流水线分支校验收窄为仅 `main`。执行计划已归档为 [refactor-plan.md](../test-reports/refactor-plan.md)。P2 七条门禁全绿（freshness、typecheck、lint、fmt、architecture、`@zcode/omp-agent` 全量 95 项含真实核心 E2E 实际执行 0 跳过、双平台真实界面验收）；合并回 main 后复跑 typecheck/lint 仍绿。逐场景结论与证据见 [windows-acceptance.md](../test-reports/windows-acceptance.md)、[centos7-acceptance.md](../test-reports/centos7-acceptance.md) 及 `evidence-windows/`、`evidence-centos7/`。
- 2026-09-28 双平台发布流水线金丝雀均从 `main` 通过：Windows [run 36487871248](https://github.com/jchanghong023/OmpCode/actions/runs/36487871248)（发布 v3.14.3-omp.4，含 `OmpCode-3.14.3-win-x64.exe` 与 SHA256）、CentOS 7 [run 36487891891](https://github.com/jchanghong023/OmpCode/actions/runs/36487891891)（发布 v3.14.3-centos7-36487891891-1，preflight/desktop/native/package/publish 全绿）。
- 上述重构仍未验证（环境不可用，如实记录，不视为已验收）：CentOS 7 真 VM 对发布 ZIP 的 Package acceptance 终验（以本地 C1 链出包 + WSL CentOS-7 原生运行替代验证）、公司 IBus 输入法真机。旧 frp 手机链路随手机远控取消，不再是当前验收项。
- 本次依据初始化前的根目录 `FORK.md` 及对应规格迁移；原文已标记实现的换核、品牌/图标、账号与模型面、命令、输入区、隔离及显示菜单保留“已有实现”的状态，长会话响应性保留“已实现首批”。其余细化规格保留验收要求，不因存在源码就标为已验收。
- [历史 Fork 验证记录](../test-reports/fork-baseline-validation.md) 保留早期结果及安装包 GUI 未验收范围；其中当时的版本、模型数量、测试数不是长期需求或当前结果。
- [2026-09-26 GUI 记录](../test-reports/gui-e2e-2026-09-26.md) 只覆盖报告所列的 Web 页面及一条真实对话。该次桌面启动被审批拒绝；辅助对话标签创建失败仍未确认原因。对应整理文档时未重跑真实核心、桌面/手机 GUI、发布或 CentOS 7 原生环境验收，不能用于证明当前版本已通过。
- `session-recovery.md` 中项目级删除接口缺少 workspace 身份的限制仍未解决；不能声称目录形状校验已证明目标属于当前工作区。
- `FORK.md` 中明确不可用的功能保持不可用；未来实现前提不等于已承诺的新增功能。尚无逐项证明某项本地需求已由上游等价满足的结论。

旧图片 spec 的“混合 PDF 时只发送图片”与原权威 FORK 明确拒绝不支持附件的要求不一致，现统一按原权威要求；旧输入区 spec 的窄窗口收起状态不得覆盖原权威要求保留分支名。这是消除从属文档冲突，未改变既有需求。旧换核 spec 涉及源码删除的条件说明由现行保留上游 CLI 快照的规则取代。
