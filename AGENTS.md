## 核心原则

- 新增或修改行为前，先更新 `docs/requirements/` 中对应功能域的需求与验收场景；目录或权威体系缺失时先补齐。明确产品规则、状态所有者、接口和验收场景后再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- OMP 本地源码目录 `F:\code2026\oh-my-pi` 存在，优先以其源码为权威资料；RPC 协议权威见该仓库 `docs-zh-CN/requirements/rpc-ui-protocol.md`。本机器安装的 omp 必然是最新版本，无需另行核验是否最新；未安装 omp 时不执行依赖真实 omp 的验证，明确记录为未验证，跳过不能算通过。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 项目定位与需求权威

- 本项目源自 ZCode，现独立演进，不再合并上游，ZCode 上游代码仅供参考；历史来源、演进策略、产品目的、支持平台及平台差异边界唯一维护于 [FORK 总纲](docs/requirements/FORK.md)。UI、依赖与环境门控改动须先核对该总纲及所属功能域。
- 模块组织遵循[独立演进策略与平台范围](docs/requirements/FORK.md#独立演进策略与平台范围)及本仓库架构策略，不再以便于合并上游或缩小相对上游 diff 为约束。
- 本项目完全由 AI Agent 实现和维护：质量不依赖用户手工读代码或人工回归，必须依靠可复现的自动化验证与文档约定。
- 固定需求权威目录是 `docs/requirements/`，从[需求索引](docs/requirements/README.md)按功能边界定位文档；项目目的、需求、规划及验收标准只在该目录维护。根目录 `FORK.md` 仅保留跳转，不是第二份权威副本。
- 新增、修改或取消项目需求，或预期用户可见行为变化时，MUST 检查并同步目录中对应文档；新独立功能域可新增文档并更新索引，每项需求只有一个维护位置。仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。入口、命令或开发规则变化时同步本文件。
- 不执行 ZCode 上游同步或合并，不将上游最新实现视为默认优先方案。借鉴上游代码时，按本项目现行需求、架构与验收标准独立评估和实现；不因上游变化恢复已取消功能、丢弃无关本地改动、覆盖需求依据或重置仓库。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 支持范围以根 `package.json` 的 `engines.node` 为准；`mise.toml` 固定版本是可复现开发基线，不要求门禁运行时精确相等。

以下命令从仓库根目录执行：

| 用途             | 命令                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| 类型检查         | `pnpm typecheck`                                                       |
| 快速门禁         | `pnpm fastcheck`（仅静态/格式/编译，非编译预算 60 秒）                 |
| Windows 完整验证 | `pnpm fulltest --human-authorized`（总墙钟 900 秒，含编译与清理）      |
| Windows 慢速门禁 | `pnpm slowtest --human-authorized`（同 fulltest 覆盖，总墙钟 1500 秒） |
| 缓存过期只读诊断 | `pnpm fulltest --check-tests-up-to-date`（不执行测试，不作为完整验收） |
| 构建配置只读分析 | `pnpm fulltest --analyze-only`（仅分析现有 BUILD，不生成、编译或测试） |
| 分析缓存丢弃诊断 | `pnpm fastcheck --cache-debug`（可追加到已授权的 fulltest/slowtest）   |
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

构建与测试须准备满足根 `package.json` 支持范围的 Node、`mise.toml` 固定的 pnpm 10.33.2 及 workspace 依赖；需要可复现环境时使用 mise 的 Node 24.14.0 基线，不因系统 Node 更新而要求降级。桌面完整构建/打包需要对应平台构建环境，运行时准备可能联网下载资产。上表及下表是源码中存在的入口，列出不等于本次已执行或已验证所有平台可用。

`dev:desktop:test` 只选择产品 test 环境，不创建专用 OMP 根或 profile；真实验收必须使用下述隔离启动器并核对实际数据落点。环境变量与根目录规则见[模型与命令](docs/requirements/models-and-commands.md#产品规则与所有权)，不能将命令名称中的 `test` 当作隔离证明。

### 自动化验证入口

以下原始入口仅在 Windows 本机运行；根目录以三级门禁统一编排，没有名为 `test` 的根脚本。单独入口仍保留各自隔离环境前提与验证边界。AI 不执行 Linux/CentOS/WSL 测试；CentOS 专用测试及 VM、Citrix、目标网络盘专项测试已取消，不再是 Windows 测试前提，产品的两平台支持与打包完整性约束仍保留。

| 验证范围                           | 实际入口与前提                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp UT、协议边界及真实核心测试合集 | `pnpm --filter @zcode/omp-agent test`；匹配 `test/*.test.ts`，包含局部协议 UT、复制模型引擎、回环流式传输、真实适配器与核心 E2E；真实核文件缺环境或跳过时不能把合集记为完整通过                                                                                                                |
| 真实适配器 E2E                     | `pnpm --filter @zcode/omp-agent exec tsx --test --test-concurrency=2 test/adapter.e2e.test.ts test/adapterRuntime.e2e.test.ts test/nativeControl.e2e.test.ts`；使用本机已安装的真实 OMP + 测试自有本地模拟模型，经公开 stdio/v4 验证适配行为，不替代 GUI 验收                                  |
| 真实核心 E2E                       | `pnpm --filter @zcode/omp-agent exec tsx --test test/real-omp.e2e.test.ts`；与适配器 E2E 共用真实核启动器和隔离模型；可用 `OMP_RPC_BINARY_PATH` 指向本机安装核，本机未安装或设置 `OMP_AGENT_SKIP_REAL_E2E=1` 时两类均未验证，不另行下载、安装或回退到内嵌旧核                                  |
| OMP 消费端与上游 UT/集成测试       | `packages/{ui,services,shared,client,server}/test/` 保留 OMP 输入、协议、工具结果、身份和恢复核心测试及所有上游原有测试；按真实文件用根 `pnpm exec tsx --test <测试文件>` 执行，不能假定各包有 `test` script；触及 OMP 进程/目录/会话边界时同样使用真实核及共用隔离 fixture，缺核/跳过均未验证 |
| 桌面 GUI 冒烟                      | `node scripts/dev/gui-smoke-cdp.mjs`；需要当前测试桌面已启动、CDP 9230 及 localhost renderer，仅检查品牌/输入区并截图，不是完整功能 E2E                                                                                                                                                        |

适配器、核心及消费端的 OMP 边界验收使用共用 `realOmpHarness.ts` 和仓库内复制适配的 OMP 模拟模型，不保留 OMP 进程或端口对象桩；纯 schema、投影、tracker 和文件算法 UT 不注入伪造 OMP 进程。测试进程持有回环临时端口和隔离配置根；真实核与 GUI 固定通过运行时参数使用 OMP 原生 yolo，不修改用户配置文件。不读取用户模型凭据、不接受外部模型覆盖、不连接外部提供者或失败后回退；缺少本机 OMP 或跳过不能算通过。本轮不测工具权限审批，但 ask、连续工具调用、子代理界面、Todo 界面均为必验；唯一范围与真实 GUI/OMP/持久化/同根恢复证据见[本轮五项契约](docs/requirements/test-gates.md#本轮五项必验与排除范围)，不能据此删除产品通用权限或原生命令交互。启动器与门禁阶段所有权、能力矩阵及证据边界唯一见[本地模拟模型契约](docs/requirements/test-gates.md#本地模拟模型契约)和[三级编排](docs/requirements/test-gates.md#所有者与入口)。外部模型调用的配置、规程及相关历史细节仅由 [e2e.md](docs/requirements/e2e.md) 维护，不构成自动化门禁默认入口。

Windows 适配器在实际 `spawn` 边界为每个真实 OMP 核心创建独占临时 native 缓存叶目录，直接启动真实 binary，不使用 wrapper 或预热；显式 `PI_NATIVES_DIR` 仅作父根，未指定时用系统临时目录。核心仍共享原 `OMP_CONFIG_ROOT`、profile 和 cwd；实际核心退出并释放句柄后只清理自有叶目录，永不删除共享缓存。生产与真核测试走同一路径，业务冷启动保持并发；所有权及失败契约见上述本地模拟模型契约。

fulltest/slowtest 使用同一本地模型计划：`packages/desktop/test/ompStartup.gui.e2e.mjs` 检查真实启动与隔离模型目录；`packages/desktop/test/ompReviewedDefects.gui.e2e.mjs` 的 `OMP_E2E_PHASE=live/recovery` 保留流式消息、yolo 下真实 write 与落盘、ask 作答、task 子代理及同根新进程冷恢复；五套 `omp{Conversation,Models,Agents,Native,Interactions}Acceptance.gui.e2e.mjs` suite 补充当前功能验收，连续工具链由 conversation 入口覆盖，具体必验与排除范围按上述权威契约。恢复核对稳定 UUID、唯一侧栏项、消息历史、逐工具/问答结果及实际子代理身份和记录，不能只看最终回复。门禁用 `ompCore.launch.mjs` 为各 suite 自动创建独立隔离根与独占端口并持有完整子进程树，通过测试启动层保持窗口隐藏且不可全局聚焦；保留真实 Main/Host/Preload/OMP，只用 CDP/DOM，不连接日常实例，不接管鼠标或前台焦点。

工具详情组件验收：`node packages/desktop/test/toolContentPresentation.components.e2e.mjs` 创建临时端口、独立 Electron/userData，不调用模型，验证有效零/布尔、空参数、文本/JSON/Markdown、原始数据开合及错误。它不替代真实 OMP + 模拟模型的产品 GUI/冷恢复。

离线存储 Windows 隔离冒烟：桌面 `tsup` 产物就绪后执行 `node packages/desktop/test/offlineDesktop.windows-smoke.mjs`；使用独立 Electron/userData、通过 helper 注入的本机临时根，验证逻辑 localStorage 导出、延迟调度、真实备份 Worker 与 SQLite WAL 快照，不调用模型、不连接日常实例、不抢焦点。它不启用生产平台绕过变量，不代表 Linux/shm/NFS 或完整产品 GUI 已验收；路径与失败边界的短回归为 `pnpm exec tsx --test packages/desktop/test/offlineDesktop.test.ts`。fulltest/slowtest 收录这些新增适用测试，但仍须本次明确授权。

UI UT 的 `@/` 路径别名使用 `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test <真实测试文件>`。已删除的原生命令大全、Agent 多页/状态专项、技能/profile/mentions 和性能基准不再是可运行测试入口；历史报告仅作历史证据。

## 三级测试门禁

- `pnpm fastcheck`：仅 Windows 本机，只运行静态分析、格式和增量编译，不执行任何测试（包括快速 UT、冒烟和门禁自检）。AI 只在相关修改成批完成且确有验证需要时选择执行；非编译预算最多 60 秒，不给纯编译继承此墙钟限制。
- 三级计划、计时与失败语义唯一维护于[三级测试需求](docs/requirements/test-gates.md)：fulltest 包含全部 fastcheck 原语和现存适用当前平台测试（包括隔离 GUI），不执行打包，总墙钟最多 900 秒；slowtest 包含 fulltest 一次并追加本地 Windows unpacked 打包及原 afterPack 校验，总墙钟最多 1500 秒。编译、准备与清理均不暂停 full/slow 的截止时间。项目无适用 WSL 测试扩展，单独报告 `SKIPPED_NOT_APPLICABLE`；这不取消 slowtest 的打包职责。参数只能下调预算，不能因此删改测试或打包判据。
- 构建与三级门禁优先由 Bazel 原生图、官方规则、动作/测试缓存、并行、失败即停、测试 timeout 和 profile 接管；规则生成本身也走原生动作缓存，不维护第二份成功账本或 JS 调度器。Node 只保留权限、全程预算、用例首失败、产物物化与真实 GUI/收尾所有权所需的最小适配。生成输入、完整/局部失效、Worktree 缓存隔离及唯一验收标准统一见[三级测试需求](docs/requirements/test-gates.md#所有者与入口)，不在本文件复制规则清单。
- 当前实现和实跑通过分开记录；以本 Worktree `output_base/diagnostics/` 的原生日志及同次外层结果为证据，不将只读查询、局部通过或历史快照当作当前完整通过；状态记录见[实现与验证状态](docs/requirements/test-gates.md#实现与验证状态)。
- 复用原有检查定义、质量配置和测试断言。此前授权删除的 Fork 专项不恢复；上游原有测试保留。不为门禁速度缩减现存适用测试，超预算时按本次完整变更与依赖图确定受影响模块范围，逐项声明遗漏的整仓覆盖，不能跳过受影响失败项。
- fulltest/slowtest 需要当前用户明确执行指令。历史授权、代理建议、提交/推送或“检查一下”不授权。`--human-authorized` 是软约束，只反映原始明确执行指令，不是 Agent 自行决定；不能绕过门禁执行内部长步骤。
- 三个入口只在本机运行，不调用 CI、远端/发布流水线、Computer Use，不移动/点击全局鼠标、不抢前台焦点。不接受 `--publish-releases`，不推送、不创建 Tag、不发布；独立分发 workflow 保留不动。接管鼠标的测试保留单独入口，必须另外获得用户明确指令，状态为 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`，不记为门禁失败或通过。
- 每次结果绑定本次 HEAD、未提交差异摘要、内容指纹与工具版本；源码变化后旧结果不能沿用或跨快照合并。真实 OMP + 模拟模型与 GUI 必须使用专用隔离 fixture 和数据根，不连接日常实例、不读取或修改用户模型配置/凭据；历史结果、失败、跳过和未验证记录不得改写成本次通过。
- 尚未授权时只执行 fastcheck、临时短桩自检及 `--analyze-only` / `--check-tests-up-to-date` 只读诊断，不借专项入口执行完整门禁。只读模式不执行生成、编译或测试，不作为完整验收；具体语义见[三级测试需求](docs/requirements/test-gates.md#所有者与入口)。保留既有质量检查及精简后有效的核心行为断言，不为通过放宽判据；删除的非核心/非 OMP/冗余/长耗时专项不能宣称已验收。
- 任意阶段或用例首个失败立即停止后续调度并终止全部所属并行任务、嵌套 runner 及进程树；保留触发失败、非零退出和最终计时，不等待整组测试结束或预算耗尽。full/slow 的硬截止在失败、验证与清理期间仍有效，到时强制非零退出。未启动/取消的工作不记为通过。

### 构建与缓存纪律

- 每个入口用单一单调时钟报告 `total / compile_excluded / budgeted / limit / status`，至少一位小数；`compile_excluded` 只记录纯编译活跃且无非编译工作活跃的区间并集。fastcheck 按非编译时间限时，fulltest/slowtest 按总墙钟限时。准备、发现、静态检查、测试、等待、快照与清理计费，编译与这些工作重叠仍计费一次。任何成功、失败、缺环境、TIMEOUT 或已处理取消都输出完整计时，超时结束所属进程树并非零退出。
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
- 涉及已取消功能或其共享边界时先核对 [FORK 总纲](docs/requirements/FORK.md)，不得在重构或参考上游实现时恢复已取消需求。
- Desktop 的 `desktop-continuous` 实时链路与 Web 的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 产品输入经 omp-agent 的会话级调度与投影对接 OMP；运行中输入的接纳、消费及终态依据见[会话恢复](docs/requirements/session-recovery.md#冷历史与身份连续性)。不引用未接入产品的上游 CLI `CommandInbox` 作为运行时所有者。Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

Key steps and exception branches in this project must have logs.

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `JCH_LOG_LEVEL` 是应用日志的唯一级别配置，规则见 [日志基础设施](docs/requirements/logging.md)；`debug` 用于高频诊断，仅在显式选择 DEBUG 时输出，生产构建不得覆盖该选择。唯一例外是 CentOS 7 启动器的内网 offline 策略：本次进程树固定为 ERROR 且终端静默，不修改用户环境配置。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
