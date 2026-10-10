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

| 用途             | 命令                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                                           |
| 快速门禁         | `pnpm fastcheck`（仅静态/格式/编译，非编译预算 60 秒）                     |
| Windows 完整验证 | `pnpm fulltest --human-authorized`（非编译预算 900 秒）                    |
| Windows 慢速门禁 | `pnpm slowtest --human-authorized`（同 fulltest 覆盖，非编译预算 1500 秒） |
| Lint             | `pnpm lint` / `pnpm lint:fix`                                              |
| 格式检查         | `pnpm fmt:check`                                                           |
| 桌面开发         | `pnpm dev:desktop`（production 数据环境）                                  |
| 桌面测试环境     | `pnpm dev:desktop:test`（`ZCODE_ENV=test`，不保证数据隔离）                |
| Web 开发         | `pnpm dev:web`                                                             |
| 构建工作区       | `pnpm build`                                                               |
| Windows x64 打包 | `pnpm bundle:desktop -- --os=win --arch=x64`                               |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与全量架构检查）                              |
| 架构检查         | `pnpm architecture:check --changed`                                        |
| 模块阅读包       | `pnpm architecture:context <module-id>`                                    |
| 未使用依赖与导出 | `pnpm knip`                                                                |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`                                      |

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

| 验证范围                           | 实际入口与前提                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp UT、协议模拟及真实核心测试合集 | `pnpm --filter @zcode/omp-agent test`；匹配 `test/*.test.ts`，包含真实核心文件，不只是 fake-omp                                                                                                                                              |
| 协议级 fake-omp 集成测试           | `pnpm --filter @zcode/omp-agent exec tsx --test test/adapter.e2e.test.ts`；不依赖真实模型，不覆盖真实 omp/GUI 边界                                                                                                                           |
| 真实核心 E2E                       | `pnpm --filter @zcode/omp-agent exec tsx --test test/real-omp.e2e.test.ts`；用 `OMP_RPC_BINARY_PATH` 指向本机已安装的 omp，使用既有凭据；本机未安装时不执行，不为验证另行下载或安装。设置 `OMP_AGENT_SKIP_REAL_E2E=1` 时跳过，跳过不能算通过 |
| OMP 消费端与上游 UT/集成测试       | `packages/{ui,services,shared,client,server}/test/` 保留 OMP 输入、协议、工具结果、身份和恢复核心测试及所有上游原有测试；按真实文件用根 `pnpm exec tsx --test <测试文件>` 执行，不能假定各包有 `test` script                                 |
| 桌面 GUI 冒烟                      | `node scripts/dev/gui-smoke-cdp.mjs`；需要当前测试桌面已启动、CDP 9230 及 localhost renderer，仅检查品牌/输入区并截图，不是完整功能 E2E                                                                                                      |

真实核心验收使用用户 omp 既有配置中的 `zhipu-coding-plan/glm-5.3-flash`；审批通过运行时 flag 注入，不修改用户配置文件。模型测试只使用专用隔离根与测试会话，不连接日常实例，缺少安装/凭据或跳过不能算通过。

fulltest/slowtest 保留两个专用产品 GUI：`packages/desktop/test/ompStartup.gui.e2e.mjs` 检查真实启动与模型目录；`packages/desktop/test/ompReviewedDefects.gui.e2e.mjs` 以 `OMP_E2E_PHASE=live` 创建两轮真实消息，再由同根新进程以 `recovery` 验证稳定 UUID、唯一侧栏项及历史。门禁用 `ompCore.launch.mjs` 自动创建隔离根与独占端口并持有完整子进程树，通过测试启动层保持窗口隐藏且不可全局聚焦；只用 CDP/DOM，不连接日常实例，不接管鼠标或前台焦点。

工具详情组件验收：`node packages/desktop/test/toolContentPresentation.components.e2e.mjs` 创建临时端口、独立 Electron/userData，不调用模型，验证有效零/布尔、空参数、文本/JSON/Markdown、原始数据开合及错误。它不替代真实模型/冷恢复。

UI UT 的 `@/` 路径别名使用 `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test <真实测试文件>`。已删除的原生命令大全、Agent 多页/状态专项、技能/profile/mentions 和性能基准不再是可运行测试入口；历史报告仅作历史证据。

## 三级测试门禁

- `pnpm fastcheck`：仅 Windows 本机，只运行静态分析、格式和增量编译，不执行任何测试（包括快速 UT、冒烟和门禁自检）。AI 只在相关修改成批完成且确有验证需要时选择执行；非编译预算最多 60 秒，不给纯编译继承此墙钟限制。
- 三级计划、计时与失败语义唯一维护于[三级测试需求](docs/requirements/test-gates.md)：fulltest 包含全部 fastcheck 原语和现存适用当前平台测试（包括隔离 GUI），非编译预算最多 900 秒；slowtest 包含 fulltest 一次，非编译预算最多 1500 秒。项目无适用 WSL 测试扩展，报告 `SKIPPED_NOT_APPLICABLE`，slowtest 与 fulltest 覆盖相同。不再按耗时区分层级，参数只能下调预算。
- 复用原有检查定义、质量配置和测试断言。此前授权删除的 Fork 专项不恢复；上游原有测试保留。不为门禁速度缩减现存适用测试，超预算 Fork 按完整上游差异与依赖图确定受影响模块范围，逐项声明遗漏的整仓覆盖，不能跳过受影响失败项。
- fulltest/slowtest 需要当前用户明确执行指令；显式调用 `jch-fastcheck-fulltest-slowtest-gates` 本身授权该任务所需三级运行与必要复验，不逐次询问，任务结束后失效。历史授权、代理建议、提交/推送或“检查一下”不授权。`--human-authorized` 是软约束，只反映原始明确指令或当前显式技能授权，不是 Agent 自行决定；不能绕过门禁执行内部长步骤。
- 三个入口只在本机运行，不调用 CI、远端/发布流水线、Computer Use，不移动/点击全局鼠标、不抢前台焦点。不接受 `--publish-releases`，不推送、不创建 Tag、不发布；独立分发 workflow 保留不动。接管鼠标的测试保留单独入口，必须另外获得用户明确指令，状态为 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`，不记为门禁失败或通过。
- 每次结果绑定本次 HEAD、未提交差异摘要、内容指纹与工具版本；源码变化后旧结果不能沿用或跨快照合并。真实 OMP/GLM 与 GUI 必须使用专用隔离 fixture 和数据根，不连接日常实例、不修改用户配置；历史失败、跳过和未验证记录不得改写成通过。
- 尚未授权时只执行 fastcheck 和临时短桩自检，不借专项入口执行完整门禁。保留既有质量检查及精简后有效的核心行为断言，不为通过放宽判据；删除的非核心/非 OMP/冗余/长耗时专项不能宣称已验收。

### 构建与缓存纪律

- 每个入口用单一单调时钟报告 `total / compile_excluded / budgeted / limit / status`，至少一位小数；只排除纯编译活跃且无非编译工作活跃的区间并集。准备、发现、静态检查、测试、等待、快照与清理计费，编译与这些工作重叠仍计费一次。任何成功、失败、缺环境、TIMEOUT 或已处理取消都输出完整计时，超时结束所属进程树并非零退出。
- 使用现有 `tsc -b` composite/incremental、固定 dist/out 及稳定 Vite 缓存；连续 fastcheck 不调用 clean、删除产物或切换配置/缓存目录来强制重编译。不清缓存测冷性能；只有自然冷缓存样本才可称冷缓存。安全独立阶段必须并行，改写源文件、共享不兼容产物与 live/cold 顺序保留依赖屏障。
- 技能迁移只修改编排、准备、计时及必要文档，不改产品行为或既有测试判据；临时短桩门禁自检独立于 fastcheck。没有适用 WSL 扩展不安装/启动 WSL；不可用扩展与适用扩展失败不得混为一谈。

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
