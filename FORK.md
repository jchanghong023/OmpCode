# Fork 与上游差异

本仓库 fork 自上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 `main` 分支，仅供个人使用，持续同步上游。本 Fork 的目的：把 ZCode 的 Agent 核心替换为 omp（oh-my-pi）的 RPC 核心，保留 ZCode 的全部用户界面与交互形态。

本页面向本人和 AI agent，只记录相对当前上游基线仍有效、对使用者有影响的差异需求，不记录实现细节、修复或同步历史。开发规则与上游同步的操作规则见 `AGENTS.md`。

## 当前上游基线

- **分支**：`zai-org/ZCode@main`
- **版本**：`v3.14.3`
- **Upstream commit**：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`
- **同步日期**：2026-09-24

版本以提交说明与 README 更新记录为准；上游基线按最后合入的提交记录，不按本 Fork 的包版本推断。

## 本 Fork 的目的

把本地 Agent 核心从上游 `apps/zcode-cli`（Agent CLI 与运行时）替换为 omp 的 RPC 核心，ZCode 侧通过适配层对接。产品形态、全部界面与既有双链路语义保持不变；omp 自身的功能演进在其自己的 fork 仓库进行，本仓库只消费其 RPC 核心能力，不重定义 omp。

### 账号体系移除与模型/插件面 omp 化（2026-09-24 追加需求，已实现）

- 换核后 ZCode 账号体系整体废弃：启动登录门禁永久关闭、侧栏账号/套餐/用量 footer、命令面板登录登出、会话套餐配额横幅全部移除；凭据与模型走用户本机 omp 配置。
- 设置侧栏「模型设置」直接编辑 omp 各个 `modelRoles`；会话工具栏「管理模型」打开同一编辑器的对话框。每个角色可以选择 omp 现有模型及该模型支持的思考等级。角色清单与写入目标为当前 omp profile 配置文件的 `modelRoles:`（yaml Document 级替换保留注释，写前自动备份）；只能从 omp 现有模型目录（workspace-config 投影）选择，不提供 ZCode 供应商或模型新增入口。
- 设置页可选择当前设备已有的 omp profile（含默认 profile）；不同 profile 使用各自的配置、模型目录和历史会话。修改选择后明确要求重启应用，重启前仍使用原 profile，避免同一运行期混用两套状态。
- 插件市场入口隐藏（差异 #1 的 UI 落实）；恢复历史会话的首次订阅失败自动强制快照重连（至多 2 次），不再要求手动点「重新连接」。
- 设置侧栏「模型设置」已替换旧模型供应商页；账号与供应商新增入口不在该页展示。

### omp 内置命令全量支持与临时模型（2026-09-25 追加需求，已实现）

- omp 当前目录中的内置斜杠命令（如 `/model`、`/switch`、`/compact`、`/rename`、`/mcp`、`/usage`）在对话输入框可用：命令目录来自 omp `get_available_commands`（含名称/描述/输入提示），目录变化（`available_commands_update`）实时推送刷新补全面板；`skill:*` 命令在技能候选分组展示。
- GUI 聊天的 `$`、`/` 技能候选与设置页技能列表均使用目标工作区或会话的 omp `get_available_commands` 中 `source=skill` 的可执行目录；选中后按 omp 原生 `/skill:<name>` token 调用。TUI 扩展控制中心还显示禁用和遮蔽的发现项，不能用其总数冒充可调用数。设置页不显示 ZCode 本地扫描技能和本地安装、删除、开关入口；只按 omp 工作区可调用技能计数、搜索。详细规则见 `docs/specs/omp-skill-parity.md`。
- 本地型命令（不触发 agent 轮）在 UI 正常收口：命令输出投影为会话内可见文本，`agentInvoked:false`/`prompt_result` 完成收口不悬挂；`/rename`、`/model` 等的状态回投（`session_info_update`/`config_update`/`model_changed`）同步到会话标题与模型状态。
- UI 本地拦截让位：命令名命中 omp 目录时按 omp 语义透传执行（如 `/model`、`/switch`、`/usage`）；仅 `/compact`/`/compress` 保留本地 v4 映射（与 omp `/compact` 等价且排队/时间线集成更好）。omp ACP 目录未分发的命令（`/plan`、`/goal` 等 TUI-only 命令）不受影响，仍按本地语义（差异 #5）。
- 多角色（`modelRoles`）按上方 2026-09-24 需求在设置与会话工具栏完整适配，角色清单与 omp 内建角色（default/smol/slow/vision/plan/commit/tiny/memory/task/advisor/image/web/speech/dictation/judge）一致并随配置追加自定义角色。
- 临时模型：会话工具栏模型/思考档选择随每次提交下发（`set_model` + `set_thinking_level`，会话级、不写 omp 配置文件）；`createSession` 首发与后续 `sendText` 均生效，重复相同选择不重复下发。

### 桌面输入区状态与快捷操作（2026-09-25 追加需求，已实现）

- 电脑窗口在原有聊天输入框工具栏内展示计划模型、上下文用量、当前 Git 项目分支及改动文件数和压缩操作，模型与思考档沿用原入口且不重复；omp 默认全权限，隐藏原权限/模式选择控件。上下文弹层展示 omp `get_state` 总量及本地 `/context` 返回的估算分项、空闲空间、自动压缩预留区；分项不可用时仅显示总量，读取不得生成聊天消息。窄电脑窗口仍显示分支名，手机布局不增加入口。思考档位按 omp 模型目录的 `thinking.efforts` 提供（包含模型支持的「低 / 高 / 最高」）；新任务及手动选择模型时取当前模型支持的最高档，之后手动选择的档位会保留。复用现有 Composer 模型选择、v4 会话投影和宿主 Git 状态，不另建事实源。
- 提供「计划模型」切换按钮：读取当前 omp profile 的 `modelRoles.plan`，只临时切换当前会话的下一次提交；显式档位按角色配置，未配置档位时取计划模型支持的最高档；再次点击恢复切换前的模型与思考等级。不会修改 `modelRoles`，也不启用 omp Goal 或协作计划模式。
- 提供手动压缩和自动压缩开关：手动压缩复用已有 v4 `compact`；自动压缩读取 omp 会话实际状态并通过 RPC `set_auto_compaction` 修改，成功回投，失败保持原值。详细时序与验收见 `docs/specs/omp-composer-desktop-status.md`。

### 数据与端口隔离（2026-09-25 追加需求，已实现）

- 本应用全部业务数据根由 `~/.zcode` 改为 `~/.ompcode`（配置 v2、日志、任务索引、会话快照、凭据、CLI 配置、skills/commands/plugins 同步目录、telemetry、computer-use 运行日志等），Electron userData（`%APPDATA%/OmpCode`）与单实例锁本就按产品名隔离；不读取、不迁移、不写入上游 ZCode 的 `~/.zcode`。workspace 内同名配置目录（`.ompcode/`）同样与 ZCode 的 `.zcode/` 错开。
- Windows 资源管理器右键菜单注册表键、electron-updater 缓存目录（`ompcode-updater`）改为 OmpCode 专属，双装不互相覆盖。
- 正式安装包仅从本仓库 GitHub Release 手动获取更新；本 Fork 没有专属更新 feed 时，不查询或安装上游 ZCode 的自动更新，也不受上游强制更新线阻止启动。
- 端口隔离：本地开发远程调试端口 9230（上游 ZCode Dev 用 9229）、桌面 devServer 5194（上游 5174）、Web devServer 5193（上游 5173）、server 包默认端口 3033（上游 3030）；运行期本地服务一律 `listen(0)` 临时端口（不变）。深链 scheme `zcode://` 与 appId 仍按「内部标识不动」约定保留（见已知差异 17）。

