# Fork 与上游差异

本仓库 fork 自上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 `main` 分支，仅供个人使用，持续同步上游。本 Fork 的目的：把 ZCode 的 Agent 核心替换为 omp（oh-my-pi）的 RPC 核心，保留 ZCode 的全部用户界面与交互形态。

本页面向本人和 AI agent，只记录相对当前上游基线仍有效、对使用者有影响的差异需求，不记录实现细节、修复或同步历史。开发规则与上游同步的操作规则见 `AGENTS.md`。

## 当前上游基线

* **分支**：`zai-org/ZCode@main`
* **版本**：`v3.14.3`
* **Upstream commit**：`328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`
* **同步日期**：2026-09-23

版本以提交说明与 README 更新记录为准；根 `package.json` 的 `version` 字段（3.14.0）滞后，不作为基线依据。

## 本 Fork 的目的

把本地 Agent 核心从上游 `apps/zcode-cli`（Agent CLI 与运行时）替换为 omp 的 RPC 核心，ZCode 侧通过适配层对接。产品形态、全部界面与既有双链路语义保持不变；omp 自身的功能演进在其自己的 fork 仓库进行，本仓库只消费其 RPC 核心能力，不重定义 omp。

## omp 侧依赖

* 来源：本人维护的 fork `jchanghong023/oh-my-pi`（本地工作目录 `D:\code1111111111\oh-my-pi`；上游为 `can1357/oh-my-pi`）。
* 接入形态：`omp --mode rpc` 启动的无头核心——stdio 上的 newline-delimited JSON 协议，含 ready 帧、协议版本协商、命令/响应关联、会话事件与 host 工具请求。
* 接口参考与测试基线：接口与协议开发参考本地源码 `D:\code1111111111\oh-my-pi`（协议细节含该仓库 `docs/rpc.md`）；实际测试（含换核验收 E2E）使用 releases 实际内嵌的发布版本二进制执行，不以本地源码的未发布改动为测试对象。
* 分发：随 ZCode 安装包内嵌——打包时取该 fork GitHub releases 页面（`https://github.com/jchanghong023/oh-my-pi/releases`）的最新版本二进制，内嵌进应用资源并由应用拉起；用户无需单独安装 omp。不依赖上游 oh-my-pi 的 npm / Homebrew / Nix / `omp.sh` 分发。
* 内嵌 omp 的配置与边界：内嵌拷贝与用户已安装的 omp 使用完全相同的配置（同一配置、凭据与会话数据来源），行为与用户日常使用的 omp 保持一致；NEVER 覆盖、替换、修改或代为安装用户已安装的 omp，内嵌拷贝只存在于 ZCode 应用资源目录内。
* 进程与端口边界：内嵌 omp 只以子进程形态经 stdio 通信，不监听任何端口；绝不探测、复用、终止或以其他方式影响用户机器上已在运行的 ZCode / omp 进程。本仓库自建的任何本地测试服务一律使用 `listen(0)` 临时端口，发生端口冲突时换临时端口重试，不占用固定端口。
* 测试模型约定：换核验收 E2E 的真实模型使用 omp `commandcode` 提供者的免费模型（`inclusionai/ling-3.0-flash-sante:free`），走用户 omp 既有凭据；审批等测试态一律用 omp 运行时 flag（如 `--approval-mode`）注入，不修改用户配置文件。

## 差异需求（实现状态）

以下需求已实现并通过对应验证；无法等价提供的能力全部列入「已知与允许的差异」。

### Agent 核心替换为 omp RPC 核心（已实现）

目标：桌面、Web 与手机远控的全部用户界面保留，本地 Agent 核心由 `omp --mode rpc` 提供；上游 `apps/zcode-cli` 不再作为产品核心维护。

实现形态：新增 `packages/omp-agent` 适配器——对 ZCode host 讲 ZCode Protocol（legacy 控制面 + v4 数据面 wire 帧），对内嵌 omp 二进制讲 omp RPC；每个 ZCode 会话对应一个惰性启动的 omp 子进程，omp 拥有会话/模型循环/工具执行/配置/凭据的全部权责。host 侧拉起链路（`resolveDefaultZCodeAgentCommand`）与桌面打包（`resources/glm/omp-agent.cjs` + `resources/glm/omp/omp.exe`）指向适配器；内嵌 omp 取 releases 最新版，`omp/omp-release.json` 记录 tag 与 SHA256。

