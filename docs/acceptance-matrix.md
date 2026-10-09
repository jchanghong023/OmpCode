# 单分支重构验收矩阵（W6）

历史单分支重构工程验收台账，不是需求权威，也不再维护为当前执行矩阵；现行需求与验收以[需求索引](requirements/README.md)为准。本文件保留当时的需求摘要、工作流分工和状态，不能用于恢复已取消功能或执行已取消的验证。

下文的 `--home`/`--offline` 启动参数、计划模型按钮、禁止子代理下钻、CentOS/VM/Citrix/流水线测试及 C1/P2 时序等是已被现行需求替代的历史记录，不是待实现要求；未回填的空状态不证明当前功能未实现或已经通过。现行测试编排见[三级测试需求](requirements/test-gates.md)，历史结果仍按原报告绑定的版本和范围解释。

## 列说明

- **来源**：需求出处锚点，链接到 `docs/requirements/` 对应文档章节。
- **验证方式**：`UT`（单元/协议模拟测试）、`E2E`（真实入口到可观察结果，含 fake-omp 协议级与真实核心）、`GUI`（真实界面操作走查）、`VM`（CentOS 7 VM 包级验收）、`人工`（人工核对/环境依赖的人工步骤）。多值表示需组合覆盖。
- **负责工作流**：`W1` 构建双轨、`W2` 双运行时兼容、`W3` 桌面 Main/Host、`W4` UI 统一、`W5` 会话/协议核验、`W6` 文档与验收组织、`P2` 集成验证（见 [refactor-plan.md](test-reports/refactor-plan.md)）。
- **状态**：空白 = 尚未执行或结果未知。**只能由 P2 及各工作流实际执行后回填**；不得预填「通过」。验证不绿、跳过或环境缺失均须如实记录（AGENTS.md「实现与验证」）。

各工作流交付验证入口见 [AGENTS.md](../AGENTS.md)「自动化验证入口」；平台验收执行记录落 `docs/test-reports/`（[windows-acceptance.md](test-reports/windows-acceptance.md)、[centos7-acceptance.md](test-reports/centos7-acceptance.md)）。

---

## 1. [FORK.md](requirements/FORK.md) — Fork 与上游差异

