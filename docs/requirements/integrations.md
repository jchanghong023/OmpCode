# omp 原生工具、扩展与自动化集成

## 范围与产品规则

本域保留日常 GUI 使用中已经确认的差异：子代理运行与记录、会话操作、omp 原生扩展/MCP、自动化、非图片附件，以及 GUI 验收记录的侧栏重复、上下文选择错误和数据目录文案。具体实现以 omp RPC 和当前 Fork 的 Host / v4 会话协议为边界，不重新启用上游 CLI 运行时。

### 子代理

主会话的 Agent 交互独立观察 tab（与子代理详情同级）见 [agent-interactions.md](agent-interactions.md)，本域不重复定义通信图与消息聚合规则。

- omp `task` 工具负责启动和调度子代理。GUI 显示运行中、结束和失败状态，能查看子代理记录；不得把父代理最终回复当成子代理运行证据。
- 新工具行和子代理行首次出现必须发送 `row.appended`，之后才使用 `row.upserted`；桌面实时增量和 Web 恢复快照应得到相同的行集合。
- 每个 omp 会话进程在 ready 后订阅 `subagent_lifecycle` / `subagent_progress` / `subagent_event`。适配器校验并投影同一子代理 ID 的状态；重连或冷恢复从 `get_subagents` 取快照，记录从 `get_subagent_messages` 读取。订阅失败显式降级并记录错误，不能假装没有子代理。
- omp 的 `get_subagents` 只包含当前进程内作业；完全重启后从父会话 `task`/`wait` 条目还原子代理 ID、状态，并从该会话同名子目录读取子代理 JSONL 记录。读取限制在已验证的子代理文件名和当前会话目录内。
- 冷恢复须结合父会话的结构化任务结果与已验证归属的子代理记录恢复终态：结果通过 `wait` 接收或通过后台通知自动送达，均保留已结束事实。子代理记录中最新的结构化 `yield` 结果及助手消息 `stopReason` 用于核对成功、失败和中断；之后有未结束的新执行时不得沿用此前终态。历史中的 pending/running 不能作为当前执行证明，缺少可靠终态时显示「状态未确认」，不计入运行数，不伪造成功或失败。
- `ConversationEngine` 是会话子代理投影的唯一 owner；UI 只消费已有 v4 `subagents` 与 `subagent` 行，不创建本地事实源。兼顾 `desktop-continuous` 与 `web-remote-replayable` 的 snapshot / delta 顺序。
- OMP 子代理复用 ZCode 右上角独立「智能体」状态面板、输入区计数与主对话 Agent 卡片。每个子代理按真实 ID 单独展示任务与状态，并通过带父会话归属的 `childSessionId` 打开已有只读侧栏。一个 `task` 启动多个子代理时不得按到达顺序配对或合并成一个代理；已结束后仍保留面板的目录入口和胶囊摘要，冷恢复后同样可打开详情。
- 子代理模型是该子代理的执行事实。智能体状态面板、目录、主对话 Agent 卡片及详情侧栏须显示 OMP 报告的实际模型标识（有 provider 时保留 provider），优先使用已解析模型身份；模型回退或后续执行切换时随真实事件更新。不得把 task 请求的别名、主会话当前模型或角色默认配置冒充子代理实际模型。
- 模型沿同一子代理 ID 进入 `ConversationEngine` 投影与既有 v4 snapshot/delta、目录查询；UI 只消费此事实，不另建模型缓存。冷恢复从已验证归属的子代理持久记录和父 task 结构化结果恢复最近可确认的实际模型；旧记录未提供模型时显示「模型未提供」，不猜测、不影响记录与控制能力。
- 状态面板的子代理紧凑停止入口只取消同一父会话、当前进程权威活跃子代理行对应的工作项，沿真实 `workId` / `childSessionId` 委托原生 `cancel_subagent`；不按名称或位置推断目标，不取消历史、已结束或其他会话的工作。命令接纳只表示停止请求已发出，必须以对应真实请求取消和子代理记录中的中断终态验证停止；重开详情及冷恢复不得伪造成功。
- 主对话的子代理卡片保留启动轮归属。已有真实子代理行时，通过 OMP 提供的 `parentToolCallId` 替代同一父 task 的泛化卡片；没有关联依据或父工具失败时仍保留其详情，不靠名称、到达顺序或超时推断关联。
  辅助对话的所有权、历史与无工具边界只在 [OMP 辅助对话](omp-core-integration.md#辅助对话原生-btw唯一需求权威) 维护，不将 BTW 当 task 子代理或普通会话。

### GUI 验收遗留问题

- omp 会话的 `@` 文件搜索可用。Plugin 引用目录查询由服务层按当前 OMP consumer 已知协议直接请求受支持的 `plugins/referenceCatalog`，不先探测明确不支持的 `plugins/referenceCatalogWithCategory`。OMP 适配器拥有空目录与 session/workspace authority，UI 只消费严格 schema 校验后的响应，不自行合成成功或恢复插件商店；真实远端错误、协议解码错误仍向调用方传播并保留诊断。文件结果和其他可用分组不受影响。

## 所有者与时序

```text
omp task / 子代理事件 → OmpProcess 校验 → ConversationEngine 权威投影
  → v4 snapshot / delta → SessionPane 原有子代理状态面板与记录入口
冷恢复 / 重连 → get_subagents + get_subagent_messages → 同一投影

omp todo 成功结果 → ConversationEngine 的同一会话投影 owner
  → 工具行 output.plan + 会话 plan → 同一 seq 的 snapshot / delta
  → 原有时间线工具详情（按显示开关）+ 独立待办面板（持续显示）
冷恢复 → 最后一条有效 todo 结果 → 同一 plan 状态

@ 输入 → MentionPlugin 能力分组 → omp 文件搜索 → 文件引用 chip
```

同一子代理的重复生命周期帧按 ID 幂等更新；旧会话事件不得覆盖新会话的投影。首次订阅、恢复和实时事件可能任意顺序到达，快照只替换对应会话的状态。失败的子代理保留结束状态和错误提示，不留永久 running。GUI 不能直接读取 omp 会话文件或调用 `window.zcode`。

实现说明（子代理详情订阅）：`SessionDataLayer` 对有效 OMP 子代理详情在最后一个引用释放时立即退订，不进入普通会话的 keep-warm 缓存；同一详情的并存引用仍共享订阅，普通会话保持原延迟退订。重开经既有 Host `SubagentViewStore.acquire` 从源起点重读，由同一 `ConversationEngine` 持有投影：明确缺失时清除旧 transcript 并显示原有「记录不可用（不存在或已清理）」提示，只读条与禁用控件保持；普通传输失败保留 Host 现有内容，不伪装成源丢失。桌面 continuous 与 Web replayable 的协议语义不变。

```mermaid
flowchart LR
  A[子代理详情引用归零] --> B[unsubscribe]
  B --> C[重开详情]
  C --> D[Host acquire]
  D --> E[权威源起点重读]
  E --> F[明确缺失：替换旧记录为不可用提示]
  E --> G[普通传输失败：保留现有内容]
```

验证状态：真实 GUI 运行 `ompcode-core-gui-XAbkCm` 的日志已确认关闭时引用降至零，但重开命中 30 秒 keep-warm，未再次发起订阅，导致未观察已移走的权威记录；已按此生命周期修复，修复后的真实 GUI 验证尚未执行，不能视为通过。

## 验收场景

自动化验收使用真实 OMP 与本地模拟模型，按[本地模拟模型契约](test-gates.md#本地模拟模型契约)执行实际工具、子代理及持久化；本轮固定 yolo、不测工具权限审批及 ask/连续工具调用/子代理界面/Todo 界面的必验范围，唯一见[本轮五项契约](test-gates.md#本轮五项必验与排除范围)。这不是删除产品通用权限或原生命令交互；其他调用规程仅见 [E2E](e2e.md)。

1. 真实 OMP 的子代理产生 start → progress → end：v4 快照和增量均含正确 running / ended，原有状态面板可见；重复事件不增加计数。
   首次行增量是 `row.appended`，从订阅快照逐条应用增量后可看到工具与子代理行。
2. 子代理在 GUI 中执行真实任务，能看到运行状态、结束结果和记录；重启恢复同一会话后仍可查看，不重复生成任务。fulltest/slowtest 的真实 OMP + 本地模拟模型入口及证据分层唯一见[本轮五项契约](test-gates.md#本轮五项必验与排除范围)：实际 task 子代理、ask 作答、连续工具调用与 Todo 经过真实 OMP 和产品 GUI，冷恢复核对其独立持久结果与身份/记录；不以模型脚本或父代理完成文案代替执行证据，不要求工具权限审批。
3. omp 未提供子代理订阅或查询时，界面显示明确不可用状态，普通聊天不受影响。
4. 身份迁移按 [会话恢复要求](session-recovery.md) 验收。
5. 首次打开及重开上下文选择菜单、项目输入 `@a.txt` 能选择文件：目录查询只走当前支持的旧入口，不产生新入口 `-32601` 探测失败；草稿与已有会话分别保留 workspace/session authority。未知字段、畸形条目及真实远端失败仍拒绝，不回退到其它 authority；共享协议的新入口与非 OMP 上游实现不因本 Fork consumer 修复而删除。
6. 数据目录文案按 [有效数据根与只读设置要求](models-and-commands.md#产品规则与所有权) 验收。
7. 真实 GUI 启动两个不同任务的子代理：独立智能体面板与输入区计数显示两个运行项，主对话各有 Agent 卡片；分别打开正确详情。结束后运行计数归零、已结束目录保留两项；冷恢复仍可打开同一记录。无 Git/Goal/Todo 等其他状态时，已结束目录入口仍可见。
   子代理模型验收：两个子代理实际使用不同本地模拟模型，状态面板、目录、各自主对话卡片及详情显示各自实际 provider/model，不串用父模型或另一子代理模型。运行中变更与缺字段进度不得丢失已确认身份；已结束及同根新进程冷恢复显示持久化实际模型，历史未提供模型时明确未提供。分别核对真实模型 HTTP 请求、子代理 JSONL 与 GUI 展示，包含桌面增量及 Web snapshot/delta 语义，不以 task 入参或父回复作为模型执行证据。
8. OMP `todo` 的成功工具结果将完整 phases 清单投影到会话 v4 `plan`，独立待办面板持续显示任务状态与完成进度，不受「显示待办」工具行开关影响。后续更新替换同一清单；失败或畸形结果不覆盖已有清单，明确空清单清除面板。冷恢复及 Web 快照/增量恢复得到相同清单；GUI 可观察 pending → inProgress → completed，并在工具工作组折叠时仍可查看。显示开关必须经真实用户路径「设置」整页 →「常规」分类 →「显示待办 / Show todos」开关操作，再由「返回工作区」回到会话；设置可能记忆其他分类，验收不得假定它是含「关闭」按钮的对话框，也不得直接改写设置状态。开启后验证真实工具卡片与完整清单流程，关闭后工具行隐藏但独立面板仍可见。
   Todo 调用使用真实公开的 `op` / `list` / `task` 等参数，`phases` 只来自成功工具结果，不是模型写入参数。`init` 自动启动最早的 pending 条目；逐步状态验收保留前置活动条目，再用真实 `done` 推进目标条目。独立面板以条目状态和全清单完成进度为准，不假定复制工具详情的状态文案；失败场景仍须通过合法参数触发真实业务失败，不绕过入参 schema 校验。需要观察中间状态时，模拟模型明确等待下一条 GUI 用户指令，保留原生 Todo 提醒机制，不修改提醒配置。
9. 真实主会话并行分配三个子代理，分别创建文件 a、b、c，再广播 `hello`；工具完成、最终回复、运行计数与详情记录一致。主会话完成后重新打开及重启隔离桌面，父会话的 `wait` 结果和后台自动送达结果均得到核对，不残留「工作中」或运行计数；失败、中断和记录缺失分别显示真实终态或状态未确认。三项详情和 Agent 交互页按各自需求验收，不能只以父代理最终回复证明全部通过。
   子代理详情以自身真实工具 ID 验收工具完成与通信正文，不把 `write(agent://…)` 的消息当作文件 diff 或助手最终回复。通信参数保留目标身份，消息正文按原文可读展示，真实送达结果继续显示；后续 `yield` 不覆盖先前工具记录。GUI 验收在当前子代理 Pane 内通过真实历史展开、键盘激活及滚轮浏览，等待布局帧与可见内容，不用高速改写 `scrollTop` 后的瞬时 DOM 缺失推断记录丢失。失败诊断仅记录该 Pane 身份、工具 ID/状态/展开状态和滚动几何，不输出转录正文或工具参数。

## 扩展、自动化与附件边界

- Computer Use 由 OMP 原生实现和配置，OmpCode 不接入 ZCode CUA Helper、broker 或 `zcode-cua` MCP。Host 不探测其安装资源、不注入 broker 环境、不因旧 ZCode 特性开关启动 Helper；保留 OMP 自身工具配置。验收：Windows 启动会话不解析 `runtime-manifest.json`、不启动 ZCode Helper、不产生其不可用告警。

- 扩展、MCP 以 omp 的配置目录和 RPC 状态为事实源；GUI 只管理或展示 omp 原生项，不重新启用 ZCode 插件商店运行时。
- 设置中的扩展/MCP 页列出当前 omp profile 与本地项目 `.omp` 中明确配置的扩展入口和 MCP 服务器名、启用状态；不展示配置里的命令参数、环境变量或密钥。提供打开 omp 配置目录的入口，由 omp 原生配置完成管理。当前 omp RPC 无 `list_mcp_servers`，适配器 `mcp/list` 返回合法空状态快照，不伪造连接事实；设置页仍按配置目录扫描列项，连接状态标注「未提供」。扩展运行态查询同样未提供；远程项目不读取同名本地路径。
- MCP 配置发现由桌面主进程适配器持有，沿用本地 OMP discovery 的原生路径与同名优先级：当前本地项目 `.omp/mcp.json` → `.omp/.mcp.json` → 当前启动 profile 的 agent 目录 `mcp.json` → `.mcp.json`，同名服务器先出现者生效；禁用项也占据该名字，不让较低优先级同名项重新启用。两个文件都须扫描，不能只在 `mcp.json` 不存在时才读取兼容文件；不同名配置合并并保留真实来源。用户级跨来源禁用/强制启用名单仍按 OMP 语义应用，禁用名单优先。文件不存在是该来源的合法空状态，解析或读取失败显式显示配置错误而非「无配置」，其他有效来源仍可展示；不得修改配置、连接服务器或将文件存在标为已连接。
- 浏览器设置页展示 omp 内置浏览器的默认开启状态，状态是说明文字，不是可操作的开关；不查询或修改旧 ZCode Browser Use 插件，也不因不支持 `plugins/list` 而显示错误。omp 浏览器的运行与配置仍由 omp 自身负责，页面不保存另一份状态。浏览器数据导入、清理与证书策略沿用原有入口和行为，不迁移旧插件配置。验收：打开浏览器设置显示「默认开启」，不出现插件查询错误，原有浏览器数据和安全控件仍可用。
- 「钩子」页读取当前启动 profile 的 agent 目录与当前本地项目的 `.omp` 目录，桌面主进程只枚举各自 `hooks/pre`、`hooks/post` 中的 `.ts`、`.js` 文件；展示来源、阶段、文件名和路径，不读取、执行或通过 IPC 返回钩子源码。其他格式、目录及根 `hooks/` 下的文件不伪装成已发现钩子。页面使用现有原生配置快照与「打开目录」能力，不请求 ZCode `plugins/list` 或旧 Hook 存储服务；OMP 会话与实际加载状态仍由 OMP 持有，页面仅列出可发现文件，刷新重新扫描，不把存在文件标为已加载，也不提供不兼容的创建、删除、开关操作。缺少目录时显示空列表并允许打开配置根目录；远程项目不读取本机同名路径；读目录失败显示错误，不静默标为零条。验收：打开「钩子」不出现 `method not supported by omp core: plugins/list`，能看到 profile 与本地项目的 `pre`/`post` JS/TS 文件及来源；不显示其他文件、钩子源码或旧 ZCode 的新增、编辑、信任与启停控件；刷新反映新增或删除；无目录、非本地项目及目录不可读给出准确状态。
- 自动化的计划、启停与下次触发由现有调度服务持久化；触发时仍通过 Host 启动 omp 会话执行，运行与结果以该会话为事实源。不得创建第二套 Agent 运行时或将仅打开编辑表单算作执行成功。
- 定时任务表单的模型候选与最高思考档取目标工作区 `workspace-config` 中的 omp 模型目录，与聊天工具栏同源；不依赖旧 ZCode Provider Registry。创建时固定具体 `provider/model:effort`，Host 派发时按此选择启动 omp 会话。omp 全权限运行，表单不展示旧权限模式选择；编辑时保留历史未改动的模型意图。
- 自动化至少验证创建、立即运行、运行记录与暂停/恢复；单纯使保存按钮可点击不算完成。
- 自动化新任务的 Host 终态监听以创建时的临时 task ID 为键。omp 会话文件 UUID 到达后，sessions-index 在该轮结束前保持临时 ID；先发临时 ID 的终态摘要使运行记录结算，再移除临时 ID 并公布稳定 UUID。后续轮次持续使用稳定 ID，不往返切换，也不出现两条侧栏任务。
- 升级换核只清理旧 CLI 会话投影，不清空自动化计划及运行记录。已持久化的计划、启停、下次触发和历史运行必须保留；迁移失败不能冒称计划已恢复。验收：临时索引库中预置一条自动化计划、成功/失败运行和旧 CLI task，执行换核迁移后仅旧 CLI 会话投影被清理，计划与运行字段逐项保持，迁移再次运行不改变这些记录。
- 非图片附件中的 UTF-8 文本（`text/*`、JSON、XML、JavaScript、YAML）作为带文件名的文本片段并入 omp prompt；单文件上限 256 KiB，全部文本附件合计上限 512 KiB，非法 UTF-8 必须拒绝。图片仍走 omp image content。
- PDF、视频和其他 omp RPC 不能直接消费的附件在提交前明确拒绝，返回可见错误，不创建空轮次，也不把仅上传成功误报为模型已读取。附件引用不存在时同样拒绝。

### MCP 兼容发现验收

1. 临时 profile 与本地项目分别只配置 `.mcp.json` 时，设置页均列出对应服务器及正确来源/启用状态；`mcp.json` 与 `.mcp.json` 共存时不同名合并，同名按项目主文件、项目兼容文件、profile 主文件、profile 兼容文件顺序生效。覆盖同名禁用项与用户级禁用/强制启用名单，结果与当前本地 OMP discovery 一致；不存在、不可读及无效 JSON 区分准确，远程项目不扫描本机同名目录，输出不含命令参数、环境变量或密钥，连接状态仍为「未提供」。

## 工具交互与能力拒绝

- 通用工具详情（含 `wait`）默认只展示有效参数和结果，不展示空对象参数、重复工具名称或整份调试 JSON。Markdown 文本结果按 Markdown 阅读，普通文本保留换行并自动折行；完整工具数据保留在默认折叠的「查看原始数据」入口，展开时才序列化。此规则只改变 UI 展示，工具结果、状态及实时/恢复投影仍由原 owner 持有。
- 验收：展开空参数的 `wait` 时结果仅显示一份，无空参数块和重复 kind；Markdown 标题及代码段可读，窄栏普通文本不产生横向滚动；原始数据可通过键盘展开、查看、折叠，失败信息和快照完整字段加载入口保留。
- 共享参数/结果展示与 MCP 调用详情采用同一空参数规则：缺失、null、空白字符串、空对象和空数组不占用参数区域；`0`、`false` 是有效数据，必须保留。普通文本结果保留换行、自动折行，不按 JSON 高亮；对象/数组及合法 JSON 对象/数组字符串继续使用代码展示。参数、结果和错误标签随界面语言显示。计划指引在失败时优先展示可读错误，不用已提取正文遮住失败原因。
- OMP `write` 发往 `xd://` 等非文件虚拟资源时是设备执行/控制，不是普通文件写入。展开详情必须显示真实工具返回结果，不能仅展示请求 JSON 或以成功写入确认规则隐藏结果；不得创建文件预览、文件链接或 diff 提示。真实文件写入继续使用内容/变更摘要，失败优先展示错误。验收包含设备查询命中、无匹配与缺索引的真实输出及同根冷恢复，缺索引即使 tool completed 也不能冒充命中。
- 验收：覆盖共用组件的空参数、非空参数、零/布尔结果、JSON/非 JSON 文本、中文/英文、失败优先；MCP 空参数且无描述时没有多余调用详情，有描述或实际参数时保留详情；隔离真实组件环境验证原始数据开合、内容保留、窄栏折行与深浅主题。组件验证不代替真实 OMP + 本地模拟模型的产品会话及冷恢复；模型替换范围和能力矩阵按[三级测试需求](test-gates.md#本地模拟模型契约)。

- omp `confirm` 在会话交互面提供接受和拒绝按钮，并能按原请求 ID 回答。未完成交互不得显示无应答入口的遮罩。
- omp 原生 `todo` 工具沿用待办工具身份和「显示待办」设置；`task` 卡片显示实际 agent 类型及任务文本。工具 UI 只读适配器投影，不维护第二套状态。
- 「显示待办」仅控制时间线中的 todo 工具详情；右上角独立待办面板读取同一 owner 从成功结果派生的 v4 `plan`，不由 UI 从工具文本重建。实时顺序为工具结果 → 工具行与 plan 状态更新 → snapshot/delta → 原有面板；冷恢复从最后一条有效 todo 工具结果重建同一状态，不读取或修改 OMP 配置。
- 设置 MCP 页的启用状态按 omp 配置语义计算：服务器 `enabled: false` 与用户级跨来源禁用/强制启用名单均生效；不把配置存在误报成已连接。
- `confirm` 接受和拒绝均能收口；todo 默认隐藏、开启后显示清单；并发 task 可按 agent 与任务区分；不支持的反馈不出现空转操作。
- MCP profile 与项目配置中的禁用和跨来源名单显示与 omp 一致；不显示配置里的密钥或命令参数。

- 会话中隐藏 omp 无法持久化的赞/踩反馈入口，保留复制等其他回复操作。
- ZCode 插件安装/市场不可用，市场入口隐藏；旧 plugins/referenceCatalog 返回合法空目录，桌面不内嵌 ZCode 官方插件运行时与内置技能包。技能的独立需求见 [skills.md](skills.md)。
- omp 子代理的详情读面与控制协议唯一见 [OMP 核心接入](omp-core-integration.md#产品规则)，面板与目录入口按本页「子代理」维护；查看记录不触发新执行，控制结果真实显示。backgroundWorks 中的其他旧任务仍未发起。
- 错峰任务仍不可用；自动化验收须跑通创建、立即运行、运行记录、暂停与恢复。

## 图片附件转发

### 所有权

- v4 `createSession.firstInput.attachments` 和 `sendText.attachments` 中已提交的图片附件，按输入顺序作为 omp `ImageContent`（base64 数据和 MIME 类型）随同一次输入转发。图片正文不进入 v4 command frame。
- `AttachmentStore` 是已上传字节及 MIME 类型的唯一所有者；v4 命令只按附件 ref 读取，不保存第二份附件状态。`ConversationEngine` 继续负责选择 omp `prompt`、`steer` 或 `follow_up`，三种命令都携带同一组图片。
- `AttachmentStore` 同时是 begin/chunk/commit staging 状态与完整性校验的唯一 owner；Host/服务只按公开附件接口转发，不能凭 UI 已计算 checksum 或 schema 合法省略服务端验真。begin 固定 `connectionId` / `sessionId` / `uploadId` 归属、`totalBytes`、`totalChunks`、`checksum`（`sha256:` 加 64 位小写十六进制）及 MIME/文件名，chunk 按 `chunkIndex` 接收解码后的原始字节；commit 只有在完整分片数、精确解码字节总数与原字节 SHA256 全部匹配声明后才发布 ref。字节数与摘要不按 base64 字符数、文本字符数或 MIME 内容推算；零字节上传须为零分片，并匹配空字节串的 SHA256。
- Desktop 文件选择/HTML File/拖拽产生的绝对本机路径 ref，以及远端附件服务已物化在目标 Host 的绝对路径 ref，按目标适配器所在文件系统读取，不能误当成 `omp-attachment://` 上传事务引用。文件 IO 位于适配器边界，经端口注入输入准备流程；复用相同图片/UTF-8 文本类型、数量、单文件及总量限制。读取真实字节后仍按原顺序提交，不仅保留 GUI chip 或把路径文本冒充文件内容；不新增第二份持久附件库或 UI 重传兜底。
- 路径引用只接受当前宿主的绝对文件路径；未知 URI、相对路径、目录、不可读/已删除文件和超限内容明确拒绝整次输入，不启动模型，不回退为空附件。上传事务引用仍只能读取已提交且未过期的真实内容，缺失 `omp-attachment://` 不得改成读本机路径。原生命令首发不消费的草稿附件，在会话提升后仍须可正常发送；引用所有权和上传/暂存/adopt 生命周期由既有 owner 持有。
- 上传暂存字节的有效期仍由 `AttachmentStore` 按 `committedAt` 与 `PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs` 判定：仅超过 TTL 才拒绝新读取，恰好到达边界仍有效，读取和重传不续期。读取必须执行同一过期判据，不能等周期 sweeper 后才拒绝；sweeper 只负责回收。此规则不删除本机/远端源文件、不改变其既有 adopt 生命周期，也不撤回已交给 OMP 的内容或修改已持久化的会话输入。

- 原生文件选择的图片草稿必须显示真实缩略图及原文件名/alt，不能因仅持有本机路径而永久显示通用图标。`useComposerAttachments` 复用 `fileService.readMediaPreview` 异步读取展示数据，并写入既有 `composerAttachmentUploadStore` 的同一附件预览字段；不新增附件/cache owner，不从组件直接调用宿主或使用 `file://`。展示使用 data URL，不新增需要 revoke 的 object URL；已有 HTML File/拖拽 object URL 及其清理规则保持不变，草稿切换/局部卸载仍按既有 owner 保留，删除/清空时随附件释放引用。
- 缩略图读取只影响展示，不修改附件 ref、MIME、原文件字节、上传/ready 状态或选中顺序。scope 切换、移除、发送清空或卸载之后，迟到读取不能重新插入附件或写入新 scope；原生对话框迟到返回也不能注入新草稿。图片预览失败保留正常图标并记录真实错误，不伪造图片、不阻断原有提交校验。Windows/CentOS Desktop 原生路径复用同一服务，Web/HTML File/拖拽已有预览不重复读取，视频及文档图标不改变。
- 验收：通过真实原生选择框依次选择红色 `first.png`、灰色 `second.jpg` 和文本文件，图片 chip 显示相应缩略图，文本 chip 正常；实际提交仍匹配原始图片顺序/ref/sha256。覆盖读取中移除、切换 scope（含 A→B→A）、发送清空和卸载，不出现迟到 chip 或新增 object URL 泄漏；这些是待主代理验证的接受条件，不代表已执行证据。

### 时序与失败语义

```mermaid
sequenceDiagram
    participant UI as UI 附件草稿
    participant Host as Host / 附件服务
    participant Store as AttachmentStore
    participant V4 as V4CommandService / ConversationEngine
    participant Reader as 注入的目标 Host 文件 IO
    participant OMP as omp
    alt 上传事务
        UI->>Host: begin（归属、字节数、分片数、SHA256）
        Host->>Store: 创建 staging
        loop 按 chunkIndex 上传
            UI->>Host: chunk（原始字节的 base64）
            Host->>Store: 校验归属与分片，累计解码字节
        end
        UI->>Host: commit
        Host->>Store: 验证完整分片、精确字节数和 SHA256
        Store-->>UI: 成功发布已提交 ref / 失败不发布
    else 文件选择或目标 Host 已暂存
        Host-->>UI: 真实绝对路径 ref（不重复上传）
    end
    UI->>V4: 输入携带已就绪 refs
    loop 按原始顺序准备每个 ref
        alt omp-attachment 上传引用
            V4->>Store: 只读已提交且未过期字节
        else 当前宿主绝对路径
            V4->>Reader: 异步打开、检查 regular file、有界读取
            Reader-->>V4: 真实字节或明确错误，关闭句柄
        end
    end
    alt 全部内容与类型/大小/编码校验通过
        V4->>OMP: prompt / steer / follow_up 携带 images / 文本
        V4-->>UI: 原有 ACK 与会话投影
    else 任一准备或校验失败
        V4-->>UI: 拒绝整次输入，不调用模型
    end
```

- 上传未提交时仍由现有上传流程处理；非图片 ref 不生成 `ImageContent`。v4 命令的幂等 ACK、会话 owner、桌面 continuous 与 Web replayable 投影语义不变。
- staging 不可被附件 read 或模型输入当作已提交内容。缺片、少字节、多字节、摘要不符或上传归属不符时，commit 返回可见错误，不返回/发布 ref、不标记 committed，也不以不完整字节进入 prompt；上传事务仍可按既有 abort 清理。合法重复 chunk/commit 沿用上传幂等语义，不能重复累计字节或发布另一份 ref；相同 uploadId 的冲突内容不能借重复提交绕过校验。完整性失败不等于附件类型拒绝，两层校验都须满足，正常 UI 与直接调用公开接口采用同一边界。

### 附件验收

附件验收同样使用真实 OMP 与本地模拟模型；上传、文件读取、字节校验和持久化均走实际产品链路，不以模拟附件存储或界面 chip 代替。

1. v4 `createSession` 首发和已有会话的 `sendText` 均可将已提交图片的原始字节及 MIME 类型经真实 OMP 传给本地模拟模型；多图按输入顺序传递。
2. 混合图片与 PDF 时整次提交明确拒绝，不创建空轮次或静默丢弃 PDF；无附件时不携带 `images` 字段。UTF-8 文本按本文件规定转发；缺失引用、非法编码及超限输入均拒绝。
3. 流式中的 `guide` 和 `queue` 输入继续分别使用 `steer` 与 `follow_up`，并携带所提交的图片。
4. **F008 / 公开上传完整性**：通过真实 begin/chunk/commit 协议上传多分片图片与 UTF-8 文本，commit 后读回的字节、MIME 及 SHA256 与 begin 声明一致，模型消费收到原字节。声明 2 字节却仅上传 1 字节（分片数齐全）、超过声明长度、缺片，以及字节数相同但 SHA256 错误分别明确拒绝，不发布可读取 ref、不标记 committed、不启动模型轮次；不能以 UI 正常不会构造该输入免除校验。
5. **F008 / 边界与幂等**：零字节/零分片配正确空串摘要可完成上传（消费类型限制不变），错误空串摘要拒绝；重复合法 chunk 不增加字节数，重复合法 commit 返回同一 ref，冲突分片/声明及跨 session/connection 提交不绕过验证。失败后 abort 清理 staging，既有已提交附件不受影响。
6. **本机/目标 Host 路径消费**：经公开 v4 首发和续发入口提交真实临时 UTF-8 文件和图片路径，传给核心的内容与原文件一致；已上传引用与路径混排仍保序。相对/未知 URI、缺失文件、目录、非法 UTF-8、类型/数量/大小超限及过期上传 ref 明确失败，不调用模型。过期场景须真实上传并 commit 后超过 TTL，在 sweeper 尚未执行时从 `createSession` 和 `sendText` 分别消费；整次拒绝，不新增用户输入、空轮次或会话持久化内容，之后普通输入仍正常。真实隔离桌面从原生工具首发提升会话后，未提交正文与附件仍可见，随后普通发送须经真实 OMP 将附件原字节提交给本地模拟模型，并核对会话结果与冷恢复，而非仅证明 chip 保留。

无附件的文本输入和 legacy 图片转发路径保持可用；不迁移历史会话或附件。已上传/可回读不等于 omp 能消费，不能据此跳过提交校验。

## 实现与验证状态

- 2026-10-09 工具详情展示：共享参数/结果、MCP 空详情及计划错误优先已实施；`fallbackToolPresentation.test.tsx` 与 `toolContentPresentation.test.tsx` 合计 7/7 通过，独立 Electron 组件验收 light/dark × 1100/360 四组通过，相关文件 Lint、格式与架构检查通过。证据目录：`C:/Users/jiang/AppData/Local/Temp/ompcode-tool-presentation-9i2IpA/`。前期组件脚本曾因语法、Vite 监听 Electron 缓存和重复测试中的开合状态失败，修正测试环境后重跑通过；不沿用失败轮次。
  本次基于 HEAD `c0873fa3733fe6208161323b4d20df96a52d74c8` 的未提交展示/测试差异，12 个变更 packages 文件按路径排序并逐项拼接路径与原始字节的 SHA256 为 `5a9fb9e9aaf14164c8f20fd6db9f8f0a4d954d537799df920984889ad6f7815c`；工具为 Node 24.20.0、pnpm 10.33.2、Electron 44.4.5。`fastcheck` 因要求 Node 24.14.0 而在执行前失败；未运行完整门禁或完整产品会话/冷恢复验收，不宣称整体项目通过。

需求从原有权威 FORK 与对应 spec 迁入，未因当前实现降低要求。既有实现及历史验证不等于本次验收；统一证据边界见 [需求索引](README.md#实现与验证状态)。

- 2026-10-09 核心体验续作：F004 的原生/兼容 MCP 配置发现与部分错误定向回归通过；F008 的声明长度、摘要、分片/幂等/归属拒绝与合法附件读回/转发通过公开 stdio 协议及 fake-omp 入口验证，纳入 OMP 全集 374/374、0 跳过。真实组件的附件引用与 pending 场景通过，不声称图片完整会话或产品上传 GUI 链路通过；具体证据及完整门禁边界见 [核心体验续作验收](../test-reports/performance-hot-paths-2026-10-09.md#核心体验续作验收)。未恢复商业账号或付费套餐。

- 2026-10-17 原生面板首发的真实附件续发：已修复草稿附件 owner 提升及绝对路径 ref 消费，路径文件经 CLI 注入的异步 reader 与上传事务字节使用同一输入校验。`ompLocalAttachmentInput.test.ts` 5/5 通过；Windows 隔离产品实际执行 `/goal show` 后保留正文和 `mbist.md`，历史会话链路完成。证据：`%TEMP%/ompcode-four-deliverables-HopN5z/final-attachment-success.json` 与同名 PNG。未运行 CentOS/shm/NFS 或图片完整会话验收；不沿用前期 `attachment reference missing` 的失败轮次为通过。