- 隔离实测：应用运行期仅写 `~/.ompcode`（v2 日志/任务索引/设置/runtime），`~/.zcode` 全程零新增写入（快照对比归因：期间写入方为本机 zcode CLI 会话与用户自装的 `C:\Program Files\ZCode\ZCode.exe`，与本应用无关）；监听端口仅 9230（dev CDP）与 5194（devServer），无 9229/5173/5174/3030 占用。

验收结果（2026-09-25，本节与「omp 内置命令全量支持与临时模型」一并验收）：

- 协议级 E2E 14 例全过（本地命令输出/收口、`prompt_result` 异步收口、`session_info_update`/`config_update` 回投、`available_commands_update` 目录热推送、`modelSelection` 下发与去重、供应商错误 `stopReason=error` failed 收口）；真实二进制 E2E 3 段全过（`/rename` 本地命令 + `sendText` 临时模型切换 glm-5.3-flash 真实出话 + `/model <selector>` 原生命令回投）。
- 桌面 GUI 实测（Windows dev，CDP 驱动，glm-5.3-flash）：斜杠面板为 omp 真实命令目录（93 条，含 skill 命令）；`/rename` 输出投影与标题回投、轮次正常收口；模型下拉按 omp 供应商分组（286 模型），临时模型 glm→ling→glm 往返均有「模型已切换」时间线标记，未授权模型 401 在 UI 显式呈现错误与反馈入口；glm-5.3-flash 真实回复（思考档 max）；设置「模型设置」15 个内建角色与 omp 一致。

