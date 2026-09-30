# OMP 项目模式接入（单项目进程 + 多会话）

本域规定 ZCode 接入 OMP rpc-ui 项目模式（`omp --mode rpc-ui --rpc-project`）的产品规则、状态所有者、接口与验收场景。权威协议需求见 OMP 仓库 `docs-zh-CN/requirements/rpc-ui-protocol.md`（下称「协议需求文档」）；本文件只维护 ZCode 侧的接入差异，不复制其契约全文。与本域相关的既有规则仍以各所属文档为准：模型与命令见 [models-and-commands.md](models-and-commands.md)，技能见 [skills.md](skills.md)，恢复见 [session-recovery.md](session-recovery.md)，子代理与集成见 [integrations.md](integrations.md)。

## 产品规则

- **进程拓扑**：每个 workspace 在 omp-agent 适配器内至多维护一个 OMP 项目进程（`--mode rpc-ui --rpc-project`，cwd = workspace 根），承载该工作区全部会话；不再为每个会话单独拉起 omp 进程，也不再为工作区目录查询另起目录进程。渲染器刷新不终止该进程（进程归 Host 侧 omp-agent 所有）；omp-agent 退出时以 stdin EOF 有序关闭。工具、终端、MCP 等必要子进程不受此约束。
- **能力门控与回落**：项目进程 ready 帧声明 `mode:"rpc-ui-project"` 与 capabilities；omp-agent 必须先 `negotiate_protocol` v3 才使用项目命令。ready 未声明项目模式（如已发布旧版内嵌 omp）时，整体回落到既有「每会话一进程」实现，不混用两种拓扑；回落是能力事实，不是缺陷，不得伪造项目模式可用。
- **会话生命周期**：创建/恢复/关闭/删除/改名分别映射 `create_session`/`resume_session`/`close_session`/`delete_session`/`rename_session`。会话 ID 自创建起即为 OMP 稳定身份，不再依赖本地临时 ID 到文件名 UUID 的迁移；关闭会话默认取消运行中工作后卸载（保留历史），删除会话以 OMP 删除结果为准，失败如实上报。冷历史行仍由本仓从 OMP 会话文件只读投影（文件位置与 OMP 默认会话目录一致）。
- **事件归属**：OMP 帧（消息/工具/交互/命令输出/子代理）统一携带 `processInstanceId`/`sessionId`/`sessionGeneration`；omp-agent 按 `sessionId` 路由到对应会话引擎，交互应答按帧 `id` 原样回发（归属由 OMP 完成）。进程重启后 `processInstanceId` 变化，旧实例迟到帧不得作用于新实例。
- **普通消息输入模式**：项目模式 `prompt` 默认 `inputMode:"text"`——斜杠按普通文本发送；以 `/` 起始的输入由 omp-agent 改经 `execute_command`（严格分发：未知命令报错、绝不发给模型）。流式中的 steer/follow_up 仍按文本处理。`/context` 等内部本地命令读取同样走 `execute_command`。携带图片附件的斜杠输入在项目模式被明确拒绝（`omp_command_attachments_unsupported`），不静默丢弃（`execute_command` 无附件载体）。
- **命令与技能目录/补全**：命令目录事实源为项目级 `get_available_commands`（零会话可用），技能目录继续按其中 `source=skill` 命令投影（`skills/referenceCatalog` 语义不变）。动态补全经项目级 `complete_command`（UTF-16 光标、替换区间、参数提示、无执行副作用）；静态名称过滤仍可在 UI 本地完成，二者合并呈现且过期结果丢弃。`command_catalog_changed`/`skills_changed` 事件使目录与补全缓存失效。
- **子代理过程**：父会话投影继续承载运行中目录与摘要行；已结束目录与记录读取改用项目级 `get_subagents`（按父会话、支持分页）与 `get_subagent_messages`（含 record_too_large 语义）；只读详情以合成 `childSessionId`（编码父会话与子代理身份）订阅 `conversation/<childSessionId>` 打开，内容为已保存记录 + 实时事件，查看不触发新的模型执行。控制操作（`control_subagent` send_message/stop）必须是显式用户动作入口，只读详情默认无副作用。
- **模型两种入口分离**：会话临时切换走会话级 `set_model`（不写配置）；角色持久配置走项目级 `get_model_roles`/`set_model_role`（全部可配置 role 始终可见，含未配置项；逐 role 自动保存，含保存中/失败/被覆盖状态；用户级作用域）。两个入口不得共用同一按钮语义；OMP 未提供项目模式时角色编辑器回落到本地配置文件读写。
- **宿主动作**：`extension_ui_request`/权限/ask 沿用现有 v4 交互回路；OMP 返回的结构化 host action（如打开面板/编辑器/登录链接）由 ZCode 承接呈现，取消不伪装成功。

