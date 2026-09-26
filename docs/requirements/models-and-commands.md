# 账号、omp Profile、模型与命令

## 产品规则与所有权

- 换核后 ZCode 账号体系整体废弃：启动登录门禁永久关闭、侧栏账号/套餐/用量 footer、命令面板登录登出、会话套餐配额横幅全部移除；凭据与模型走用户本机 omp 配置。

- omp 的模型目录是会话模型候选的事实源；`~/.omp/agent/config.yml` 中的 `modelRoles` 是角色配置事实源。Desktop Main 负责配置文件读写，UI 仅通过 `IPlatformService` 请求。模型目录更新由 workspace-config topic 推送，UI 不另建模型缓存或账号目录。
- 工作区恢复取得的 presentation 只拥有 mode 与 slash command 元数据，不得用仅含 mode 的结果覆盖 workspace-config topic 已下发的 omp 模型及思考档位目录。并发顺序无论先后，store 合并时各自保留其所有者字段；重复恢复不清空目录。
- workspace-config 的已接受快照由 Host syncer 在当前 workspace ingest 状态内保留最后一次投影；动态 UI 监听者注册时立即收到这一投影。这样初始 topic 帧早于设置页或侧栏监听时，目录不会因一次性事件丢失；runtime 换代时由新快照替换。
- 工作区首次 presentation 读取同时返回 omp 的模型目录快照，确保尚未建立 v4 background 订阅的冷启动设置页也有候选；后续更新仍由 workspace-config topic 投影。适配器复用同一个目录加载 flight 与结果，避免两个入口同时拉起目录进程。
- omp 的 `get_available_commands` 是斜杠命令目录事实源；workspace-config 与首次 presentation 返回同一命令投影。目录至少包含名字、描述、输入提示和来源，未知来源映射为自定义。命令目录加载失败时应显式记录并返回空目录，不影响模型目录。
- 本地斜杠命令的 `command_output` 投影为该轮文本；`prompt` 响应 `agentInvoked: false` 或关联 request id 的 `prompt_result: false` 必须结束轮次，即使没有 `agent_end`。晚到或无关的完成帧不能关闭后续轮次。
- `prompt_result` 仅在 `agentInvoked:false` 且属于当前本地命令时收口；agent 已启动的终态只由 `agent_end` 决定，失败和中断结果不得被后续完成帧改写。重复收口不产生状态补丁。
- Host 启动 omp 适配器不依赖旧 ZCode Provider Registry 的 provider/model 就绪门禁。适配器先启动并从 omp 读取目录，提交时才校验所选模型；omp 无可用模型时由其自身返回明确错误。
- 首屏及会话输入区不展示旧 ZCode 的“当前没有可用模型／升级／配置”横幅；旧注册表为空不能阻断 omp，真实 omp 错误仍按错误码展示。
- 更改角色时只改用户选择的 role，保留配置文件其他字段、注释与未触及的 role。写前备份，写入失败时原配置可恢复。模型名中的冒号属于模型 ID，只有目录确认的思考档位后缀才按档位解析。
- 角色选择器允许在模型支持的档位中选择思考等级。切换模型时保留新模型也支持的原等级；不支持时使用新模型的缺省等级，未设置缺省则不写档位后缀。
- omp profile 选择由 App Settings 持久化；Desktop Main 启动时读取并通过 `OMP_PROFILE` 传给 Host/内嵌 omp。默认或已有命名 profile 来自 omp 配置根目录，角色配置与历史扫描使用同一 profile 路径。保存后只标记待重启，不能热切换现有会话；待重启时角色编辑器不写旧 profile。
- 任务索引是 omp 会话的本地投影，必须按已启动的 profile 分库；默认 profile 保持现有 `tasks-index.sqlite` 以保留历史，命名 profile 使用独立数据库，切回时仍可看到原 profile 的索引。Host 启动准备与所有索引 Repo 必须解析到同一路径，避免在 UI 混入其他 profile 的任务。
- 设置侧栏“模型设置”直接展示各 omp role 的选择器；会话工具栏“管理模型”复用同一编辑器。两处只允许选择 omp 目录已有模型，不提供供应商或模型新增操作。