### 侧栏显示菜单更名（2026-09-25 追加需求，已实现）

- 侧栏左下角的偏好菜单入口（界面语言/界面主题/界面模式/界面缩放）由「设置」更名为「显示效果」（英文 Display），与右侧打开完整设置页的齿轮「设置」按钮区分；仅改入口文案与 aria 标签，菜单内容与设置页不变。

## omp 侧依赖

- 来源：本人维护的 fork `jchanghong023/oh-my-pi`（本地工作目录 `D:\code1111111111\oh-my-pi`；上游为 `can1357/oh-my-pi`）。
- 接入形态：`omp --mode rpc-ui` 启动的核心——stdio 上的 newline-delimited JSON 协议，含 ready 帧、协议版本协商、命令/响应关联、会话事件、工具交互 UI 请求与 host 工具请求。
- 接口参考与测试基线：接口与协议开发参考本地源码 `D:\code1111111111\oh-my-pi`（协议细节含该仓库 `docs/rpc.md`）；实际测试（含换核验收 E2E）使用 releases 实际内嵌的发布版本二进制执行，不以本地源码的未发布改动为测试对象。
- 分发：随 ZCode 安装包内嵌——打包时取该 fork GitHub releases 页面（`https://github.com/jchanghong023/oh-my-pi/releases`）的最新版本二进制，内嵌进应用资源并由应用拉起；用户无需单独安装 omp。不依赖上游 oh-my-pi 的 npm / Homebrew / Nix / `omp.sh` 分发。
- Windows x64 桌面版通过 GitHub Actions 手动发布：从 `main` 输入与当前版本匹配的唯一 OmpCode 标签，打包后将安装 EXE 与 SHA256 校验文件上传到本仓库 GitHub Release；发布流水线不单独运行测试。
- CentOS 7 x64 桌面版由长期维护、不会合入 `main` 的专有分支 `experiment/centos7-no-proot` 发布：先在 CentOS 7 虚拟机以普通用户完整验证应用、内嵌 omp 与终端，再修改独立的 GitHub Actions 手动发布流水线，从该分支输入与当前版本匹配且以 `-centos7` 结尾的唯一标签，产出自包含 ZIP 与 SHA256 校验文件。此分支专用 Electron 28、兼容 Node 18 的依赖及按 glibc 2.17 重编的原生模块；不要求维持 Windows 构建。用户在 HOME 内解压即可运行，无需 root、网络、另外安装运行时包或使用 PRoot；ZIP 内置附许可证的简体中文字库，在宿主没有中文字库时设置、菜单及会话中文也必须正常显示。ZIP 不升级宿主 glibc/Node，也不覆盖用户已安装的 omp。需要可用的图形会话；Chromium 沙箱在无需 root 的解压环境下不可用，使用时应避免不可信工作区。
- 内嵌 omp 的配置与边界：内嵌拷贝与用户已安装的 omp 使用完全相同的配置（同一配置、凭据与会话数据来源），行为与用户日常使用的 omp 保持一致；NEVER 覆盖、替换、修改或代为安装用户已安装的 omp，内嵌拷贝只存在于 ZCode 应用资源目录内。
- 进程与端口边界：内嵌 omp 只以子进程形态经 stdio 通信，不监听任何端口；绝不探测、复用、终止或以其他方式影响用户机器上已在运行的 ZCode / omp 进程。本仓库自建的任何本地测试服务一律使用 `listen(0)` 临时端口，发生端口冲突时换临时端口重试，不占用固定端口。
- 测试模型约定：换核验收 E2E 与 UI 验收的真实模型使用用户 omp 配置的 `zhipu-coding-plan/glm-5.3-flash`（走用户 omp 既有凭据）；协议级 fake-omp E2E 不依赖真实模型。审批等测试态一律用 omp 运行时 flag（如 `--approval-mode`）注入，不修改用户配置文件。

