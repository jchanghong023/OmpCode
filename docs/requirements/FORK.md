# Fork 与上游差异

本仓库 fork 自上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 `main` 分支，仅供个人使用，持续同步上游。本 Fork 的目的：把 ZCode 的 Agent 核心替换为 omp（oh-my-pi）的 RPC 核心，保留 ZCode 的全部用户界面与交互形态。

本页面向本人和 AI agent，只记录相对当前上游基线仍有效、对使用者有影响的差异需求，不记录实现细节、修复或同步历史。开发与同步规则见 [AGENTS.md](../../AGENTS.md)，功能域划分见 [需求索引](README.md)。

## 已合入上游基线

- **分支**：`zai-org/ZCode@main`
- **版本**：`v3.14.3`
- **Upstream commit**：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`
- **同步日期**：2026-09-24

版本以提交说明与 README 更新记录为准；上游基线按最后合入的提交记录，不按本 Fork 的包版本推断。

## 本 Fork 的目的

把本地 Agent 核心从上游 `apps/zcode-cli`（Agent CLI 与运行时）替换为 omp 的 RPC 核心，ZCode 侧通过适配层对接。产品形态、全部界面与既有双链路语义保持不变；omp 自身的功能演进在其自己的 fork 仓库进行，本仓库只消费其 RPC 核心能力，不重定义 omp。

本次初始化已确认该提交存在且为 HEAD 的共同基线；未获取或核验远端当前 main HEAD，不把尚未同步的上游变化识别为本地需求。以下本地要求仍需维护，尚未逐项证明上游等价满足。

## 数据、端口与更新隔离

- 本应用全部业务数据根由 `~/.zcode` 改为 `~/.ompcode`（配置 v2、日志、任务索引、会话快照、凭据、CLI 配置、skills/commands/plugins 同步目录、telemetry、computer-use 运行日志等），Electron userData（`%APPDATA%/OmpCode`）与单实例锁本就按产品名隔离；不读取、不迁移、不写入上游 ZCode 的 `~/.zcode`。workspace 内同名配置目录（`.ompcode/`）同样与 ZCode 的 `.zcode/` 错开。
- Windows 资源管理器右键菜单注册表键、electron-updater 缓存目录（`ompcode-updater`）改为 OmpCode 专属，双装不互相覆盖。
- 正式安装包仅从本仓库 GitHub Release 手动获取更新；本 Fork 没有专属更新 feed 时，不查询或安装上游 ZCode 的自动更新，也不受上游强制更新线阻止启动。
- 端口隔离：本地开发远程调试端口 9230（上游 ZCode Dev 用 9229）、桌面 devServer 5194（上游 5174）、Web devServer 5193（上游 5173）、server 包默认端口 3033（上游 3030）；运行期本地服务一律 `listen(0)` 临时端口（不变）。深链 scheme `zcode://` 与 appId 仍按「内部标识不动」约定保留（见已知差异 17）。

- 设置中的数据目录说明中英文均显示实际 `.ompcode/v2` 后缀。正式安装包以外的开发态显式更新联调不代表开启正式安装包上游更新。
- 验收：与 ZCode 双装运行时不读写或迁移其数据，菜单注册与更新缓存相互独立；开发端口按上述分配，运行期服务使用临时端口；安装包不查询上游更新或被其强更线拦截。

## omp 侧依赖

- 来源：本人维护的 fork `jchanghong023/oh-my-pi`（本地工作目录 `D:\code1111111111\oh-my-pi`；上游为 `can1357/oh-my-pi`）。
- 接入形态：`omp --mode rpc-ui` 启动的核心——stdio 上的 newline-delimited JSON 协议，含 ready 帧、协议版本协商、命令/响应关联、会话事件、工具交互 UI 请求与 host 工具请求。
- 接口参考与测试基线：接口与协议开发参考本地源码 `D:\code1111111111\oh-my-pi`（协议细节含该仓库 `docs/rpc.md`）；实际测试（含换核验收 E2E）使用 releases 实际内嵌的发布版本二进制执行，不以本地源码的未发布改动为测试对象。
- 分发：随 ZCode 安装包内嵌——打包时取该 fork GitHub releases 页面（`https://github.com/jchanghong023/oh-my-pi/releases`）的最新版本二进制，内嵌进应用资源并由应用拉起；用户无需单独安装 omp。不依赖上游 oh-my-pi 的 npm / Homebrew / Nix / `omp.sh` 分发。
- Windows x64 桌面版通过 GitHub Actions 手动发布：从 `main` 输入与当前版本匹配的唯一 OmpCode 标签，打包后将安装 EXE 与 SHA256 校验文件上传到本仓库 GitHub Release；发布流水线不单独运行测试。
- 内嵌 omp 的配置与边界：内嵌拷贝与用户已安装的 omp 使用完全相同的配置（同一配置、凭据与会话数据来源），行为与用户日常使用的 omp 保持一致；NEVER 覆盖、替换、修改或代为安装用户已安装的 omp，内嵌拷贝只存在于 ZCode 应用资源目录内。
- 进程与端口边界：内嵌 omp 只以子进程形态经 stdio 通信，不监听任何端口；绝不探测、复用、终止或以其他方式影响用户机器上已在运行的 ZCode / omp 进程。本仓库自建的任何本地测试服务一律使用 `listen(0)` 临时端口，发生端口冲突时换临时端口重试，不占用固定端口。
- CentOS 7 独立分发与安全限制见 [centos7-release.md](centos7-release.md)。

