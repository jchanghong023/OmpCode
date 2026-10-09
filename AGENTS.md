## 核心原则

- 新增或修改行为前，先更新 `docs/requirements/` 中对应功能域的需求与验收场景；目录或权威体系缺失时先补齐。明确产品规则、状态所有者、接口和验收场景后再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- OMP 本地源码目录 `D:\code1111111111\oh-my-pi` 存在，优先以其源码为权威资料。本机器安装的 omp 必然是最新版本，无需另行核验是否最新；未安装 omp 时不执行依赖真实 omp 的验证，明确记录为未验证，跳过不能算通过。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 项目定位与需求权威（Fork）

- 本仓库是持续同步上游的个人 Fork；上游来源、跟踪目标、产品目的、支持平台及平台差异边界唯一维护于 [FORK 总纲](docs/requirements/FORK.md)。同步操作只针对其中指定的上游 `main` HEAD，优先采用上游最新实现；UI、依赖与环境门控改动须先核对该总纲及所属功能域。
- 自有改动与上游改动按 [结构隔离约定](docs/requirements/FORK.md#上游同步策略与平台范围) 组织，对上游共享文件保持最小必要 diff。
- 本项目完全由 AI Agent 实现和维护：质量不依赖用户手工读代码或人工回归，必须依靠可复现的自动化验证与文档约定。
- 固定需求权威目录是 `docs/requirements/`，从[需求索引](docs/requirements/README.md)按功能边界定位文档；Fork 目的、差异需求、规划及验收标准只在该目录维护。根目录 `FORK.md` 仅保留跳转，不是第二份权威副本。
- 新增、修改或取消本地差异需求，或预期用户可见行为变化时，MUST 检查并同步目录中对应文档；新独立功能域可新增文档并更新索引，每项需求只有一个维护位置。仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。入口、命令或开发规则变化时同步本文件。
- 已获授权的上游同步任务中先保全本地改动和差异需求，正常优先可靠合并；冲突难以可靠解决时，可以相关冲突部分的上游当前实现为基础，按 `docs/requirements/` 重新实现仍然有效的本地需求，不执着保留旧补丁。同步后 MUST 逐项核对目录中仍然有效的本地需求，而不是只检查是否存在 Git 冲突；重建后必须通过相应 UT 和 E2E 验证，未通过不得宣称同步完成。
- 不据此丢弃无关本地改动、覆盖唯一需求依据或擅自重置整个仓库；无法可靠保留本地功能时中止同步，不静默丢弃。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                                       |
| 快速门禁         | `pnpm fastcheck`（AI 可自主运行，最多 60 秒）                          |
| Windows 完整验证 | `pnpm fulltest --human-authorized`（本次需用户明确授权）               |
| Windows 慢速门禁 | `pnpm slowtest --human-authorized`（与 fulltest 相同计划，本次需授权） |
| Lint             | `pnpm lint` / `pnpm lint:fix`                                          |
| 格式检查         | `pnpm fmt:check`                                                       |
| 桌面开发         | `pnpm dev:desktop`（production 数据环境）                              |
| 桌面测试环境     | `pnpm dev:desktop:test`（`ZCODE_ENV=test`，不保证数据隔离）            |
| Web 开发         | `pnpm dev:web`                                                         |
| 构建工作区       | `pnpm build`                                                           |
| Windows x64 打包 | `pnpm bundle:desktop -- --os=win --arch=x64`                           |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与全量架构检查）                          |
| 架构检查         | `pnpm architecture:check --changed`                                    |
| 模块阅读包       | `pnpm architecture:context <module-id>`                                |
| 未使用依赖与导出 | `pnpm knip`                                                            |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                                  |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer；入口分别为 `src/main/index.ts`、`src/host/index.ts`、`src/renderer/src/main.tsx`。
- `packages/web`、`packages/server`：Web 客户端与服务端；入口分别为 `src/main.tsx`、`src/entry-http.ts`。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `packages/omp-agent`：omp RPC 核心适配器（对 host 讲 ZCode Protocol/v4，对内嵌 omp 二进制讲 omp RPC；本 Fork 的本地 Agent 核心）。
- `packages/omp-agent/src/adapters/cliMain.ts`：Host 启动的 Agent stdio 入口。
- OMP 环境与数据路径改动先核对 [根目录与 profile 规则](docs/requirements/models-and-commands.md#产品规则与所有权)；启动器接口与分发验收见 [CentOS 7 分发需求](docs/requirements/centos7-release.md)。
- `apps/zcode-cli`：保留的上游源码快照，不在根 workspace 中；运行时边界见 `docs/requirements/FORK.md`，未经用户要求不得接回产品。
- 子目录规则注册表（全仓唯一）：[apps/zcode-cli/AGENTS.md](apps/zcode-cli/AGENTS.md)——独立上游 CLI 源码 workspace，保留其专属开发约束与本地验证入口；其余产品包共用本文件，不按目录层级机械新增规则文件。项目规则文件总数不得超过 8，托管技能参考资料按下项排除。
- `.agents/skills/react-best-practices/AGENTS.md` 是随技能分发的参考资料，不是项目模块规则；文档系统分析与检查使用 `--exclude .agents/skills/react-best-practices` 排除此托管资料。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

构建与测试须先按 `mise.toml` 准备 Node 24.14.0、pnpm 10.33.2 及 workspace 依赖；桌面完整构建/打包需要对应平台构建环境，运行时准备可能联网下载资产。上表及下表是源码中存在的入口，列出不等于本次已执行或已验证所有平台可用。

`dev:desktop:test` 只选择产品 test 环境，不创建专用 OMP 根或 profile；真实验收必须使用下述隔离启动器并核对实际数据落点。环境变量与根目录规则见[模型与命令](docs/requirements/models-and-commands.md#产品规则与所有权)，不能将命令名称中的 `test` 当作隔离证明。

### 自动化验证入口

以下原始入口仅在 Windows 本机运行；根目录以三级门禁统一编排，没有名为 `test` 的根脚本。单独入口仍保留各自隔离环境前提与验证边界。AI 不执行 Linux/CentOS/WSL 测试；CentOS 专用测试及 VM、Citrix、目标网络盘专项测试已取消，不再是 Windows 测试前提，产品的两平台支持与打包完整性约束仍保留。

| 验证范围                           | 实际入口与前提                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp UT、协议模拟及真实核心测试合集 | `pnpm --filter @zcode/omp-agent test`；匹配 `test/*.test.ts`，包含真实核心文件，不只是 fake-omp                                                                                                                                                                                                                                                                                                                                                           |
| 协议级 fake-omp 集成测试           | `pnpm --filter @zcode/omp-agent exec tsx --test test/adapter.e2e.test.ts`；不依赖真实模型，不覆盖真实 omp/GUI 边界                                                                                                                                                                                                                                                                                                                                        |
| Agent 交互协议集成测试             | `pnpm --filter @zcode/omp-agent exec tsx --test test/agentInteractions.protocol.e2e.test.ts`；覆盖 stdio/v4 交互投影及读取，不替代真实核心或 GUI 验收                                                                                                                                                                                                                                                                                                     |
| rpc-ui 核心命令真实 E2E            | 设置 `OMP_NATIVE_E2E=1` 后运行 `pnpm --filter @zcode/omp-agent exec tsx --test test/realNativeCommands.e2e.test.ts`；使用安装核、独立临时 OMP 根和既有 GLM 凭据，覆盖必接命令、索引/计划交互、状态生命周期及两链路冷恢复；未显式开启时跳过，不计通过                                                                                                                                                                                                      |
| rpc-ui 核心命令 GUI E2E            | 完成类型检查后重建当前 adapter/Host，启动本工作树 Vite；`OMP_NATIVE_E2E=1 node packages/desktop/test/ompNativeCommands.launch.mjs` 创建独立桌面（CDP 9257），用返回的 `OMP_NATIVE_GUI_META` 运行 `node packages/desktop/test/ompNativeCommands.gui.e2e.mjs`；live 通过后以 `OMP_E2E_PHASE=capture` 只读采集完整历史，再以同一临时根重启执行 `OMP_E2E_PHASE=cold`；必须在指定沙箱项目内建任务，不连接日常实例                                              |
| 真实核心 E2E                       | `pnpm --filter @zcode/omp-agent exec tsx --test test/real-omp.e2e.test.ts`；用 `OMP_RPC_BINARY_PATH` 指向本机已安装的 omp，使用既有凭据；本机未安装时不执行，不为验证另行下载或安装。设置 `OMP_AGENT_SKIP_REAL_E2E=1` 时跳过，跳过不能算通过                                                                                                                                                                                                              |
| 其他包 UT/集成测试                 | `packages/{desktop,ui,services,shared,client,server}/test/` 存在测试文件；按实际文件用根 `pnpm exec tsx --test <测试文件>` 执行（`.mjs` 可用 `node --test`），不能假定这些包有 `test` script；`packages/web/test/` 当前不存在                                                                                                                                                                                                                             |
| 桌面 GUI 冒烟                      | `node scripts/dev/gui-smoke-cdp.mjs`；需要当前测试桌面已启动、CDP 9230 及 localhost renderer，仅检查品牌/输入区并截图，不是完整功能 E2E                                                                                                                                                                                                                                                                                                                   |
| 子代理 / Todo 界面适配 GUI E2E     | `node packages/desktop/test/ompStatusPanels.gui.e2e.mjs`；先启动隔离桌面并设置 `OMP_E2E_CDP_URL`、`OMP_E2E_EVIDENCE_DIR`；默认 live 调用既有 GLM-5.3-Flash 并创建只读测试会话，重启同一隔离桌面后以 `OMP_E2E_PHASE=cold` 验证恢复与两项子代理工具结果；不连接用户日常实例                                                                                                                                                                                 |
| Agent 交互页 GUI E2E               | `node packages/desktop/test/ompAgentInteractions.launch.mjs` 以 `OMP_E2E_ISOLATED_ROOT` 启动专用桌面（端口由 `OMP_E2E_CDP_PORT` / `OMP_E2E_RENDERER_PORT` 指定）；`node packages/desktop/test/ompAgentInteractions.gui.e2e.mjs` 读取 `OMP_E2E_RUNTIME_MANIFEST`，同时设置 `OMP_E2E_EVIDENCE_DIR`、`OMP_E2E_RUN_ID`；先 live，再重启同一隔离目录以 `OMP_E2E_PHASE=cold` 验恢复。主会话及测试项目专属子代理使用既有 GLM-5.3-Flash，不修改用户模型角色配置。 |

常规真实模型验收使用用户 omp 既有配置中的 `zhipu-coding-plan/glm-5.3-flash`；审批等测试态通过运行时 flag 注入，不修改用户配置文件。[指定模型桌面专项](docs/requirements/e2e.md)单独规定模型、隔离角色配置及认证安全前提，不得用常规 GLM 场景替代其验收。真实测试会调用模型并创建测试会话，必须明确环境和范围；测试服务使用临时端口，不影响用户已有 ZCode/omp 进程。现有 GUI 走查与已知未验收范围见 `docs/test-reports/`，后续功能开发仍须补足相关真实入口到结果的 E2E。

Agent 交互页的已保存会话可执行 `node packages/desktop/test/ompAgentInteractions.visual.e2e.mjs`，复用上述 `OMP_E2E_RUNTIME_MANIFEST`、`OMP_E2E_EVIDENCE_DIR`、`OMP_E2E_RUN_ID`，验证摘要/原文开合、深浅主题与窄栏布局，不发起新的模型轮次。

主/子执行页联合 GUI 回归：先重建当前 adapter/Host，设置 `OMP_NATIVE_E2E=1` 执行 `node packages/desktop/test/ompExecutionPages.launch.mjs`，返回 `runtimePath`；启动器创建临时 OMP 根、固定 GLM-5.3-Flash 主/子角色及独占 Vite/CDP 端口。将返回路径传给 `OMP_E2E_RUNTIME_MANIFEST`，设置独立 `OMP_E2E_EVIDENCE_DIR`，运行 `node packages/desktop/test/ompExecutionPages.gui.e2e.mjs`。`OMP_E2E_PHASE=live` 在指定测试项目提交三代理创建 a–c 并广播 `hello` 的提示词，核对主会话、三个详情的完整工具记录、真实终态/只读控制与 Agent 交互页；关闭该启动器创建的进程，以同一临时根设置 `OMP_E2E_ISOLATED_ROOT` 重启后，`cold` 复验同一已保存会话，`saved` 只验证该 fixture 已登记的会话。禁止连接日常实例；live 会调用既有 GLM 凭据，cold/saved 不发起新模型轮次。结果按两阶段分别记录，不能合并不同源码快照。

工具详情组件验收：`node packages/desktop/test/toolContentPresentation.components.e2e.mjs` 使用临时端口、独立 Electron/userData，限时 60 秒，不调用模型；覆盖有效零/布尔结果、空参数、普通文本/JSON/Markdown、原始数据开合、MCP 参数、计划错误、深浅主题及窄栏布局，不替代真实会话/冷恢复验收。

性能热路径验收：`node packages/desktop/test/ompPerformanceHotPaths.components.e2e.mjs` 启动独立 Electron 组件环境，检查代码/思考/时间线及输入保存边界，不调用模型。`node packages/desktop/test/ompPerformanceHotPaths.gui.e2e.mjs` 复用专用隔离启动器及 `OMP_E2E_RUNTIME_MANIFEST`、`OMP_E2E_EVIDENCE_DIR`、`OMP_E2E_RUN_ID`，验证真实 GLM 发送、草稿与文件引用；`OMP_E2E_PHASE=live` 检查新建会话，`stable` 检查已有持久 ID 的会话，`cold` 在重启同一隔离目录后检查恢复，三者的结果分别报告。

首次 Host 身份迁移的项目验收在上述启动器设置 `OMP_E2E_OPEN_TEST_PROJECT=1`，通过真实 `--open-workspace` 打开隔离根下的 `acceptance-project`；manifest 的 `requestedWorkspace` 由性能 GUI 与 mentions 脚本共用，不把默认工作区的全局任务列表当作项目 query cache。

`node packages/desktop/test/ompPerformanceHotPaths.mentions.e2e.mjs` 使用同一隔离 runtime manifest、evidence 目录和 run ID，验证真实 `@` 无命中补扫、新文件候选及同 Markdown 富节点的剪贴板/草稿恢复；Host 扫描次数由文件服务真实 I/O 测试独立计量。

UI UT 使用 `@/` 路径别名时，从根执行 `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test <测试文件>`。性能对照入口为 `packages/ui/test/conversationTurnRenderBuilder.perf.ts`、`packages/ui/test/streamingContentPresentation.perf.ts` 和 `packages/services/test/workspaceFileIndex.perf.mts <baseline-git-ref>`；使用固定 Node 与相同样本，不将本地探针当作目标网络盘验收。

## 三级测试门禁

- `pnpm fastcheck`：仅 Windows 本机，AI 可自主运行的快速反馈子集；硬上限 60 秒，超时必须终止本次进程树、输出 `TIMEOUT`/总秒数并失败，不代表全项目验收。`--budget-seconds` 只允许下调。
- fulltest/slowtest 的 Windows 完整计划、覆盖与失败语义唯一维护于[三级测试需求](docs/requirements/test-gates.md)，本节只规定执行权限与操作边界；快速子集通过不表示完整验收。
- 每次 fulltest/slowtest 必须来自当前对话的用户明确指令。历史授权、仓库内「本次已授权」记录、技能调用、代理建议、提交/推送请求或“检查一下”不自动授权；`--human-authorized` 只能依据原始用户明确指令传入，不得绕过门禁执行完整、长时间子步骤。
- 测试不触发、不等待、不验证任何发布 workflow，也不接受 `--publish-releases`。发布是独立外部操作，必须依据当前对话中仍有效的用户明确授权；历史文档不提供发布授权。既有入口、目标与 Tag 约定见[Fork 分发要求](docs/requirements/FORK.md#omp-侧依赖)，不代为提交/推送、不创建新发布入口、自定版本或 Tag。Windows 测试失败仍须先修复；发布结果不能替代测试通过。
- 每次结果绑定本次 HEAD、未提交差异摘要、内容指纹与工具版本；源码变化后旧结果不能沿用或跨快照合并。真实 OMP/GLM 与 GUI 必须使用专用隔离 fixture 和数据根，不连接日常实例、不修改用户配置；历史失败、跳过和未验证记录不得改写成通过。
- 尚未授权时只建立入口、执行 fastcheck 和入口机制的临时短桩自检；新编排文件可做显式逐文件语法/Lint/格式检查，不借此执行完整验收。保留原有质量检查和测试断言，不为通过门禁改写它们。需求、覆盖和环境配置见 [三级测试需求](docs/requirements/test-gates.md)。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 功能开发和功能性修改必须有自动化验证：UT 验证局部逻辑，E2E 验证从真实公开入口到可观察结果的完整功能链路，跨模块交互按需增加集成测试。先补充缺少的场景，已有有效覆盖可以复用，不机械新增测试。
- 测试必须对应需求与验收条件，覆盖核心成功路径和相关关键失败路径，不得仅复述实现或验证未崩溃。UT、编译、静态检查和局部模拟不能替代 E2E；桩与模拟可补充测试，未经过的真实边界必须说明。
- 区分已实现、验证通过、验证失败和未验证；环境、依赖或权限不足时写明未验证范围，不能声称功能已验收。缺少 UT/E2E 时记录缺口并在后续功能开发中补齐，不编造入口或降低标准。纯文档等非功能性变更按实际影响验证，不强制运行无关的完整功能测试。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 类型检查与 Lint 由 fastcheck/fulltest/slowtest 复用原有 `pnpm typecheck`、`pnpm lint`，报告真实结果，不将已有失败写成通过；日常自主验证使用 fastcheck，其他完整验证遵循上述本次授权边界。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows 与 CentOS 7 两个支持平台。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动按接口所属边界同步维护 `packages/shared/src/zcode-protocol/index.ts`（legacy）或 `packages/shared/src/zcode-protocol-v4/index.ts`（主链路），提供严格类型与运行时校验；不把 OMP 原生帧泄漏给 UI。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 涉及已取消功能或其共享边界时先核对 [FORK 总纲](docs/requirements/FORK.md)，不得在重构或同步中恢复已取消需求。
- Desktop 的 `desktop-continuous` 实时链路与 Web 的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 产品输入经 omp-agent 的会话级调度与投影对接 OMP；运行中输入的接纳、消费及终态依据见[会话恢复](docs/requirements/session-recovery.md#冷历史与身份连续性)。不引用未接入产品的上游 CLI `CommandInbox` 作为运行时所有者。Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