## 状态所有者与接口

```text
Host（窗口级）→ omp-agent 进程（每 workspace 一个）
  └─ OmpProjectProcess（唯一 OMP 项目进程；ready/v3/请求关联/帧路由/EOF）
       ├─ 项目级命令：会话生命周期、目录、补全、执行、技能、模型角色、子代理目录
       └─ 会话级命令（携 sessionId）→ OmpProjectSessionChannel（实现 OmpSessionProcess 端口）
            → ConversationEngine（投影/订阅/交互代理，与旧拓扑同构）

OMP 身份 ←→ UI 地址投影：sessionId 即 omp 会话 ID；
子代理 childSessionId = `omp-subagent:<subagentId>@<parentSessionId>`（适配层地址）
```

- `OmpProjectProcess` 是进程拓扑唯一所有者；`SessionRegistry` 决定何时创建/恢复/关闭会话并持有「会话 → 通道」映射。`ConversationEngine` 不感知拓扑差异，仅通过 `OmpSessionProcess` 端口交互（端口新增 `projectMode` 事实）。
- 协议方法新增（legacy JSON-RPC，均以能力缺失明确报错，不伪造）：
  - `workspace/completeOmpCommand`：text/cursor/(sessionId?) → complete_command 候选；
  - `workspace/ompModelRoles`：全部 RoleDescriptor（零会话可用）；
  - `workspace/ompSetModelRole`：roleId/scope/selection → 保存后的 role 与修订；
  - `session/controlSubagent`：subagentId/action(send_message|stop)/message → 控制结果。
- omp-agent 与 OMP 的联调启动形态：`OMP_RPC_BINARY_PATH` 指向 bun 可执行、`OMP_RPC_ARGS_JSON` 携带 `["<oh-my-pi>/packages/coding-agent/src/cli.ts"]`（extraArgs 先于 `--mode rpc-ui --rpc-project`）；不修改 OMP 仓库。

## 验收场景（对照协议需求文档 §11.2 Z01–Z15）

1. **Z01** 同一项目 5 个会话共享一个 OMP 项目进程（进程数核对）；切换选中会话不改变 OMP 会话对象；不同项目各自独立进程。
2. **Z08** 现有输入框发送普通消息：流式回答、工具过程、停止与失败提示正确；刷新后内容可恢复且消息不重复发送。
3. **Z03** 输入 `/` 可见命令与技能的说明及补全（含 `complete_command` 动态候选与参数提示），选中后经 `execute_command` 正确执行；未知命令不触发模型。
4. **Z09/Z10** 主对话显示子代理状态卡片；点击打开只读详细过程并持续更新；已结束目录仍可打开详情；关闭重开、恢复历史父会话及重启 OMP 后可读取已保存过程与真实终态，不重新运行子代理；一个父工具的多个子代理与不同父会话不串内容。
5. **Z11/Z13** GUI 临时切模型后发送消息，显示与实际执行模型一致；磁盘 role 配置不变，其他会话不受影响；两类模型操作入口与状态清楚区分。
6. **Z12** 无配置/无账号时仍显示全部可配置 role（含未配置项与自定义项）；选定模型后自动保存无需第二次保存；重启页面和 OMP 后配置一致；保存中、失败、被覆盖、无候选状态真实。
7. **Z14** GUI 能发现并使用 ZCode 原先没有的 OMP 业务命令；详细子代理视图可展开每次工具调用及代理间通信，截断或缺失内容有明确提示。
8. **Z15/Z05** 已开放的控制操作经 `session/controlSubagent` 业务入口执行并呈现返回状态；只读详情保持观察无副作用；渲染器刷新后宿主重建视图、进程存活；OMP 重启后读取历史，不伪造执行完成或重发副作用。
9. **Z02** 技能列表、开关等管理操作准确作用于 OMP（本项以目录/补全/执行为主，完整管理操作按 skills.md 既有验收）。
10. **Z04** 并行会话执行、审批、问题、队列各归其会话；长操作接受不显示为已完成（沿用 session-recovery.md，在项目拓扑下复验）。

核心五项（普通消息、技能调用+补全、内置命令+补全、子代理过程、模型双入口）必须逐项真实 GUI 操作验收并记录证据；协议类型检查或页面可打开不替代操作验收。

## 实现与验证状态

