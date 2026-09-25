# OmpCode GUI 与 omp 核心能力对齐

## 范围与产品规则

本轮恢复日常 GUI 使用中已经确认的差异：子代理运行与记录、会话操作、omp 原生扩展/MCP、自动化、非图片附件，以及 GUI 验收记录的侧栏重复、上下文选择错误和数据目录文案。具体实现以 omp RPC 和当前 Fork 的 Host / v4 会话协议为边界，不重新启用上游 CLI 运行时。

### 子代理

- omp `task` 工具负责启动和调度子代理。GUI 显示运行中、结束和失败状态，能查看子代理记录；不得把父代理最终回复当成子代理运行证据。
- 新工具行和子代理行首次出现必须发送 `row.appended`，之后才使用 `row.upserted`；桌面实时增量和手机恢复快照应得到相同的行集合。
- 每个 omp 会话进程在 ready 后订阅 `subagent_lifecycle` / `subagent_progress` / `subagent_event`。适配器校验并投影同一子代理 ID 的状态；重连或冷恢复从 `get_subagents` 取快照，记录从 `get_subagent_messages` 读取。订阅失败显式降级并记录错误，不能假装没有子代理。
- omp 的 `get_subagents` 只包含当前进程内作业；完全重启后从父会话 `task`/`wait` 条目还原子代理 ID、状态，并从该会话同名子目录读取子代理 JSONL 记录。读取限制在已验证的子代理文件名和当前会话目录内。
- `ConversationEngine` 是会话子代理投影的唯一 owner；UI 只消费已有 v4 `subagents` 与 `subagent` 行，不创建本地事实源。兼顾 `desktop-continuous` 与 `web-remote-replayable` 的 snapshot / delta 顺序。

### GUI 验收遗留问题

- 新会话从临时 ID 绑定 omp 稳定 UUID 时，session index、legacy list 和持久任务索引必须只展示一条；旧 ID 的订阅/消息路由在迁移期间仍有效，重启后仍保留同一个任务。
- 冷会话文件系统时间戳进入 Host/任务索引前要规范为安全整数毫秒，避免列表校验失败、临时任务未清理。
- omp 会话的 `@` 文件搜索可用。ZCode 插件引用目录不由 omp 提供时，不请求 `plugins/referenceCatalog`，也不显示原始 `-32601`；文件结果和其他可用分组不受影响。
- OmpCode 的数据目录说明使用实际路径后缀 `.ompcode/v2`，中英文一致，不修改存储根的运行规则。

## 所有者与时序

```text
omp task / 子代理事件 → OmpProcess 校验 → ConversationEngine 权威投影
  → v4 snapshot / delta → SessionPane 原有子代理状态面板与记录入口
冷恢复 / 重连 → get_subagents + get_subagent_messages → 同一投影

omp 新会话临时 ID → 绑定会话文件 UUID → SessionRegistry 同一任务索引键
  → legacy list / sessions-index / UI 侧栏

@ 输入 → MentionPlugin 能力分组 → omp 文件搜索 → 文件引用 chip
```

同一子代理的重复生命周期帧按 ID 幂等更新；旧会话事件不得覆盖新会话的投影。首次订阅、恢复和实时事件可能任意顺序到达，快照只替换对应会话的状态。失败的子代理保留结束状态和错误提示，不留永久 running。GUI 不能直接读取 omp 会话文件或调用 `window.zcode`。

## 验收场景

1. fake omp 发出子代理 start → progress → end：v4 快照和增量均含正确 running / ended，原有状态面板可见；重复事件不增加计数。
   首次行增量是 `row.appended`，从订阅快照逐条应用增量后可看到工具与子代理行。
2. 子代理在 GUI 中执行只读任务，能看到运行状态、结束结果和记录；重启恢复同一会话后仍可查看，不重复生成任务。
3. omp 未提供子代理订阅或查询时，界面显示明确不可用状态，普通聊天不受影响。
4. 单次新建任务发送后侧栏始终只有一条；临时 ID 与稳定 ID 迁移后，点击仍打开同一会话，重启一致。
5. 项目输入 `@a.txt` 能选择文件，无 `plugins/referenceCatalog` 原始错误；ZCode 原生模式仍保留现有插件引用行为。
6. 常规设置中英文均显示 `.ompcode/v2`，与实际存储路径一致。

## 后续能力的实现边界

- 会话分支、重试和编辑必须基于 omp `get_entries` / `get_tree` / `branch` 等命令与 Host 已有会话操作接口；不能只改 GUI 消息。工作区回滚只有在能可靠映射 omp 文件变更时开放。
- 扩展、MCP 以 omp 的配置目录和 RPC 状态为事实源；GUI 只管理或展示 omp 原生项，不重新启用 ZCode 插件商店运行时。
- 设置中的扩展/MCP 页列出当前 omp profile 与本地项目 `.omp` 中明确配置的扩展入口和 MCP 服务器名、启用状态；不展示配置里的命令参数、环境变量或密钥。提供打开 omp 配置目录的入口，由 omp 原生配置完成管理。RPC 暂无服务器连接状态和扩展运行态查询，页面明确标为“未提供”，不能把仅有配置等同于已连接或已加载。远程项目不读取同名本地路径。
- 自动化的计划、启停与下次触发由现有调度服务持久化；触发时仍通过 Host 启动 omp 会话执行，运行与结果以该会话为事实源。不得创建第二套 Agent 运行时或将仅打开编辑表单算作执行成功。
- 定时任务表单的模型候选与最高思考档取目标工作区 `workspace-config` 中的 omp 模型目录，与聊天工具栏同源；不依赖旧 ZCode Provider Registry。创建时固定具体 `provider/model:effort`，Host 派发时按此选择启动 omp 会话。omp 全权限运行，表单不展示旧权限模式选择；编辑时保留历史未改动的模型意图。
- 自动化至少验证创建、立即运行、运行记录与暂停/恢复；单纯使保存按钮可点击不算完成。
- 自动化新任务的 Host 终态监听以创建时的临时 task ID 为键。omp 会话文件 UUID 到达后，sessions-index 在该轮结束前保持临时 ID；先发临时 ID 的终态摘要使运行记录结算，再移除临时 ID 并公布稳定 UUID。后续轮次持续使用稳定 ID，不往返切换，也不出现两条侧栏任务。
- 非图片附件中的 UTF-8 文本（`text/*`、JSON、XML、JavaScript、YAML）作为带文件名的文本片段并入 omp prompt；单文件上限 256 KiB，全部文本附件合计上限 512 KiB，非法 UTF-8 必须拒绝。图片仍走 omp image content。
- PDF、视频和其他 omp RPC 不能直接消费的附件在提交前明确拒绝，返回可见错误，不创建空轮次，也不把仅上传成功误报为模型已读取。附件引用不存在时同样拒绝。
