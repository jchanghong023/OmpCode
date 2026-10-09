# GUI 与 omp 可执行技能对齐

## 产品规则

- 聊天输入的 `$` 候选、`/` 面板的技能命令和「设置 → 技能」都以目标工作区 omp `get_available_commands` 中 `source=skill` 的命令为准。名称去掉 `skill:` 前缀；只显示 omp 当前可调用的技能。`/` 面板显示并可搜索 `/skill:<name>`；TUI 扩展控制中心包含禁用、遮蔽和仅供发现的条目，其总数不是可调用技能数。
- 选择技能后，发送给 omp 的文本使用原生 `/skill:<name>` token；聊天中的可见 chip 仍显示技能名。omp 支持位于用户句子中间的 token，技能正文与参数由 omp 处理，GUI 不扫描并注入另一份正文。
- 技能调用在聊天气泡中复用上游技能 chip（技能名及用户参数），不展开 omp 注入给模型的 `skill-prompt` 正文、目录提示或指导包装。用户原始输入仍用于复制、编辑与提交；普通用户/助手文本不因含技能字样而被隐藏。
- 「设置 → 技能」只展示 omp 可执行目录、查询错误和刷新入口；用户范围与工作区范围均读取其当前目标 Host 的 omp 目录。无打开工作区时不以用户本地目录冒充可用技能，显示空态与打开工作区引导。ZCode 原有的本地技能扫描、安装、导入、删除与开关不出现在该页，避免把本地文件误作 omp 的启用事实。omp RPC 未提供技能管理命令时，设置页保持只读。设置导航保留独立的「技能」入口，进入后展示上述 omp 可调用技能清单；CentOS 7 离线锁定构建同样保留此入口。
- 新草稿按目标工作区当前目录读取；已有会话按该会话 omp 进程读取。未知或不属于目标工作区的会话必须报错，不能回退到工作区目录。远端工作区只查询对应远端 Host。命令目录变化时清理或刷新相应缓存，不展示旧工作区的候选。

## 所有者和接口

```text
omp cwd / profile / source gates → omp 会话的技能快照
  → get_available_commands(source=skill)
  → omp-agent skills/referenceCatalog → Host service → GUI 设置、$ 候选及 / 技能命令
  → /skill:<name> token → 同一 omp 会话执行
```

- omp 拥有技能发现、启用和调用状态；`omp-agent` 仅投影命令目录，不维护第二份扫描或开关状态。Host 保留现有 workspace identity 路由。GUI 草稿和会话目录按请求代次隔离，较早异步结果不得覆盖新目标。命令/技能目录与动态补全由常驻目录进程提供（`get_available_commands`/`complete_command`，规则见 [omp-core-integration.md](omp-core-integration.md)）。
- 目录查询失败时显示加载错误，不回退到本地扫描所得的伪运行时目录。桌面连续链路和 Web 恢复链路均沿用现有 Host service 请求；技能选择不修改 v4 消息序列。
- 技能执行向会话注入的自定义上下文可能随 omp `agent_end.messages` 返回；该历史载荷不参与实时投影校验，不能阻止终态事件收口。回复完成后输入区恢复可发送，任务索引进入完成态。
- 技能上下文仍由 omp 原样拥有并持久化；适配层只控制用户可见投影。实时链路保留已有用户输入，冷恢复从 `skill-prompt.details.prompt` 恢复原始输入，旧记录从 `details.name`/`args` 恢复调用；即使元数据缺失也不回显技能全文，并保留用户调用的轮次边界。旧 GUI 派生 `skill-prompt` 输出不重新进入正文；agent/autoload 注入不冒充用户输入。

## 验收

1. fake omp 返回内置、扩展和两个 `source=skill` 命令：GUI catalog 恰好含两个技能；错误名称、重复项不进入结果。
2. 工作区草稿和现有会话各取对应 omp 命令目录；未知会话报错，命令目录更新后再查询可见新值。
3. `$` 与 `/skill:` 搜索显示与 omp 可执行技能目录一致的候选；`/` 面板用原生命令名称展示，选择后提交的 prompt 含 `/skill:<name>` token；不显示 `skills/referenceCatalog` 未支持错误。
4. 设置页在用户与工作区范围只显示目标 omp 的可用技能；无本地扫描列表、开关和本地管理操作，计数与 omp 可执行目录一致。查询失败显示错误，不显示 ZCode 本地扫描结果。
5. 真实 omp 与同一工作区 GUI 的可执行技能名称集合一致；检查项目技能和用户技能各一个。桌面与 Web 均能读取各自目标工作区；远端不读取本机同名路径。
6. 真实模型从 GUI 调用项目技能，读取工作区文件并显示结果；即使 `agent_end.messages` 含字符串形式的自定义上下文，GUI 仍结束运行状态，冷恢复后保留技能调用与回复。
7. 以 `/skill:<name>  参数` 或句中技能 token 调用后，实时与冷恢复均显示技能 chip 和原始参数/上下文，不显示技能全文；冷恢复保留前后两轮模型回复，不重复生成用户调用。旧版 name/args 元数据、缺失元数据、agent/autoload 注入及旧 GUI 派生输出均不得泄露技能正文；普通可见 custom 仍显示。

## 实现与验证状态

需求从原有权威 FORK 与对应 spec 迁入，未因当前实现降低要求。既有实现及历史验证不等于本次验收；统一证据边界见 [需求索引](README.md#实现与验证状态)。

2026-10-09 技能调用展示修复：适配层不再把 `skill-prompt` 模型上下文投影为助手正文，冷历史从核心元数据恢复用户调用并保留轮次边界，旧派生全文同样排除；GUI 原生 token 复用既有技能 chip。Node 24.14.0 / pnpm 10.33.2 下，`ompCustomMessages`、`coldStoreProjection`、`ompCommandOutputHistory` 的 45 项回归与 `ompSkillMention` 的 2 项边界回归通过；该代码快照的 `fastcheck` 通过（9.3 秒，含类型、Lint、架构和格式检查）。隔离浏览器实际组件冒烟检查了实时/冷投影的技能 chip、参数与回复，以及深色 1100px / 浅色 360px 布局；未调用真实模型，不能替代真实 omp 桌面完整会话及进程重启验收。