- 2026-09-29 需求定稿；同日完成 Z1/Z2 实施（Z1 进程宿主与映射、Z2 五项能力）。OMP 侧基线见协议需求文档 §17.3。
- 实现：`packages/omp-agent` 新增项目模式层——`adapters/ompProjectProcess.ts`（唯一 OMP 项目进程：ready/v3 门控、按 sessionId 帧路由、EOF）、`adapters/ompProjectGateway.ts`（懒启动/能力判定/崩溃重启/会话通道缓存，app 层经 `ports.ts` 的 `OmpProjectGatewayPort` 消费）、`adapters/ompProjectChannel.ts`（会话级 `OmpSessionProcess` 通道）、`app/projectSessionLifecycle.ts`、`app/sessionIndexTopics.ts`（自 SessionRegistry 拆分）、`app/ompProjectMethods.ts`（四个 legacy 方法）、`app/ompProjectDirectory.ts`（子代理目录/控制）、`app/subagentViews.ts`（子代理只读详情视图，childSessionId=`omp-subagent:<id>@<parent>`）。ready 未声明项目模式（旧内嵌核）时整体回落旧拓扑。`/` 输入经 `execute_command` 严格分发（`ompPromptDispatch.ts`）；`/context` 侧信道同路。协议方法：`workspace/completeOmpCommand`、`workspace/ompModelRoles`、`workspace/ompSetModelRole`、`session/controlSubagent`（shared+services+UI 全链路）。UI：`useOmpCommandCompletion`（动态补全含参数级）、`OmpSubagentControlBar`、`OmpModelRolesDialog` 重写为 RPC 逐 role 自动保存（回落本地配置文件）、子代理目录/状态面板允许 `@parent` 合成地址下钻。
- 自动化验证（全部通过，2026-09-29/30）：`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`（0 违例）；`pnpm --filter @zcode/omp-agent test` 123 项 0 失败 0 跳过，含新增 `test/projectMode.e2e.test.ts`（8 项：单进程多会话、事件按会话路由不串话、流式/完成态、execute_command 严格分发+未知命令报错、complete_command 名称/参数补全、技能目录、子代理卡片/只读详情/已结束目录/控制、临时模型会话隔离+role 目录/保存、删除会话索引反映+EOF）与 fake `test/fixtures/fakeOmpProject*.mjs`；真实内嵌核 E2E（含 v3 fork surface）全部实际执行。
- GUI 真实验收（dev 桌面 + OMP 源码进程 `bun …/cli.ts --mode rpc-ui --rpc-project` + 真实模型 zhipu-coding-plan/glm-5.3-flash，截图 `%TEMP%/omp-accept/`）：Z01 ✅（同工作区 3 会话共享 1 个项目进程，按 cwd 核对）；Z03/O32 ✅（`/` 面板显示 OMP 目录、`/security ` 参数候选、`/model` 执行输出、未知命令报错不进模型）；Z02 ✅（`.agents/skills` 项目技能目录/候选/选中/执行）；Z08 ✅（发送→流式→完成→恢复；多会话回复互不串话）；Z09 ✅（task 子代理真实执行、父会话汇总，运行中详情打开有截图）；Z11 ✅（临时切 GLM-5.3 后会话记录实际模型为 glm-5.3 且 config.yml 未写）；Z12/Z13 ✅（RPC 模式 15 个内建 role 全显含未配置项、选定即自动保存、config.yml 落盘 `commit:`、验证后已清除还原；与临时切换两入口分离）；Z05 ✅（渲染器 reload 后项目进程存活、任务与历史恢复）。部分完成：Z10 已结束目录 GUI 入口未走通（状态面板分区交互未定位；协议/无头层已验证 endedTotal 与 get_subagent_messages 记录读取）；Z14 子代理通信详情展开、Z15 控制条点击操作未做 GUI 实操（控制条已随详情侧栏实现并渲染，协议 E2E 验证 control_subagent 真实状态；只读观察无副作用成立）；Z04 并行会话审批/队列交叉未逐项 GUI 复验。OMP 侧 O19/O28/O20—O22 真实矩阵仍未验证（协议需求文档 §17.3），本次 GUI 验收未覆盖该边界之外的新增验证。
- 联调备注：OMP 从源码启动经 `OMP_RPC_BINARY_PATH=<bun>` + `OMP_RPC_ARGS_JSON=["<oh-my-pi>/packages/coding-agent/src/cli.ts"]`（路径须用正斜杠，反斜杠经多层 env 传递会被吞导致 JSON 解析失败）；内嵌 omp.exe 已随 pre-dev 更新为 v18.4.3+fork.272（支持 v3）。