## 差异需求（实现状态）

以下需求已实现并通过对应验证；无法等价提供的能力全部列入「已知与允许的差异」。

### Agent 核心替换为 omp RPC-UI 核心（已实现）

目标：桌面、Web 与手机远控的全部用户界面保留，本地 Agent 核心由 `omp --mode rpc-ui` 提供；omp 工具与扩展发出的选择、确认和文本输入在现有会话交互面应答。上游 `apps/zcode-cli` 仅作为未接入 workspace、构建或分发的源码快照保留，不作为运行时或回退路径。

实现形态：`packages/omp-agent` 适配器对 ZCode host 讲 ZCode Protocol（legacy 控制面 + v4 数据面 wire 帧），对内嵌 omp 二进制讲 omp RPC-UI；每个 ZCode 会话对应一个惰性启动的 omp 子进程，omp 拥有会话/模型循环/工具执行/配置/凭据的全部权责。工具 UI 请求由适配器映射到既有交互协议，应答按请求 id 返回。host 侧拉起链路（`resolveDefaultZCodeAgentCommand`）与桌面打包（`resources/glm/omp-agent.cjs` + `resources/glm/omp/omp.exe`）指向适配器；内嵌 omp 取 releases 最新版，`omp/omp-release.json` 记录 tag 与 SHA256。

行为边界与落实：

- 对话流式输出、工具调用展示、权限确认、会话管理、文件变更展示：v4 conversation 投影（rows + state patch）按上游 wire schema 产出，全部下行帧经 `conversationTopicWireFrameSchema` 校验。
- `desktop-continuous` 实时链路与 `web-remote-replayable` 恢复链路：同一投影、按订阅 `clientMode` 区分；断线重连按水位续传（delta log 有界保留，超界回退整快照 resync），两种语义不因换核回退。
- omp RPC 帧格式不渗入 UI：适配层内闭环（`packages/omp-agent` 独占 omp 协议词汇）；工具 `ask` 的选择与文本输入复用 ZCode 原有的 `ElicitationDialog`，选项说明保留，「其他」由随后文本请求继续输入。
- 无法等价提供的能力：见「已知与允许的差异」逐项。

验收结果：

- 协议级 E2E（`packages/omp-agent/test/adapter.e2e.test.ts`，fake omp 核心）：新建会话 → 流式 → 工具调用 → 权限确认（双向应答路径）→ 文件变更（摘要+查询）→ 完成/中断收口，全部通过；全部 v4 帧通过共享包 wire schema 校验。
- 真实二进制 E2E（`packages/omp-agent/test/real-omp.e2e.test.ts`，releases 实际内嵌 omp.exe + commandcode 免费模型）：createSession → 流式输出 → write 工具 → 审批确认 → 文件真实落盘 → 会话完成，通过。
- 桌面打包产物（Windows x64，`pnpm bundle:desktop -- --os=win --arch=x64`）：`win-unpacked/OmpCode.exe` + `resources/glm/omp-agent.cjs` + `resources/glm/omp/omp.exe`（内嵌 omp v18.2.11+fork.239，SHA256 校验通过）验证在包内；asar 内品牌为 OmpCode。NSIS 安装器 `OmpCode-3.14.3-win-x64.exe` 已在本机成功生成，运行时依赖闭包与体积检查通过；安装器未签名，GUI 级自动化 E2E 尚未执行。

### 产品名称更改为 OmpCode（已实现）

目标：本 Fork 的产品名称由 ZCode 更名为 OmpCode，作为对用户的唯一产品身份。

行为边界：

- 更名覆盖用户可见的品牌与文案：应用名称、窗口与界面标题、关于页及标识文案等。
- 对上游的引用保持不变：上游仓库名（`zai-org/ZCode`）、包名、目录与代码内部标识仍为 ZCode，不影响上游同步。

验收结果：