## Agent 核心与双链路

目标：桌面、Web 与手机远控的全部用户界面保留，本地 Agent 核心由 `omp --mode rpc-ui` 提供；omp 工具与扩展发出的选择、确认和文本输入在现有会话交互面应答。上游 `apps/zcode-cli` 仅作为未接入 workspace、构建或分发的源码快照保留，不作为运行时或回退路径。

所有权：omp 拥有会话、模型循环、工具执行、配置与凭据；ZCode 适配层对 Host 提供原有协议，对内嵌核心提供 RPC-UI 适配，每个会话惰性启动自己的 omp 子进程。

行为边界：

- 对话流式输出、工具调用展示、权限确认、会话管理、文件变更展示：v4 conversation 投影（rows + state patch）按上游 wire schema 产出，全部下行帧经 `conversationTopicWireFrameSchema` 校验。
- `desktop-continuous` 实时链路与 `web-remote-replayable` 恢复链路：同一投影、按订阅 `clientMode` 区分；断线重连按水位续传（delta log 有界保留，超界回退整快照 resync），两种语义不因换核回退。
- omp RPC 帧格式不渗入 UI：适配层内闭环（`packages/omp-agent` 独占 omp 协议词汇）；工具 `ask` 的选择与文本输入复用 ZCode 原有的 `ElicitationDialog`，选项说明保留，「其他」由随后文本请求继续输入。
- 无法等价提供的能力：见「已知与允许的差异」逐项。

验收：从真实公开入口新建会话，覆盖流式、工具调用、双向交互、实际文件变更、完成/中断、冷恢复；同时验证桌面实时交付与手机断线后的续传/超界快照恢复。协议模拟仅补充 wire 校验，不能代替真实核心及 GUI 链路。

## 产品身份与图标

目标：本 Fork 的产品名称由 ZCode 更名为 OmpCode，作为对用户的唯一产品身份。

行为边界：

- 更名覆盖用户可见的品牌与文案：应用名称、窗口与界面标题、关于页及标识文案等。
- 对上游的引用保持不变：上游仓库名（`zai-org/ZCode`）、包名、目录与代码内部标识仍为 ZCode，不影响上游同步。

目标：应用图标由 ZCode 图标更换为 omp 官网图标，与更名后的 OmpCode 品牌保持一致。

行为边界：

- 图标来源为 omp 官方图标（omp.sh 官网图标；源资产为 oh-my-pi 仓库 `assets/icon.svg`，几何存档于 `packages/desktop/build/omp-icon.svg`）。
- 更换覆盖全部用户可见的图标位：桌面应用图标、安装包图标、窗口图标与 Web 端 favicon 等各尺寸资源统一更换。
- 仅更换图标资产，不改其他视觉主题与界面样式。

- 侧栏左下角的偏好菜单入口（界面语言/界面主题/界面模式/界面缩放）由「设置」更名为「显示效果」（英文 Display），与右侧打开完整设置页的齿轮「设置」按钮区分；仅改入口文案与 aria 标签，菜单内容与设置页不变。

验收：桌面、Web、安装器、菜单、托盘、关于页、引导、登录/分享页的用户可见品牌统一为 OmpCode；全部尺寸图标及 Windows 开发态任务栏均显示 omp 官方图标。上游引用、内部标识及构建流程保持约定兼容，菜单内容与其他视觉样式不变化。

## 已知与允许的差异

换核后以下能力无法与上游等价提供，要求以显式拒绝（JSON-RPC `-32601` / v4 ACK `fault.command.unsupportedByOmpCore` 等 guard id）或明确的替代行为交付，不静默缺失。UI 侧表现为对应入口不可用（禁用态 tooltip / 操作失败提示），主对话链路不受影响。