行为边界与落实：

* 对话流式输出、工具调用展示、权限确认、会话管理、文件变更展示：v4 conversation 投影（rows + state patch）按上游 wire schema 产出，全部下行帧经 `conversationTopicWireFrameSchema` 校验。
* `desktop-continuous` 实时链路与 `web-remote-replayable` 恢复链路：同一投影、按订阅 `clientMode` 区分；断线重连按水位续传（delta log 有界保留，超界回退整快照 resync），两种语义不因换核回退。
* omp RPC 帧格式不渗入 UI：适配层内闭环（`packages/omp-agent` 独占 omp 协议词汇）。
* 无法等价提供的能力：见「已知与允许的差异」逐项。

验收结果：

* 协议级 E2E（`packages/omp-agent/test/adapter.e2e.test.ts`，fake omp 核心）：新建会话 → 流式 → 工具调用 → 权限确认（双向应答路径）→ 文件变更（摘要+查询）→ 完成/中断收口，全部通过；全部 v4 帧通过共享包 wire schema 校验。
* 真实二进制 E2E（`packages/omp-agent/test/real-omp.e2e.test.ts`，releases 实际内嵌 omp.exe + commandcode 免费模型）：createSession → 流式输出 → write 工具 → 审批确认 → 文件真实落盘 → 会话完成，通过。
* 桌面打包产物（Windows x64，`pnpm bundle:desktop -- --os=win --arch=x64`）：`win-unpacked/OmpCode.exe` + `resources/glm/omp-agent.cjs` + `resources/glm/omp/omp.exe`（内嵌 omp v18.2.11+fork.239，SHA256 校验通过）验证在包内；asar 内品牌为 OmpCode。NSIS 安装器步骤与 exe 版本资源（rcedit）在本机因 electron-builder winCodeSign 缓存的符号链接权限（需 Windows 开发者模式/管理员）失败，属打包机环境限制而非代码问题；GUI 级自动化 E2E 待后续在可用打包环境补跑。

### 产品名称更改为 OmpCode（已实现）

目标：本 Fork 的产品名称由 ZCode 更名为 OmpCode，作为对用户的唯一产品身份。

行为边界：

* 更名覆盖用户可见的品牌与文案：应用名称、窗口与界面标题、关于页及标识文案等。
* 对上游的引用保持不变：上游仓库名（`zai-org/ZCode`）、包名、目录与代码内部标识仍为 ZCode，不影响上游同步。

验收结果：

* 用户可见位置（应用身份/窗口标题/关于页/菜单/托盘/强更/深链/安装器可见文案/Web 端标题与登录/分享页/i18n 全部品牌串，共 42 文件 313 处）显示 OmpCode；i18n 字符串值内无残留（key 与内部标识按约定保留 zcode）。
* 构建与上游同步流程不因更名受影响（typecheck 通过；appId、scheme、包名、env、路径等内部标识未动）。

### 应用图标更换为 omp 官方图标（已实现）

目标：应用图标由 ZCode 图标更换为 omp 官网图标，与更名后的 OmpCode 品牌保持一致。

行为边界：

* 图标来源为 omp 官方图标（omp.sh 官网图标；源资产为 oh-my-pi 仓库 `assets/icon.svg`，几何存档于 `packages/desktop/build/omp-icon.svg`）。
* 更换覆盖全部用户可见的图标位：桌面应用图标、安装包图标、窗口图标与 Web 端 favicon 等各尺寸资源统一更换。
* 仅更换图标资产，不改其他视觉主题与界面样式。

验收结果：

* 全部图标位（build/ 下的 ico/icns/全尺寸 png、Linux icons 目录、安装器图标、Web favicon.ico 与内嵌 data-URI、README 公共副本、UI 内嵌 SVG logo 与水印、登录/引导/About 的 π 标）统一为 omp 官方图标；生成器 `packages/desktop/scripts/generate-omp-icons.mjs` 零依赖可复现，像素级校验通过。
* macOS 安装包图标资产已同步更换，但 macOS 见下方已知差异（无 omp 二进制，安装包不可用）。

## 已知与允许的差异