- 用户可见位置（应用身份/窗口标题/关于页/菜单/托盘/强更/深链/安装器可见文案/Web 端标题与登录/分享页/i18n 全部品牌串，共 42 文件 313 处）显示 OmpCode；i18n 字符串值内无残留（key 与内部标识按约定保留 zcode）。
- 构建与上游同步流程不因更名受影响（typecheck 通过；appId、scheme、包名、env、路径等内部标识未动）。

### 应用图标更换为 omp 官方图标（已实现）

目标：应用图标由 ZCode 图标更换为 omp 官网图标，与更名后的 OmpCode 品牌保持一致。

行为边界：

- 图标来源为 omp 官方图标（omp.sh 官网图标；源资产为 oh-my-pi 仓库 `assets/icon.svg`，几何存档于 `packages/desktop/build/omp-icon.svg`）。
- 更换覆盖全部用户可见的图标位：桌面应用图标、安装包图标、窗口图标与 Web 端 favicon 等各尺寸资源统一更换。
- 仅更换图标资产，不改其他视觉主题与界面样式。

验收结果：

- 全部图标位（build/ 下的 ico/icns/全尺寸 png、Linux icons 目录、安装器图标、Web favicon.ico 与内嵌 data-URI、README 公共副本、UI 内嵌 SVG logo 与水印、登录/引导/About 的 π 标）统一为 omp 官方图标；生成器 `packages/desktop/scripts/generate-omp-icons.mjs` 零依赖可复现，像素级校验通过。
- Windows 开发态任务栏同样显示 omp 图标：开发态运行时不设置未注册的 AUMID（系统无对应快捷方式时，任务栏会回退 electron.exe 默认原子图标、盖住窗口的 π 图标；已在本机对两种取值实测确认）。打包态 AUMID 行为不变（见已知差异 17）。
- macOS 安装包图标资产已同步更换，但 macOS 见下方已知差异（无 omp 二进制，安装包不可用）。

### 长会话响应性（2026-09-26 追加需求，已实现首批）

- 流式长回复、任务状态重复通知与历史行更新不得改变消息内容、顺序、完成状态、历史分页或桌面/手机断线恢复语义；相同任务状态通知不应反复刷新非当前任务区域。
- 对话查找输入即时回显，完整匹配在输入稳定约 150ms 后更新；切换范围、清空或关闭查找不能留下旧关键词的高亮。非首屏设置页按需加载，打开和返回工作区仍正常。
- 验收：协议级流式/分片回归通过；Windows 桌面 GUI 使用 `zhipu-coding-plan/glm-5.3-flash` 发送真实消息并看到完整回复，设置页、终端开关与查找可用。

## 已知与允许的差异

换核后以下能力无法与上游等价提供，均已以显式拒绝（JSON-RPC `-32601` / v4 ACK `fault.command.unsupportedByOmpCore` 等 guard id）或明确的替代行为交付，不静默缺失。UI 侧表现为对应入口不可用（禁用态 tooltip / 操作失败提示），主对话链路不受影响。