1. **插件与技能市场**：见 [原生集成](integrations.md) 与 [可执行技能](skills.md)。
2. **工作流中枢与动态工作流**：已保存工作流 GUI（`workflows/*`）、`v4/conversation/workflowRun*` 全族、`startSavedWorkflow`/`resumeWorkflowRun`/`amendWorkflowRunSettings` 不可用。替代行为：无（omp 无等价工作流引擎）。
3. **automation / Off-Peak**：见 [原生集成](integrations.md)。
4. **会话内编辑类操作**：fork 某轮（`forkAssistant`）、重试（`retryTurn`）、编辑已发送消息（`editUserQuery`）、工作区文件回滚（`applyFileRewind`/`fileRewindPreview`）不可用。替代行为：无（omp 会话树的 `branch` 能力未进本适配层首版）。
5. **协作模式切换与 goal 循环**：`switchCollaborationMode`（build/edit/plan/yolo）、`sendGoalCommand`、`pauseGoal`/`resumeGoal` 不可用（v4 命令面显式拒绝）。替代行为：会话固定等效于上游 `build` 模式；omp ACP 目录分发的命令（`/model`、`/switch` 等）按 omp 语义透传执行（命令路由详见 [模型与命令](models-and-commands.md)），`/plan`、`/goal` 未进 omp ACP 目录，仍按本地语义处理。
6. **输入队列编辑**：队列项编辑/重排/删除/立即发送（`editQueueItem` 等）不可用。替代行为：followup 模式等价保留——`guide` 映射 omp `steer`（本轮引导，工具间生效），`queue` 映射 omp `follow_up`（轮后队列），两个 omp 队列均为 one-at-a-time（每轮一条），与上游「每轮一条」语义一致；流式中发送即按当前模式路由。
7. **用量统计**：app 级用量（`v4/usage/stats`）返回合法空快照；会话级 `v4/conversation/usage` 返回本会话累计值。替代行为：历史聚合统计暂缺（数据源在 omp 会话库，未做聚合）。
8. **MCP 状态面板**：见 [原生集成](integrations.md)。
9. **模型连通性测试与 commit message 生成**（`provider/testModelConnectivity`、`workspace/generateText`）：不可用（-32601）。替代行为：模型可用性以实际会话轮为准。
10. **权限确认形态**：omp 审批仅在用户 omp 审批配置（如 `--approval-mode` 非默认值）生效时出现，以通用询问（AskUserQuestion 形态）呈现，提示文本携带工具与目标信息；默认 yolo 模式无权限确认（与用户日常 omp 行为一致）。
11. **子代理/后台任务面板**：见 [原生集成](integrations.md)。
12. **legacy session 事件流**：`session/subscribe` 返回空事件（无 live 事件回放）。替代行为：桌面与 Web/手机主链路均走 v4 帧，不受影响；task 索引的 live 增量更新降级。
13. **冷会话历史投影**：见 [会话恢复](session-recovery.md)。
14. **macOS 与旧版 Linux 打包**：原基线记录 omp releases 不提供 darwin 资产，macOS 安装包无法内嵌 omp；运行时须报「内嵌 omp 二进制未找到」的显式错误。Windows 与较新 Linux 各架构为既有支持范围；本次未重验发布资产或各平台运行。CentOS 7 见 [兼容分发](centos7-release.md)，常规 RPM 仅支持 RHEL 8+。
15. **`startup/storageState` 存储准备**：omp 核心无 ZCode CLI 的 SQLite 会话库，适配器按协议帧序直接报告 ready；`--prepare-storage` worker 为无操作握手（帧序完整，exit 0）。
16. **附件**：见 [原生集成的附件规则](integrations.md)。
17. **与上游共享的安装级标识**：深链 scheme `zcode://`、Windows AUMID/appId（`dev.zcode.app`）、Linux 包名按「内部标识不动」约定保留，双装时 scheme 由最后注册方接管、任务栏按 appId 分组——属链接路由与安装身份冲突，非数据/端口共享；数据与端口须遵守本文件隔离要求。
18. **回复反馈**：见 [原生集成](integrations.md)。

会话分支、重试、编辑与文件回滚当前仍不可用；将来开放的前提是基于 omp 原生会话树与 Host 会话操作，文件回滚必须能可靠映射文件变更，不能仅修改 GUI 消息。此边界不表示新增实现承诺。

验收上述不可用能力时检查明确拒绝或规定替代行为，并确认主对话不受影响；功能同名、补丁消失或静态检查通过均不表示上游已等价满足。

## 实现与验证状态

需求从原有权威 FORK 与对应 spec 迁入，未因当前实现降低要求。既有实现及历史验证不等于本次验收；统一证据边界见 [需求索引](README.md#实现与验证状态)。