换核后以下能力无法与上游等价提供，均已以显式拒绝（JSON-RPC `-32601` / v4 ACK `fault.command.unsupportedByOmpCore` 等 guard id）或明确的替代行为交付，不静默缺失。UI 侧表现为对应入口不可用（禁用态 tooltip / 操作失败提示），主对话链路不受影响。

1. **插件与技能市场**：ZCode 插件安装/市场/引用目录（`plugins/*`、`skills/referenceCatalog`）全部不可用（-32601）。替代行为：插件与技能面由 omp 自身体系（其配置与扩展目录）承担，桌面不再内嵌 ZCode 官方插件运行时与内置技能包。
2. **工作流中枢与动态工作流**：已保存工作流 GUI（`workflows/*`）、`v4/conversation/workflowRun*` 全族、`startSavedWorkflow`/`resumeWorkflowRun`/`amendWorkflowRunSettings` 不可用。替代行为：无（omp 无等价工作流引擎）。
3. **automation / Off-Peak**：定时任务与错峰任务面不可用（反向请求不发起；宿主侧调用按 -32601 拒绝）。替代行为：无。
4. **会话内编辑类操作**：fork 某轮（`forkAssistant`）、重试（`retryTurn`）、编辑已发送消息（`editUserQuery`）、工作区文件回滚（`applyFileRewind`/`fileRewindPreview`）不可用。替代行为：无（omp 会话树的 `branch` 能力未进本适配层首版）。
5. **协作模式切换与 goal 循环**：`switchCollaborationMode`（build/edit/plan/yolo）、`sendGoalCommand`、`pauseGoal`/`resumeGoal` 不可用。替代行为：会话固定等效于上游 `build` 模式。
6. **输入队列编辑**：队列项编辑/重排/删除/立即发送（`editQueueItem` 等）、guide 跟进模式不可用。替代行为：流式中发送的新输入转为 omp follow-up 队列（每轮一条），语义对齐上游 `queue` 模式。
7. **用量统计**：app 级用量（`v4/usage/stats`）返回合法空快照；会话级 `v4/conversation/usage` 返回本会话累计值。替代行为：历史聚合统计暂缺（数据源在 omp 会话库，未做聚合）。
8. **MCP 状态面板**：`mcp/list` 返回空。替代行为：MCP 服务器由 omp 自身配置管理，状态在 omp 侧查看。
9. **模型连通性测试与 commit message 生成**（`provider/testModelConnectivity`、`workspace/generateText`）：不可用（-32601）。替代行为：模型可用性以实际会话轮为准。
10. **权限确认形态**：omp 审批仅在用户 omp 审批配置（如 `--approval-mode` 非默认值）生效时出现，以通用询问（AskUserQuestion 形态）呈现，提示文本携带工具与目标信息；默认 yolo 模式无权限确认（与用户日常 omp 行为一致）。
11. **子代理/后台任务面板**：`session/subagents` 与 `backgroundWorks` 面返回空/未发起。替代行为：omp 子代理在 omp 内部执行，其结果体现在工具调用行与最终回复。
12. **legacy session 事件流**：`session/subscribe` 返回空事件（无 live 事件回放）。替代行为：桌面与 Web/手机主链路均走 v4 帧，不受影响；task 索引的 live 增量更新降级。
13. **冷会话历史投影**：会话恢复/列表的冷数据来自 omp 会话文件（`~/.omp/agent/sessions/<encoded-cwd>`）的防御式解析；标题取 title/首条用户消息，行投影为尽力而为的等价结构。在 omp 会话内删除会话即从用户会话库删除对应文件（用户显式操作，非静默清理）。
14. **macOS 打包**：omp releases 当前不提供 darwin 资产，macOS 安装包无法内嵌 omp；运行时报「内嵌 omp 二进制未找到」的显式错误。Windows/Linux 各架构正常。
15. **`startup/storageState` 存储准备**：omp 核心无 ZCode CLI 的 SQLite 会话库，适配器按协议帧序直接报告 ready；`--prepare-storage` worker 为无操作握手（帧序完整，exit 0）。
16. **附件**：图片附件随输入转发给 omp（ImageContent base64）；视频/PDF 附件可上传与回读，但不进入模型输入（omp prompt 仅收图片）。
