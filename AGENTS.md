## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 项目定位与需求权威（Fork）

- 本仓库是上游 `zai-org/ZCode`（`main`）的下游 Fork，仅供个人使用；唯一同步来源为 `https://github.com/zai-org/ZCode` 的 `main` HEAD，持续同步，优先采用上游最新实现。
- 本项目完全由 AI Agent 实现和维护：质量不依赖用户手工读代码或人工回归，必须依靠可复现的自动化验证与文档约定。
- 需求权威文档是根目录 `FORK.md`：Fork 目的、相对上游的差异需求与验收标准以它为准；本文件仅概括 CentOS 7 专用分支必须遵守的边界，细则见 `FORK.md` 和 `docs/specs/centos7-release.md`。修改需求时先同步权威文档，再更新此处摘要。
- 新增、修改或取消本地差异需求，或需求与预期用户可见行为变化时，MUST 检查并同步 `FORK.md`；仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。
- 上游同步任务中先保全本地改动和差异需求，正常优先可靠合并；冲突难以可靠解决时，可以相关冲突部分的上游当前实现为基础，按 `FORK.md` 重新实现仍然有效的本地需求，不执着保留旧补丁。同步后 MUST 逐项核对仍然有效的本地需求，而不是只检查是否存在 Git 冲突；重建后必须通过相应测试验证，未通过不得宣称同步完成。
- 不据此丢弃无关本地改动、覆盖 `FORK.md` 这一唯一需求依据或擅自重置整个仓库；无法可靠保留本地功能时中止同步，不静默丢弃。

## CentOS 7 专用分支的功能边界

以下要求仅适用于长期维护的 `experiment/centos7-no-proot` 分支。该分支面向不能连接互联网的企业内网：保留桌面界面与交互，由内嵌的定制 omp 负责模型、技能、扩展、凭据和会话等 Agent 核心能力，不另建桌面模型或技能来源。

- 桌面应用默认不使用互联网，与是否传入 `--offline` 无关。删除旧 ZCode 账号、订阅与购买、云分享、在线插件商店、在线机器人、反馈/社区、遥测、公网配置和外部资源的界面及调用链；不得只隐藏入口却保留会主动联网的后台任务。推荐内容和图标使用本地资源。
- 只有内嵌 omp 可按自身配置连接企业内部模型 API；内置浏览器可访问企业内网资料，包括解析到私有地址的内网域名。其他桌面 HTTP(S)/WebSocket 请求仅限本机回环，不为桌面服务增加内网域名白名单。企业 SSH 工作区和本地定时任务保留。
- 启动器可选 `--offline` 仅透传给内嵌 omp；未传时不强制 omp 离线。`--profile` 同时决定内嵌 omp 及界面读取的配置，显式参数优先于保存的设置。
- CentOS 7 x64 安装包为普通用户可在 HOME 内解压运行的自包含 ZIP：兼容 glibc 2.17，无需 root、PRoot、联网或安装宿主运行时，不替换用户已有的 omp；中文界面不依赖宿主安装中文字库。`--home <绝对路径>` 指定时，应用及内嵌 omp 管理的全局持久与临时数据均须落在该目录下，同时保留原 `HOME` 以读取 SSH 配置；冲突的原有目录或链接不得覆盖。
- 维护此分支时按 `docs/specs/centos7-release.md` 验证网络边界、OMP 参数、数据目录和 CentOS 7 虚机启动。不要将这些专用取舍误施加到其他平台分支；未通过验证的功能不能标为完成。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                      |
| ---------------- | ----------------------------------------- |
| 类型检查         | `pnpm typecheck`                          |
| Lint             | `pnpm lint` / `pnpm lint:fix`             |
| 格式检查         | `pnpm fmt:check`                          |
| 桌面开发         | `pnpm dev:desktop`                        |
| Web 开发         | `pnpm dev:web`                            |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与架构检查） |
| 架构检查         | `pnpm architecture:check --changed`       |
| 模块阅读包       | `pnpm architecture:context <module-id>`   |
| 未使用依赖与导出 | `pnpm knip`                               |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`     |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

- `packages/desktop`：Electron main、host、renderer。
- `packages/web`、`packages/server`：Web 客户端与服务端。
- `packages/ui`：共享 React 组件、hooks 与 Zustand store。
- `packages/services`：业务服务；`packages/rpc`：RPC 框架。
- `packages/shared`：共享协议与类型；`packages/client`：Agent 客户端 SDK。
- `packages/omp-agent`：omp RPC 核心适配器（对 host 讲 ZCode Protocol/v4，对内嵌 omp 二进制讲 omp RPC；本 Fork 的本地 Agent 核心）。
- `apps/zcode-cli`：保留上游源码快照以降低同步冲突，但不进入根 pnpm workspace、构建或分发；实际 Agent CLI 与运行时仍由 omp 替代。未经用户要求不得将其接回产品。
- 换核测试：`pnpm --filter @zcode/omp-agent test`（协议级 fake-omp E2E）；真实二进制 E2E 同目录 `test/real-omp.e2e.test.ts`（需先 `pnpm --filter @zcode/desktop run prepare:agent-bundle` 下载内嵌 omp）。
- `CONTEXT.md`：插件商店领域词汇；修改相关 UI 前阅读。
- `DESIGN.md`：UI 设计规范；修改 UI 前阅读。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
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