## 时序与失败语义

```text
用户选择 role 模型 → UI 请求 Main → Main 读取并校验当前 YAML
  → 仅修改目标 role → 备份原件 → 原子替换配置 → UI 显示结果

用户选择 profile → App Settings 持久化 → UI 提示重启
  → 下次 Main 启动读取设置 → Host/omp 继承 OMP_PROFILE
  → 会话、目录和 modelRoles 同时切换
```

配置不存在、YAML 语法无效、`modelRoles` 类型错误或保存失败时显式报错；不创建一份可能覆盖用户配置的新文件。重复保存同一内容不创建无意义备份。

## 验收场景

1. 隔离桌面开发态不配置任何 ZCode Provider Registry，首屏不出现旧模型横幅，Host 仍启动 omp 适配器并显示其模型目录；从 omp 历史恢复会话、订阅消息；新会话选择 omp 模型，发送后流式展示、工具写文件并能再次恢复。
2. 设置侧栏“模型设置”打开后直接列出已配 role 与 omp 目录，且不出现“添加供应商”；更换含冒号模型 ID 的 role 并保存。重新打开仍显示正确模型，配置文件其他字段、注释、未触及的 role 保留，备份可恢复原件。
3. 无配置、无 role、无模型目录、无效 YAML 和保存失败均有明确状态，不允许静默落入 ZCode 模型目录。
   3a. workspace-config 先于工作区恢复或反过来先到时，设置页与 composer 都持续显示 omp 模型目录；冷恢复已存在任务后仍可编辑 role。
   3b. 隔离桌面实例准备默认与命名 profile 的不同模型/角色配置及历史任务；切换 profile 保存后仍显示待重启且不改旧配置；重启后只显示目标 profile 的角色、目录与历史会话；切回默认 profile 后原任务仍可见。
   3c. fake omp 返回含内置与自定义命令的目录；工作区 presentation 与 workspace-config 均能展示这些命令，输入框输入 `/` 能补全。真实 omp 二进制也能返回合法目录。本地命令同步或延迟完成时，输出可见且会话控制恢复空闲。
4. 源码类型检查、lint、omp 协议 E2E 与架构检查通过；GUI E2E 使用当前源码的开发态运行，不执行安装包生成。

## 命令路由与角色覆盖

- omp 当前目录中的内置斜杠命令（如 `/model`、`/switch`、`/compact`、`/rename`、`/mcp`、`/usage`）在对话输入框可用；目录变化（`available_commands_update`）实时推送刷新补全面板；`skill:*` 命令在技能候选分组展示。
- `/rename`、`/model` 等的状态回投（`session_info_update`/`config_update`/`model_changed`）同步到会话标题与模型状态。
- UI 本地拦截让位：命令名命中 omp 目录时按 omp 语义透传执行（如 `/model`、`/switch`、`/usage`）；仅 `/compact`/`/compress` 保留本地 v4 映射（与 omp `/compact` 等价且排队/时间线集成更好）。omp ACP 目录未分发的命令（`/plan`、`/goal` 等 TUI-only 命令）不受影响，仍按 [FORK 能力边界第 5 项](FORK.md#已知与允许的差异) 处理。
- 多角色（`modelRoles`）按本文件角色配置规则在设置与会话工具栏完整适配，角色清单与 omp 内建角色（default/smol/slow/vision/plan/commit/tiny/memory/task/advisor/image/web/speech/dictation/judge）一致并随配置追加自定义角色。

技能目录与调用见 [skills.md](skills.md)；提交时的临时模型选择见 [composer.md](composer.md)；恢复、guide/queue 及文件变更事实见 [session-recovery.md](session-recovery.md)。

验收还应检查：登录/套餐/配额入口全部移除；命令热更新、重命名和模型状态回投可见；命中目录的命令由 omp 执行，压缩保持既有映射；真实失败不能呈现为成功。

## 实现与验证状态

需求从原有权威 FORK 与对应 spec 迁入，未因当前实现降低要求。既有实现及历史验证不等于本次验收；统一证据边界见 [需求索引](README.md#实现与验证状态)。