| 编号 | 需求要点                                                                                                                           | 来源                                                                                                                         | 验证方式   | 负责工作流 | 状态 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---- |
| F01  | 换核：omp RPC 核心替换 `apps/zcode-cli`，omp 拥有会话/模型循环/工具执行/配置凭据；CLI 快照不接入运行时                             | [Agent 核心与双链路](requirements/FORK.md#agent-核心与双链路)                                                                | E2E+GUI    | W5         |      |
| F02  | v4 conversation 投影按上游 wire schema 产出，全部下行帧经 `conversationTopicWireFrameSchema` 校验                                  | [Agent 核心与双链路](requirements/FORK.md#agent-核心与双链路)                                                                | UT+E2E     | W5         |      |
| F03  | 双链路：`desktop-continuous` 与 `web-remote-replayable` 同一投影、按订阅 `clientMode` 区分；断线按水位续传、超界回退整快照 resync  | [Agent 核心与双链路](requirements/FORK.md#agent-核心与双链路)                                                                | UT+E2E+GUI | W5         |      |
| F04  | omp RPC 帧格式不渗入 UI（适配层闭环）；`ask` 选择/文本输入复用 `ElicitationDialog`                                                 | [Agent 核心与双链路](requirements/FORK.md#agent-核心与双链路)                                                                | UT+GUI     | W5         |      |
| F05  | 上游基线记录（v3.14.3 / 29628c9a）与同步策略；结构隔离（omp-agent、Omp* 文件、docs/requirements）                                  | [已合入上游基线](requirements/FORK.md#已合入上游基线)、[上游同步策略与平台范围](requirements/FORK.md#上游同步策略与平台范围) | 人工       | W6         |      |
| F06  | 平台范围仅 Windows 与 CentOS 7；单分支策略；界面统一，CentOS 7 构建标记仅限渲染性能豁免                                            | [上游同步策略与平台范围](requirements/FORK.md#上游同步策略与平台范围)                                                        | VM+GUI     | W2+W4      |      |
| F07  | `--offline` 企业离线锁定：关闭公网更新/公网配置/遥测等后端并透传 omp；被关入口禁用态 +「离线锁定中已关闭」，无法禁用的触发明确报错 | [上游同步策略与平台范围](requirements/FORK.md#上游同步策略与平台范围)                                                        | UT+E2E+VM  | W3         |      |
| F08  | 数据隔离：`~/.ompcode`/`.ompcode` 全量数据根、右键菜单与更新缓存 OmpCode 专属、双装互不读写                                        | [数据、端口与更新隔离](requirements/FORK.md#数据端口与更新隔离)                                                              | GUI+E2E    | W3         |      |
| F09  | 更新隔离：不查询/安装上游更新、不受强更线拦截；正式包仅 GitHub Release 手动更新                                                    | [数据、端口与更新隔离](requirements/FORK.md#数据端口与更新隔离)                                                              | GUI+人工   | P2         |      |
| F10  | 端口隔离：9230/5194/5193/3033 开发端口；运行期本地服务 `listen(0)` 临时端口                                                        | [数据、端口与更新隔离](requirements/FORK.md#数据端口与更新隔离)                                                              | UT+E2E     | W3         |      |
| F11  | 内嵌 omp：随包分发最新 release 二进制；与用户 omp 同配置；不覆盖/代装用户 omp；子进程 stdio 不监听端口、不影响运行中进程           | [omp 侧依赖](requirements/FORK.md#omp-侧依赖)                                                                                | UT+E2E     | W5         |      |
| F12  | Windows x64 手动发布：唯一 OmpCode tag、EXE+SHA256 上传 Release                                                                    | [omp 侧依赖](requirements/FORK.md#omp-侧依赖)                                                                                | 人工       | P2         |      |
| F13  | 产品身份：OmpCode 品牌文案全位覆盖；omp 官方图标全尺寸更换；「显示效果」入口 Monitor 图标、齿轮设置不变                            | [产品身份与图标](requirements/FORK.md#产品身份与图标)                                                                        | GUI        | W4         |      |
| F14  | 已知与允许的差异 18 项：显式拒绝（guard id）或规定替代行为，主对话链路不受影响，不静默缺失                                         | [已知与允许的差异](requirements/FORK.md#已知与允许的差异)                                                                    | UT+E2E+GUI | W5         |      |
| F15  | 总验收：真实公开入口新建会话覆盖流式/工具调用/双向交互/文件变更/完成中断/冷恢复，并验证双链路恢复                                  | [Agent 核心与双链路](requirements/FORK.md#agent-核心与双链路)                                                                | GUI+E2E    | P2         |      |
| F16  | 手机远控取消：无专用 UI/IPC/relay 监听与证书生成，不恢复官方云入口；通用 Web/Host 与其他离线门控保留                               | [手机远控取消](requirements/FORK.md#手机远控取消)                                                                            | GUI+UT     | W3+W4      |      |

## 2. [models-and-commands.md](requirements/models-and-commands.md) — 账号、Profile、模型与命令

| 编号 | 需求要点                                                                                                                                  | 来源                                                                                                                                           | 验证方式 | 负责工作流 | 状态 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- | ---- |
| M01  | 账号体系整体废弃：登录门禁、侧栏账号/套餐/用量 footer、命令面板登录登出、配额横幅全部移除                                                 | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | GUI      | W4         |      |
| M02  | omp 模型目录与 `modelRoles` 事实源；Main 读写配置、UI 经 `IPlatformService`；workspace-config topic 投影，UI 不建第二缓存                 | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT+E2E   | W3+W5      |      |
| M03  | presentation 与 workspace-config 并发到达时按所有者字段合并，互不清空；重复恢复不丢目录                                                   | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT       | W5         |      |
| M04  | workspace-config 已接受快照保留并即时重放给新监听者；runtime 换代由新快照替换                                                             | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT       | W5         |      |
| M05  | 首次 presentation 同返模型目录快照（复用同一 flight），冷启动设置页有候选                                                                 | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT+E2E   | W5         |      |
| M06  | `get_available_commands` 命令目录事实源；字段齐全、未知来源映射自定义；失败显式记录并返回空目录                                           | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT+E2E   | W5         |      |
| M07  | 本地命令 `command_output` 投影与轮次收口：`agentInvoked:false`/`prompt_result:false` 必须结束轮次；晚到完成帧不误收口；重复收口无状态补丁 | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT       | W5         |      |
| M08  | Host 启动 omp 不依赖旧 Provider Registry 门禁；omp 无模型时由 omp 返回明确错误；无旧模型横幅                                              | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | E2E+GUI  | W5         |      |
| M09  | 角色写入：仅改目标 role、写前备份、原子替换、失败可恢复；冒号仅按目录确认的档位后缀解析                                                   | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)、[时序与失败语义](requirements/models-and-commands.md#时序与失败语义) | UT+E2E   | W3+W5      |      |
| M10  | 思考档位选择：档位取自模型支持集；切换模型保留原等级或落新模型缺省                                                                        | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT+E2E   | W5         |      |
| M11  | Profile 选择持久化、`OMP_PROFILE` 透传、任务索引按 profile 分库、路径同源；保存仅标记待重启                                               | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | UT+E2E   | W3+W5      |      |
| M12  | 「模型设置」与「管理模型」同一编辑器；无配置显示内建角色、首次保存仅建所选角色最小 `config.yml`；无供应商新增                             | [产品规则与所有权](requirements/models-and-commands.md#产品规则与所有权)                                                                       | GUI+E2E  | W4         |      |
| M13  | 命令路由：omp 内置命令透传（`/model`、`/switch` 等）；`/compact`、`/compress` 保留本地 v4 映射；目录变化实时刷新；状态回投同步标题与模型  | [命令路由与角色覆盖](requirements/models-and-commands.md#命令路由与角色覆盖)                                                                   | E2E+GUI  | W5         |      |
| M14  | 多角色清单与 omp 内建 role 一致并支持自定义追加；`/plan`、`/goal` 等未分发命令按本地语义                                                  | [命令路由与角色覆盖](requirements/models-and-commands.md#命令路由与角色覆盖)                                                                   | UT+E2E   | W5         |      |

## 3. [composer.md](requirements/composer.md) — 桌面输入区

| 编号 | 需求要点                                                                                                                       | 来源                                                          | 验证方式   | 负责工作流 | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------- | ---------- | ---- |
| C01  | 单行工具栏布局；omp 全权限下隐藏原权限/模式控件；计划模型及只读状态内嵌同栏                                                    | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | GUI        | W4         |      |
| C02  | 压缩按钮与自动压缩开关在工具栏和输入框下方均不出现；手动压缩仅 `/compact`；`setAutoCompaction` 无 GUI 入口                     | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | GUI+UT     | W4         |      |
| C03  | 窄窗口保留分支名并优先保留原操作与计划模型入口；手机布局不新增入口；草稿态只展示有事实源项目                                   | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | GUI        | W4         |      |
| C04  | 模型/思考档 Composer Draft 所有权；档位取 `thinking.efforts`+`off`；新任务默认最高档；重复选择不重复下发；切换会话不恢复旧选择 | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | UT+E2E     | W5         |      |
| C05  | 计划模型按钮：读取当前 profile `modelRoles.plan` 临时切换、再点恢复；不写配置、不切模式；缺失/失败明确反馈                     | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | E2E+GUI    | W4+W5      |      |
| C06  | 上下文总量以 `get_state.contextUsage` 为准；`/context` 分项解析为估算展示；缺失/不一致时只显示已确认总量；未知容量不显示圆环   | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | UT+E2E+GUI | W5         |      |
| C07  | `/context` 仅空闲时请求、截走侧信道不进聊天、暂缓后续输入；总量替换时清旧分项；仅当前进程结果可更新投影                        | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | UT         | W5         |      |
| C08  | 已存在会话异步启动 RPC 读 `get_state`；`agent_end` 与压缩后回读用量；失败保留未知值不伪造                                      | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | UT+E2E     | W5         |      |
| C09  | Git 状态行复用宿主 summary/dirty count；无仓库隐藏；点击打开既有 Git 审阅入口                                                  | [产品规则与所有权](requirements/composer.md#产品规则与所有权) | GUI        | W4         |      |
| C10  | 综合验收：圆环弹层、计划模型往返、压缩控件全隐藏、冷会话分项刷新、弹层不产生聊天消息                                           | [验收场景](requirements/composer.md#验收场景)                 | GUI+E2E    | P2         |      |

## 4. [skills.md](requirements/skills.md) — 可执行技能

| 编号 | 需求要点                                                                                                                            | 来源                                                | 验证方式 | 负责工作流 | 状态 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- | ---------- | ---- |
| S01  | 技能目录事实源：omp `get_available_commands` `source=skill`；去 `skill:` 前缀；TUI 扩展中心条目数不算可调用数                       | [产品规则](requirements/skills.md#产品规则)         | UT+E2E   | W5         |      |
| S02  | 选择技能提交原生 `/skill:<name>` token；句中 token 支持；GUI 不注入第二份正文；chip 显示技能名                                      | [产品规则](requirements/skills.md#产品规则)         | E2E      | W5         |      |
| S03  | 「设置 → 技能」只读：仅 omp 目录、错误与刷新；无工作区空态引导；无本地扫描/安装/删除/开关；独立导航入口两平台保留（含离线锁定构建） | [产品规则](requirements/skills.md#产品规则)         | GUI      | W4         |      |
| S04  | 草稿按目标工作区、已有会话按会话进程读取；未知会话报错；远端只查远端 Host；请求代次隔离、目录变化清缓存                             | [产品规则](requirements/skills.md#产品规则)         | UT+E2E   | W5         |      |
| S05  | 目录查询失败显式错误，不回退本地扫描伪目录；`agent_end.messages` 自定义上下文不阻塞终态收口                                         | [所有者和接口](requirements/skills.md#所有者和接口) | UT       | W5         |      |
| S06  | 综合验收：fake-omp 目录过滤、`$`/`/skill:` 候选一致、真实 omp 与 GUI 技能集合一致、真实模型调用项目技能读文件并冷恢复保留           | [验收](requirements/skills.md#验收)                 | E2E+GUI  | P2         |      |

## 5. [integrations.md](requirements/integrations.md) — 原生工具、扩展与自动化

| 编号 | 需求要点                                                                                                                                             | 来源                                                                                                             | 验证方式                                                                    | 负责工作流 | 状态  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- | ----- |
| I01  | 子代理：omp `task` 调度；GUI 显示运行/结束/失败与记录，不把父回复当子代理证据                                                                        | [子代理](requirements/integrations.md#子代理)                                                                    | E2E+GUI                                                                     | W5         |       |
| I02  | 首次出现发 `row.appended` 再 `row.upserted`；实时增量与恢复快照行集合一致                                                                            | [子代理](requirements/integrations.md#子代理)                                                                    | UT                                                                          | W5         |       |
| I03  | `subagent_lifecycle`/`subagent_progress`/`subagent_event` 订阅投影按 ID 幂等；订阅失败显式降级                                                       | [子代理](requirements/integrations.md#子代理)                                                                    | UT                                                                          | W5         |       |
| I04  | 冷恢复/重连从 `get_subagents`/`get_subagent_messages` 读取；完全重启从父会话条目还原并读会话子目录 JSONL（路径限制在当前会话）                       | [子代理](requirements/integrations.md#子代理)                                                                    | UT+E2E                                                                      | W5         |       |
| I05  | `ConversationEngine` 是子代理投影唯一 owner；兼顾双链路 snapshot/delta 顺序；失败子代理不留永久 running                                              | [子代理](requirements/integrations.md#子代理)、[所有者与时序](requirements/integrations.md#所有者与时序)         | UT                                                                          | W5         |       |
| I06  | `@` 文件引用可用；不请求 `plugins/referenceCatalog`、不显示原始 -32601                                                                               | [GUI 验收遗留问题](requirements/integrations.md#gui-验收遗留问题)                                                | GUI+UT                                                                      | W5         |       |
| I07  | 扩展/MCP 页：列 omp profile 与项目 `.omp` 配置项及启用状态；不显示命令参数/环境变量/密钥；连接态标「未提供」；提供打开配置目录入口；远程不读本机路径 | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | GUI+UT                                                                      | W4+W5      |       |
| I08  | 浏览器设置页：「默认开启」说明文字非开关；不查询旧 ZCode 插件、无 plugins/list 错误；浏览器数据/证书控件沿用                                         | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | GUI                                                                         | W4         |       |
| I09  | 钩子页：枚举 profile 与项目 `.omp` 的 `hooks/pre                                                                                                     | post` JS/TS；不读/不执行/不回传源码；无目录空态、失败显错、刷新重扫；无旧 ZCode 管理控件                         | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界) | UT+GUI     | W3+W4 |     |
| I10  | 自动化：现有调度服务持久化，触发经 Host 启动 omp 会话执行；不建第二套运行时；模型候选与聊天同源（workspace-config）；表单无旧权限选择                | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | E2E                                                                         | W5         |       |
| I11  | 自动化临时 task ID → omp UUID 终态结算：先摘要结算再迁稳定 ID，不往返、无双任务行                                                                    | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | UT                                                                          | W5         |       |
| I12  | 非图片文本附件：UTF-8 白名单并入 prompt（单文件 256 KiB、合计 512 KiB、非法拒绝）                                                                    | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | UT                                                                          | W5         |       |
| I13  | PDF/视频等不可消费附件提交前明确拒绝、不建空轮次、不误报已读；缺失引用拒绝                                                                           | [扩展、自动化与附件边界](requirements/integrations.md#扩展自动化与附件边界)                                      | UT+E2E                                                                      | W5         |       |
| I14  | `confirm` 交互：接受/拒绝按钮按原请求 ID 回答并收口；无遮罩无应答入口                                                                                | [工具交互与能力拒绝](requirements/integrations.md#工具交互与能力拒绝)                                            | UT+GUI                                                                      | W5         |       |
| I15  | `todo` 沿用待办身份与开关；`task` 卡片显示实际 agent 类型；MCP 启用状态按 omp 配置语义（disabled 与跨来源名单）                                      | [工具交互与能力拒绝](requirements/integrations.md#工具交互与能力拒绝)                                            | UT+GUI                                                                      | W5         |       |
| I16  | 赞/踩入口隐藏；插件市场入口隐藏、referenceCatalog 返回合法空目录；子代理目录不提供子会话下钻                                                         | [工具交互与能力拒绝](requirements/integrations.md#工具交互与能力拒绝)                                            | GUI                                                                         | W4         |       |
| I17  | 图片附件：v4 输入附件按序转 omp `ImageContent`；`AttachmentStore` 唯一所有者；prompt/steer/follow_up 均携带                                          | [图片附件转发](requirements/integrations.md#图片附件转发)                                                        | UT+E2E                                                                      | W5         |       |
| I18  | 混合图片+PDF 整次拒绝；无附件不带 `images`；guide/queue 流式输入分别映射 steer/follow_up 并携带图片                                                  | [图片附件转发](requirements/integrations.md#图片附件转发)、[附件验收](requirements/integrations.md#图片附件转发) | UT                                                                          | W5         |       |

## 6. [session-recovery.md](requirements/session-recovery.md) — 会话身份、恢复与故障

| 编号 | 需求要点                                                                                                                 | 来源                                                                              | 验证方式 | 负责工作流 | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------- | ---------- | ---- |
| R01  | v4 帧上限覆盖 NDJSON/Channel socket 两承载；生产者分片、组装器只收合法帧；分片不改序号与重放语义                         | [产品规则与所有权](requirements/session-recovery.md#产品规则与所有权)             | UT       | W5         |      |
| R02  | 会话引擎轮次/交互终结：命令发送失败、核心退出、流式中本地命令、已取消交互均收口；已完成轮不被迟到结果改写                | [产品规则与所有权](requirements/session-recovery.md#产品规则与所有权)             | UT       | W5         |      |
| R03  | 远端部署根 `~/.ompcode/server`；wrapper 只执行当前部署文件、不读 `~/.zcode`                                              | [产品规则与所有权](requirements/session-recovery.md#产品规则与所有权)             | E2E      | P2         |      |
| R04  | HTTP server 无凭据仅回环监听；显式非回环必须带凭据否则启动失败；断线拒绝未完成 RPC、页面显中断并重连                     | [产品规则与所有权](requirements/session-recovery.md#产品规则与所有权)             | UT+E2E   | P2         |      |
| R05  | Desktop Main 是 window-scoped Host 生命周期所有者；非预期退出通知并重建；迟到 exit 不注销新 Host；清理预算与强杀预算一致 | [产品规则与所有权](requirements/session-recovery.md#产品规则与所有权)             | UT       | W3         |      |
| R06  | 冷历史：omp `~/.omp/agent/sessions` 事实源、稳定 ID 绑定；订阅可恢复失败最多两次强制快照重连                             | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT+E2E   | W5         |      |
| R07  | 会话列表不因截断隐藏 omp 历史；按 ID 恢复/删除直接定位会话文件；分页渐进加载可读到较早消息                               | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT+E2E   | W5         |      |
| R08  | `deleteSession` 永久删除：先 omp 文件成功再移除索引与广播；存储失败返回失败且历史可重开；`session/close` 只释放引擎      | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT       | W5         |      |
| R09  | 相对 `PI_CONFIG_DIR` 解析规则主进程与适配器一致；topic 帧序号严格递增、取消订阅清理计数                                  | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT       | W5         |      |
| R10  | Windows 临时目录工作区冷扫描：重启后按稳定 ID 恢复主会话与子代理记录                                                     | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | E2E      | W5         |      |
| R11  | `guide`/`queue` 轮次归属：guide 建新用户轮、当前轮输出收口；queue 待启动不激活；双链路一致                               | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT+E2E   | W5         |      |
| R12  | `edit` 文件变更以成功工具结果为准：hashline 提供路径、diff 提供增删行；无可验证事实不编造                                | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT       | W5         |      |
| R13  | `SessionRegistry` 临时 ID→UUID 迁移同源；恢复 `toSeq` 为当前水位、delta 连续；旧 ID 订阅迁移期可用                       | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT       | W5         |      |
| R14  | Host 持久任务索引组织信息（分组/排序/置顶/归档/未读/定时关联）随身份迁移；冷启动对账只清不存在旧行；时间戳安全整数毫秒   | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | UT       | W5         |      |
| R15  | 已知限制：项目级删除接口缺 workspace 身份限制未解决，不得宣称任意路径删除已封闭（缺口记录，不预填通过）                  | [资源生命周期与已知限制](requirements/session-recovery.md#资源生命周期与已知限制) | 人工     | W5         |      |
| R16  | 终端会话释放失败经 UI logger lifecycle 通道落桌面日志，生产构建不静默丢失                                                | [资源生命周期与已知限制](requirements/session-recovery.md#资源生命周期与已知限制) | UT       | W3         |      |
| R17  | 综合验收：100+ 会话列出并恢复、4000+ 记录回读、冷/已加载删除一致、guide/queue 双链路一致                                 | [冷历史与身份连续性](requirements/session-recovery.md#冷历史与身份连续性)         | E2E      | P2         |      |

## 7. [performance.md](requirements/performance.md) — 性能热路径

| 编号 | 需求要点                                                                                                                                                       | 来源                                                             | 验证方式     | 负责工作流 | 状态 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ | ---------- | ---- |
| P01  | 优化不改变对话内容、任务状态、历史分页、订阅水位与双链路可见结果                                                                                               | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+GUI       | W5         |      |
| P02  | `zcodeSessionStore`/`ConversationProjectionStore`：重复通知不出新引用；一帧 deltas 一份不可变新快照                                                            | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT           | W5         |      |
| P03  | `ConversationProjection` 流式缓冲但 snapshot/rowsRange/终态 upsert 物化完整文本                                                                                | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT           | W5         |      |
| P04  | wire codec 分片保持物理帧上限、校验和、序号与错误语义；帧只编码一次，调试日志关闭不额外编码                                                                    | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT           | W5         |      |
| P05  | UI 订阅最小字段；非首屏组件异步装载但打开即可用                                                                                                                | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+GUI       | W4         |      |
| P06  | 查找：输入立刻回显、150ms 去抖执行昂贵匹配、切换/关闭/清空取消旧查询                                                                                           | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+GUI       | W4         |      |
| P07  | 「打开方式」编辑器探测不在主线程同步等待外部命令；静态路径优先、命令兜底异步、结果复用                                                                         | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+GUI       | W3         |      |
| P08  | Agent stdio 适配器按会话串行有状态命令；慢历史读取不阻塞他会话；ACK 先于本请求首帧；同 topic 帧按生成顺序上线                                                  | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT           | W5         |      |
| P09  | 冷会话目录有界读取、按 ID 定位、标题只读头部；长会话恢复避免整文件拆分内存峰值                                                                                 | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+E2E       | W5         |      |
| P10  | 传输背压：每连接未发送字节有上限；桌面流不丢帧、Web 流按水位补发/重取快照                                                                                      | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT+E2E       | W5         |      |
| P11  | 主进程生产日志异步写入、退出前刷盘、错误日志可见（与 centos7-performance 日志域共用实现）                                                                      | [产品规则与所有者](requirements/performance.md#产品规则与所有者) | UT           | W3         |      |
| P12  | 综合验收：真实模型 GUI 流式会话与导航、设置页往返、查找高亮、打开方式、跨会话隔离、优化前后测量（列表/恢复/时间线/内存）、慢 WebSocket 与饱和 MessagePort 有界 | [验收场景](requirements/performance.md#验收场景)                 | GUI+E2E+人工 | P2         |      |

## 9. [centos7-release.md](requirements/centos7-release.md) — CentOS 7 发布

| 编号 | 需求要点                                                                                                                                                                              | 来源                                                                                          | 验证方式 | 负责工作流 | 状态 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- | ---------- | ---- |
| CR01 | 两平台 UI 完全一致；`--offline` 门控；差异仅限底层依赖与打包；Main/Host/renderer 无缺失回退的 Electron 44 独有 API                                                                    | [平台界面与功能边界](requirements/centos7-release.md#平台界面与功能边界)                      | VM+GUI   | W2+W3      |      |
| CR02 | `release-centos7.yml` 从 `main` 构建唯一自包含 ZIP；修改 workflow 前必须先过 CentOS 7 VM 完整验证（C1 时序）                                                                          | [Product behavior](requirements/centos7-release.md#product-behavior)                          | VM       | W1         |      |
| CR03 | ZIP+SHA256 唯一分发格式；无 PRoot/Ubuntu userspace/RPM；PRoot 仅限开发便利                                                                                                            | [Product behavior](requirements/centos7-release.md#product-behavior)                          | VM+人工  | W1         |      |
| CR04 | Electron 28.3.3 + Node 18 兼容依赖构建时切换（undici 6.23.0、better-sqlite3 9.6.0 等精确清单）；切换脚本幂等不回传仓库；`__OMPCODE_CENTOS7_DESKTOP__` 注入                            | [Product behavior](requirements/centos7-release.md#product-behavior)                          | UT+VM    | W1+W2      |      |
| CR05 | sqlite 双运行时：Electron 44 走 `node:sqlite`、Electron 28 走 better-sqlite3，单封装入口；四使用点（cookie/automation/offPeak/taskIndex）数据行为等价                                 | [Product behavior](requirements/centos7-release.md#product-behavior)                          | UT       | W2         |      |
| CR06 | ZIP 内容：node-pty、ssh2（无 sshcrypto 加速器）、原生搜索可执行、glibc 2.17 库与字体、CJK 字形与许可；原生模块 Node 20.19.0 构建、产物入 asar.unpacked 与 resources/tools             | [Product behavior](requirements/centos7-release.md#product-behavior)                          | VM       | W1         |      |
| CR07 | 启动器：`--offline` 激活链（`OMPCODE_CENTOS7_LOCAL_ONLY=1`+透传）、`--profile` 校验与覆盖、`--home` 全量数据重定位与冲突拒绝、`--help` 先行退出；参数矩阵 UT                          | [Product behavior](requirements/centos7-release.md#product-behavior)                          | UT+VM    | W3         |      |
| CR08 | 离线锁定面：公网更新/公网配置帮助社区反馈/账号分享/外部浏览器/遥测调度/在线 bot 全关；入口禁用态+说明、无法禁用触发报错；内网浏览器可用、SSH 可用、仅 omp 达企业 API                  | [Product behavior](requirements/centos7-release.md#product-behavior)                          | VM+E2E   | W3         |      |
| CR09 | 推荐提示词纯本地（本地工具+内嵌图标、无公网动画来源）；锁定模式不调度遥测与用量报告                                                                                                   | [Product behavior](requirements/centos7-release.md#product-behavior)                          | 人工+GUI | W4         |      |
| CR10 | Host 工具进程管道容错：专属管道、EBADF/EPIPE 时经结构化通道继续输出不终止 Host                                                                                                        | [Product behavior](requirements/centos7-release.md#product-behavior)                          | UT       | W3         |      |
| CR11 | workflow tag 校验：main+未占用；空 tag 自动生成 `v<version>-centos7-<run>-<attempt>`；重跑不同 tag；发布 job 用解析输出                                                               | [Product behavior](requirements/centos7-release.md#product-behavior)                          | 人工     | W1         |      |
| CR12 | 并行构建与 tar artifacts 传递（权限/符号链接）；ZIP 组装校验后才发布；全部 job 构建触发 commit                                                                                        | [Product behavior](requirements/centos7-release.md#product-behavior)                          | 人工     | W1         |      |
| CR13 | Electron 44→28 API 差异清单（webUtils/navigationHistory/node:sqlite/fs.glob 等）构建期检查；新增代码不得引入清单外 API；附件拖拽与浏览器历史导航两平台行为一致                        | [Ownership and boundaries](requirements/centos7-release.md#ownership-and-boundaries)          | UT+VM    | W2         |      |
| CR14 | `--no-sandbox` 显式限制、`--disable-gpu` 默认传递且软件渲染可用；重定位不破坏启动                                                                                                     | [Ownership and boundaries](requirements/centos7-release.md#ownership-and-boundaries)          | VM       | W3         |      |
| CR15 | IBus session selection：启动器会话总线对齐（gdbus 校验 PID、两秒限时、歧义不阻塞启动）；自动化回归覆盖分裂总线等场景                                                                  | [Acceptance › IBus session selection](requirements/centos7-release.md#ibus-session-selection) | UT       | W3         |      |
| CR16 | IBus 真实 GUI：公司 Citrix 主机从 tcsh 错误总线环境启动打包启动器并输入中文提交（VM 不等价，单独排期）                                                                                | [Acceptance › IBus session selection](requirements/centos7-release.md#ibus-session-selection) | 人工     | P2         |      |
| CR17 | Package acceptance：VM 非 root 解压启动、CJK 字形、终端与原生搜索、打包 ssh2 握手、命名 profile、`--offline` 双模式网络追踪与入口逐项检查、`--home` 重定位矩阵、GLIBC ≤2.17、ELF 检查 | [Acceptance › Package acceptance](requirements/centos7-release.md#package-acceptance)         | VM       | P2         |      |
| CR18 | Windows 基线保护：版本切换不回写仓库 manifest/lockfile；Windows 产物仍 Electron 44.x 且 `node:sqlite` 可用；CentOS 7 包（Chromium 120）与 Windows UI 走查对比                         | [Acceptance › Package acceptance](requirements/centos7-release.md#package-acceptance)         | VM+GUI   | P2         |      |

## 10. [centos7-performance.md](requirements/centos7-performance.md) — CentOS 7 无 GPU 性能

| 编号 | 需求要点                                                                                                                          | 来源                                                             | 验证方式       | 负责工作流 | 状态 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------- | ---------- | ---- |
| CP01 | 渲染性能策略仅随 `__OMPCODE_CENTOS7_DESKTOP__` 发布构建启用；Web/Windows 保持原行为；标记引用限制在白名单封装模块（扫描测试强制） | [范围与依据](requirements/centos7-performance.md#范围与依据)     | UT             | W4         |      |
| CP02 | UI 根视觉策略：缩短动画、停背景模糊与平滑滚动；保留结束事件/布局/功能；尊重系统减少动画偏好；Windows 构建不减少动画               | [所有者与时序](requirements/centos7-performance.md#所有者与时序) | GUI            | W4         |      |
| CP03 | `MessageResponse` 100ms 合批：首段/完成/中止/替换/身份切换立即显示、取消旧定时器；投影与传输不变                                  | [所有者与时序](requirements/centos7-performance.md#所有者与时序) | UT             | W4         |      |
| CP04 | Main 日志唯一队列：显式常量上限（参考 25ms/4MiB）且被测试引用；同文件合批串行落盘；超限计数报告；错误不传播；Windows 同路径受益   | [所有者与时序](requirements/centos7-performance.md#所有者与时序) | UT             | W3         |      |
| CP05 | `LOCAL_ONLY` 下 Main/Host/Renderer 日志仅 error（序列化前过滤）；功能事件不过滤；未锁定维持原级别                                 | [所有者与时序](requirements/centos7-performance.md#所有者与时序) | UT             | W3         |      |
| CP06 | 正常退出排空共用 ≤1 秒预算；强杀/磁盘失败/超时不保证落盘                                                                          | [所有者与时序](requirements/centos7-performance.md#所有者与时序) | UT             | W3         |      |
| CP07 | 综合验收：合批最终全文一致与发布次数下降、慢磁盘不阻塞事件循环、浏览器验证 CentOS 构建动画与切换、公司环境滚动/打字/流式实测      | [验收](requirements/centos7-performance.md#验收)                 | UT+GUI+VM+人工 | P2         |      |

---

## 执行与回填约定

- 各行状态由对应负责工作流完成自身验证后标注实际结果（通过/失败/跳过+原因），**P2 集成验证是唯一「通过」判定来源**；任何一项不绿不得进入 P3（[refactor-plan.md](test-reports/refactor-plan.md)「P2 集成验证门禁」）。
- Windows 真实界面验收记录落 [test-reports/windows-acceptance.md](test-reports/windows-acceptance.md)；CentOS 7/Linux 侧与 VM 验收记录落 [test-reports/centos7-acceptance.md](test-reports/centos7-acceptance.md)；两份验收文档与本矩阵行号互相引用。
- 环境不可用（VM、frp、公司主机）时如实记录未验证范围，不得以跳过充当通过。
