## 核心原则

- 新增或修改行为前，先更新 `docs/requirements/` 中对应功能域的需求与验收场景；目录或权威体系缺失时先补齐。明确产品规则、状态所有者、接口和验收场景后再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 项目定位与需求权威（Fork）

- 本仓库是持续同步上游的个人 Fork；上游来源、跟踪目标和产品目的见 `docs/requirements/FORK.md`。同步操作只针对其中指定的上游 `main` HEAD，优先采用上游最新实现。
- 本项目完全由 AI Agent 实现和维护：质量不依赖用户手工读代码或人工回归，必须依靠可复现的自动化验证与文档约定。
- 固定需求权威目录是 `docs/requirements/`，从 `README.md` 按功能边界定位文档；Fork 目的、差异需求、规划及验收标准只在该目录维护。根目录 `FORK.md` 仅保留跳转，不是第二份权威副本。
- 新增、修改或取消本地差异需求，或预期用户可见行为变化时，MUST 检查并同步目录中对应文档；新独立功能域可新增文档并更新索引，每项需求只有一个维护位置。仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。入口、命令或开发规则变化时同步本文件。
- 已获授权的上游同步任务中先保全本地改动和差异需求，正常优先可靠合并；冲突难以可靠解决时，可以相关冲突部分的上游当前实现为基础，按 `docs/requirements/` 重新实现仍然有效的本地需求，不执着保留旧补丁。同步后 MUST 逐项核对目录中仍然有效的本地需求，而不是只检查是否存在 Git 冲突；重建后必须通过相应 UT 和 E2E 验证，未通过不得宣称同步完成。
- 不据此丢弃无关本地改动、覆盖唯一需求依据或擅自重置整个仓库；无法可靠保留本地功能时中止同步，不静默丢弃。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                         |
| ---------------- | -------------------------------------------- |
| 类型检查         | `pnpm typecheck`                             |
| Lint             | `pnpm lint` / `pnpm lint:fix`                |
| 格式检查         | `pnpm fmt:check`                             |
| 桌面开发         | `pnpm dev:desktop`                           |
| Web 开发         | `pnpm dev:web`                               |
| 构建工作区       | `pnpm build`                                 |
| Windows x64 打包 | `pnpm bundle:desktop -- --os=win --arch=x64` |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与架构检查）    |
| 架构检查         | `pnpm architecture:check --changed`          |
| 模块阅读包       | `pnpm architecture:context <module-id>`      |
| 未使用依赖与导出 | `pnpm knip`                                  |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`        |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer；入口分别为 `src/main/index.ts`、`src/host/index.ts`、`src/renderer/src/main.tsx`。
- `packages/web`、`packages/server`：Web 客户端与服务端；入口分别为 `src/main.tsx`、`src/entry-http.ts`。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `packages/omp-agent`：omp RPC 核心适配器（对 host 讲 ZCode Protocol/v4，对内嵌 omp 二进制讲 omp RPC；本 Fork 的本地 Agent 核心）。
- `packages/omp-agent/src/adapters/cliMain.ts`：Host 启动的 Agent stdio 入口。
- `apps/zcode-cli`：保留的上游源码快照，不在根 workspace 中；运行时边界见 `docs/requirements/FORK.md`，未经用户要求不得接回产品。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

构建与测试须先按 `mise.toml` 准备 Node 24.14.0、pnpm 10.33.2 及 workspace 依赖；桌面完整构建/打包需要对应平台构建环境，运行时准备可能联网下载资产。上表及下表是源码中存在的入口，列出不等于本次已执行或已验证所有平台可用。

### 自动化验证入口

以下命令从仓库根目录运行；没有统一的根 `test` 或完整 GUI E2E 脚本。

| 验证范围                           | 实际入口与前提                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omp UT、协议模拟及真实核心测试合集 | `pnpm --filter @zcode/omp-agent test`；匹配 `test/*.test.ts`，包含真实核心文件，不只是 fake-omp                                                                                                                                                      |
| 协议级 fake-omp 集成测试           | `pnpm --filter @zcode/omp-agent exec tsx --test test/adapter.e2e.test.ts`；不依赖真实模型，不覆盖真实 omp/GUI 边界                                                                                                                                   |
| 真实内嵌核心 E2E                   | `pnpm --filter @zcode/omp-agent exec tsx --test test/real-omp.e2e.test.ts`；先准备 `pnpm --filter @zcode/desktop run prepare:agent-bundle`，使用已发布内嵌二进制及 omp 已有凭据；缺少二进制或设置 `OMP_AGENT_SKIP_REAL_E2E=1` 时跳过，跳过不能算通过 |
| 其他包 UT/集成测试                 | `packages/{desktop,ui,services,client,server}/test/` 存在测试文件；按实际文件用根 `pnpm exec tsx --test <测试文件>` 执行，不能假定这些包有 `test` script                                                                                             |
| 桌面 GUI 冒烟                      | `node scripts/dev/gui-smoke-cdp.mjs`；需要当前测试桌面已启动、CDP 9230 及 localhost renderer，仅检查品牌/输入区并截图，不是完整功能 E2E                                                                                                              |

真实模型验收使用用户 omp 既有配置中的 `zhipu-coding-plan/glm-5.3-flash`；审批等测试态通过运行时 flag 注入，不修改用户配置文件。真实测试会调用模型并创建测试会话，必须明确环境和范围；测试服务使用临时端口，不影响用户已有 ZCode/omp 进程。现有 GUI 走查与已知未验收范围见 `docs/test-reports/`，后续功能开发仍须补足相关真实入口到结果的 E2E。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 功能开发和功能性修改必须有自动化验证：UT 验证局部逻辑，E2E 验证从真实公开入口到可观察结果的完整功能链路，跨模块交互按需增加集成测试。先补充缺少的场景，已有有效覆盖可以复用，不机械新增测试。
- 测试必须对应需求与验收条件，覆盖核心成功路径和相关关键失败路径，不得仅复述实现或验证未崩溃。UT、编译、静态检查和局部模拟不能替代 E2E；桩与模拟可补充测试，未经过的真实边界必须说明。
- 区分已实现、验证通过、验证失败和未验证；环境、依赖或权限不足时写明未验证范围，不能声称功能已验收。缺少 UT/E2E 时记录缺口并在后续功能开发中补齐，不编造入口或降低标准。纯文档等非功能性变更按实际影响验证，不强制运行无关的完整功能测试。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
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