1. **插件与技能市场**：ZCode 插件安装/市场不可用（-32601）；技能可执行目录由 omp `source=skill` 命令投影，旧 `plugins/referenceCatalog` 在 omp 会话返回合法空目录，`@` 文件引用不显示原始 RPC 错误。设置中的扩展页展示 omp profile 与项目原生扩展目录，可打开配置目录；桌面不内嵌 ZCode 官方插件运行时与内置技能包。
2. **工作流中枢与动态工作流**：已保存工作流 GUI（`workflows/*`）、`v4/conversation/workflowRun*` 全族、`startSavedWorkflow`/`resumeWorkflowRun`/`amendWorkflowRunSettings` 不可用。替代行为：无（omp 无等价工作流引擎）。
3. **automation / Off-Peak**：定时任务使用现有 Host 调度服务持久化与派发，执行仍走 omp 核心；表单模型和思考档从目标工作区的 omp 模型目录选择，运行记录关联 omp 会话。错峰任务仍不可用。
4. **会话内编辑类操作**：fork 某轮（`forkAssistant`）、重试（`retryTurn`）、编辑已发送消息（`editUserQuery`）、工作区文件回滚（`applyFileRewind`/`fileRewindPreview`）不可用。替代行为：无（omp 会话树的 `branch` 能力未进本适配层首版）。
5. **协作模式切换与 goal 循环**：`switchCollaborationMode`（build/edit/plan/yolo）、`sendGoalCommand`、`pauseGoal`/`resumeGoal` 不可用（v4 命令面显式拒绝）。替代行为：会话固定等效于上游 `build` 模式；omp ACP 目录分发的命令（`/model`、`/switch` 等）按 omp 语义透传执行（2026-09-25 需求），`/plan`、`/goal` 未进 omp ACP 目录，仍按本地语义处理。
6. **输入队列编辑**：队列项编辑/重排/删除/立即发送（`editQueueItem` 等）不可用。替代行为：followup 模式等价保留——`guide` 映射 omp `steer`（本轮引导，工具间生效），`queue` 映射 omp `follow_up`（轮后队列），两个 omp 队列均为 one-at-a-time（每轮一条），与上游「每轮一条」语义一致；流式中发送即按当前模式路由。
7. **用量统计**：app 级用量（`v4/usage/stats`）返回合法空快照；会话级 `v4/conversation/usage` 返回本会话累计值。替代行为：历史聚合统计暂缺（数据源在 omp 会话库，未做聚合）。
8. **MCP 状态面板**：`mcp/list` 无 omp 运行态状态数据。设置中的 MCP 页展示 omp profile 与项目 `.omp/mcp.json` 明确配置的服务器名和启用状态，并标记连接状态未提供；配置仍由 omp 自身管理，不展示密钥。
9. **模型连通性测试与 commit message 生成**（`provider/testModelConnectivity`、`workspace/generateText`）：不可用（-32601）。替代行为：模型可用性以实际会话轮为准。
10. **权限确认形态**：omp 审批仅在用户 omp 审批配置（如 `--approval-mode` 非默认值）生效时出现，以通用询问（AskUserQuestion 形态）呈现，提示文本携带工具与目标信息；默认 yolo 模式无权限确认（与用户日常 omp 行为一致）。
11. **子代理/后台任务面板**：omp `task` 子代理生命周期、进度和结束记录投影到父会话及 `session/subagents` 目录；记录可在父会话行内展开，重启后从 omp 父/子会话文件恢复。omp 子代理 ID 不等价于 ZCode child session，目录项不提供子会话下钻；`backgroundWorks` 中的其他旧任务仍未发起。
12. **legacy session 事件流**：`session/subscribe` 返回空事件（无 live 事件回放）。替代行为：桌面与 Web/手机主链路均走 v4 帧，不受影响；task 索引的 live 增量更新降级。
13. **冷会话历史投影**：会话恢复/列表的冷数据来自 omp 会话文件（`~/.omp/agent/sessions/<encoded-cwd>`）的防御式解析；标题取 title/首条用户消息，行投影为尽力而为的等价结构。在 omp 会话内删除会话即从用户会话库删除对应文件（用户显式操作，非静默清理）。
14. **macOS 与旧版 Linux 打包**：omp releases 当前不提供 darwin 资产，macOS 安装包无法内嵌 omp；运行时报「内嵌 omp 二进制未找到」的显式错误。Windows 与较新 Linux 各架构正常；CentOS 7 x64 使用可由普通用户解压运行的独立兼容 ZIP（无 Chromium 沙箱），常规 RPM 仅支持 RHEL 8+。
15. **`startup/storageState` 存储准备**：omp 核心无 ZCode CLI 的 SQLite 会话库，适配器按协议帧序直接报告 ready；`--prepare-storage` worker 为无操作握手（帧序完整，exit 0）。
16. **附件**：图片附件随输入转发给 omp（ImageContent base64）；UTF-8 文本、JSON、XML、JavaScript 与 YAML 在大小限制内作为标明文件名的文本进入 prompt。视频/PDF 等 omp RPC 不能直接消费的附件在提交时明确拒绝；不会发生上传成功却静默忽略的情况。
17. **与上游共享的安装级标识**：深链 scheme `zcode://`、Windows AUMID/appId（`dev.zcode.app`）、Linux 包名按「内部标识不动」约定保留，双装时 scheme 由最后注册方接管、任务栏按 appId 分组——属链接路由与安装身份冲突，非数据/端口共享；数据与端口已按 2026-09-25 隔离需求完全错开。
18. **回复反馈**：omp 无 ZCode 的赞/踩反馈持久化接口，会话中不展示无法生效的反馈入口；复制等其他回复操作保留。
