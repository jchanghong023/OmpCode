# 迁移前 Fork 文档的历史验证记录

以下记录原样保留自本次初始化前的 FORK.md，仅表示当时环境与版本中的报告，不是本次执行结果，也不把模型数量、文件数量或当时 omp 版本固化为需求。早期 commandcode 测试不替代现行真实模型约定。后续 [2026-09-26 GUI 记录](gui-e2e-2026-09-26.md) 的验证范围及未解决发现仍有效。

- 隔离实测：应用运行期仅写 `~/.ompcode`（v2 日志/任务索引/设置/runtime），`~/.zcode` 全程零新增写入（快照对比归因：期间写入方为本机 zcode CLI 会话与用户自装的 `C:\Program Files\ZCode\ZCode.exe`，与本应用无关）；监听端口仅 9230（dev CDP）与 5194（devServer），无 9229/5173/5174/3030 占用。

验收结果（2026-09-25，本节与「omp 内置命令全量支持与临时模型」一并验收）：

- 协议级 E2E 14 例全过（本地命令输出/收口、`prompt_result` 异步收口、`session_info_update`/`config_update` 回投、`available_commands_update` 目录热推送、`modelSelection` 下发与去重、供应商错误 `stopReason=error` failed 收口）；真实二进制 E2E 3 段全过（`/rename` 本地命令 + `sendText` 临时模型切换 glm-5.3-flash 真实出话 + `/model <selector>` 原生命令回投）。
- 桌面 GUI 实测（Windows dev，CDP 驱动，glm-5.3-flash）：斜杠面板为 omp 真实命令目录（93 条，含 skill 命令）；`/rename` 输出投影与标题回投、轮次正常收口；模型下拉按 omp 供应商分组（286 模型），临时模型 glm→ling→glm 往返均有「模型已切换」时间线标记，未授权模型 401 在 UI 显式呈现错误与反馈入口；glm-5.3-flash 真实回复（思考档 max）；设置「模型设置」15 个内建角色与 omp 一致。

---

验收结果：

- 协议级 E2E（`packages/omp-agent/test/adapter.e2e.test.ts`，fake omp 核心）：新建会话 → 流式 → 工具调用 → 权限确认（双向应答路径）→ 文件变更（摘要+查询）→ 完成/中断收口，全部通过；全部 v4 帧通过共享包 wire schema 校验。
- 真实二进制 E2E（`packages/omp-agent/test/real-omp.e2e.test.ts`，releases 实际内嵌 omp.exe + commandcode 免费模型）：createSession → 流式输出 → write 工具 → 审批确认 → 文件真实落盘 → 会话完成，通过。
- 桌面打包产物（Windows x64，`pnpm bundle:desktop -- --os=win --arch=x64`）：`win-unpacked/OmpCode.exe` + `resources/glm/omp-agent.cjs` + `resources/glm/omp/omp.exe`（内嵌 omp v18.2.11+fork.239，SHA256 校验通过）验证在包内；asar 内品牌为 OmpCode。NSIS 安装器 `OmpCode-3.14.3-win-x64.exe` 已在本机成功生成，运行时依赖闭包与体积检查通过；安装器未签名，GUI 级自动化 E2E 尚未执行。

---

验收结果：

- 用户可见位置（应用身份/窗口标题/关于页/菜单/托盘/强更/深链/安装器可见文案/Web 端标题与登录/分享页/i18n 全部品牌串，共 42 文件 313 处）显示 OmpCode；i18n 字符串值内无残留（key 与内部标识按约定保留 zcode）。
- 构建与上游同步流程不因更名受影响（typecheck 通过；appId、scheme、包名、env、路径等内部标识未动）。

---

验收结果：

- 全部图标位（build/ 下的 ico/icns/全尺寸 png、Linux icons 目录、安装器图标、Web favicon.ico 与内嵌 data-URI、README 公共副本、UI 内嵌 SVG logo 与水印、登录/引导/About 的 π 标）统一为 omp 官方图标；生成器 `packages/desktop/scripts/generate-omp-icons.mjs` 零依赖可复现，像素级校验通过。
- Windows 开发态任务栏同样显示 omp 图标：开发态运行时不设置未注册的 AUMID（系统无对应快捷方式时，任务栏会回退 electron.exe 默认原子图标、盖住窗口的 π 图标；已在本机对两种取值实测确认）。打包态 AUMID 行为不变（见已知差异 17）。
- macOS 安装包图标资产已同步更换，但 macOS 见下方已知差异（无 omp 二进制，安装包不可用）。

---

- 验收：协议级流式/分片回归通过；Windows 桌面 GUI 使用 `zhipu-coding-plan/glm-5.3-flash` 发送真实消息并看到完整回复，设置页、终端开关与查找可用。

## 需求索引旧状态记录（2026-10-09 归档）

以下文字从需求索引完整迁出，保留当时的实现、验证及迁移依据。它们是历史记录，含已被后续工作更新的状态；当前需求与状态以 [功能域索引](../requirements/README.md) 所指文档为准，取消的功能不再形成验收义务，也不将历史结果视为当前工作树通过。

- 2026-10-08 会话分享取消（范围与边界见 [FORK.md](../requirements/FORK.md#会话分享取消)）：桌面分享组件、分享 store、SessionPane 派生计算与预检、`conversation-share` 服务目录及注册、远程代理与 attachment 接线、Web `/share`、`/cn/share` 分享页与预览客户端、`zcode://share/import` 深链接与 `ShareImport` 通道、`ConversationShare` 服务通道、协议 `sharedContextImport`/`context_refs` 字段、`accountShare` 门控键（改名 `account`）、`timelineBottomRequest` 定位机制及全部专属翻译键（en/zh 各 165 条 + omp 各 2 条）已删除；Web OAuth 回调路径与 legacy `shared_context` 解码词表按兼容边界保留。根 `pnpm typecheck`、`pnpm lint`（0 警告 0 错误）、`pnpm verify:pre-push`（含全量架构检查 0 违例）通过；`@zcode/omp-agent` 275 项测试 274 通过（唯一失败 `ompSessionsRoot` 的 win32 路径断言经 stash 对比为 HEAD 既有失败，与本次无关）；offline gate 四项 UT 通过（`offlineLockRendererLogging` 因根目录 tsx 解析不到 ui 包 `@/` 路径在 HEAD 上同样失败）。另修复 HEAD 遗留的 host/index.ts TS7053（attachment flow 的 debug 级日志改走 `rpcDebugLogger`，与 `logRpc` 同模式）。既有失败如实记录、未在本次处理：`pnpm fmt:check` 在 HEAD 上即有 16 个与本次无关的文件不通过。GUI 级删除验收（启动桌面确认无分享入口、旧分享链接/深链接不触发导入或网络请求、普通聊天/附件/历史恢复正常）尚未执行，不视为已完成验收。性能优化域新增需求（composer.md 草稿合批、performance.md `@` 补扫复用与计量项）已记录，实现未开始。
- 自建手机远控已从当前产品删除（范围见 [FORK.md](../requirements/FORK.md#手机远控取消)）：专用中继、证书生成、侧栏入口、手机任务标记、IPC、客户端声明、离线门控字段、开发脚本及专用测试均移除；通用 Web、Host attachment 和 replayable 协议保留。根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与桌面 main/Host/preload/scheduler 的 tsup 构建通过；相关回归 17 项通过、0 跳过。Windows 隔离桌面实际打开工作区与设置，侧栏无手机入口、preload 无中继 API，原中继端口无监听且不生成手机证书；握手烟测接受 Desktop/Web、拒绝已删除的手机客户端声明。额外 `pnpm exec tsc -b packages/desktop` 未通过（main 的 rootDir/include、缺失类型导出及浏览器等类型错误），未将此结果记为通过；CentOS 7 真机和发布包未验收。
- 2026-10-07 OMP 核心接入重写（适配 omp v18.8.0+fork.298 RPC 大改）：OMP 删除项目宿主与旧 v3 fork 面，ZCode 侧删除项目模式层，目录能力（complete_command 补全、模型角色、会话目录）迁至常驻目录进程（`--mode rpc-ui --no-session` + v3），斜杠严格分发改适配层本地判定，ask 改经 `set_ask_dialog` + `extension_ui_request{method:"ask"}`，审批降级为通用询问（Approve/Deny），子代理详情/控制改父会话进程；详见 [omp-core-integration.md](../requirements/omp-core-integration.md) 实现与验证状态。
- 2026-09-29/30 OMP 项目模式接入（Z1/Z2）完成（协议面已于 2026-10-07 失效，沿革备查）：omp-agent 内每 workspace 至多一个 OMP 项目进程承载全部会话（旧核自动回落旧拓扑），`/` 输入走 `execute_command` 严格分发，新增 complete_command 动态补全（含参数级）、子代理只读详情（`omp-subagent:<id>@<parent>` 合成地址）与 `control_subagent` 控制入口、模型角色 RPC 化（get_model_roles/set_model_role 逐 role 自动保存）。门禁全绿（typecheck/lint/fmt/architecture 0 违例），`@zcode/omp-agent` 123 项测试 0 失败 0 跳过；GUI 真实验收（OMP 源码进程 + glm-5.3-flash）逐项结果见当期归档记录。
- 2026-09-28 单分支统一重构完成：`experiment/centos7-no-proot` 已合回 `main`（合并提交 cd4a492）并删除本地与远端专有分支（既有 centos7 tag 保留），仓库恢复仅 `main` 一个产品分支；CentOS 7 发布流水线分支校验收窄为仅 `main`。执行计划已归档为 [refactor-plan.md](refactor-plan.md)。P2 七条门禁全绿（freshness、typecheck、lint、fmt、architecture、`@zcode/omp-agent` 全量 95 项含真实核心 E2E 实际执行 0 跳过、双平台真实界面验收）；合并回 main 后复跑 typecheck/lint 仍绿。逐场景结论与证据见 [windows-acceptance.md](windows-acceptance.md)、[centos7-acceptance.md](centos7-acceptance.md) 及 `evidence-windows/`、`evidence-centos7/`。
- 2026-09-28 双平台发布流水线金丝雀均从 `main` 通过：Windows [run 36487871248](https://github.com/jchanghong023/OmpCode/actions/runs/36487871248)（发布 v3.14.3-omp.4，含 `OmpCode-3.14.3-win-x64.exe` 与 SHA256）、CentOS 7 [run 36487891891](https://github.com/jchanghong023/OmpCode/actions/runs/36487891891)（发布 v3.14.3-centos7-36487891891-1，preflight/desktop/native/package/publish 全绿）。
- 上述重构仍未验证（环境不可用，如实记录，不视为已验收）：CentOS 7 真 VM 对发布 ZIP 的 Package acceptance 终验（以本地 C1 链出包 + WSL CentOS-7 原生运行替代验证）、公司 IBus 输入法真机。旧 frp 手机链路随手机远控取消，不再是当前验收项。
- 本次依据初始化前的根目录 `FORK.md` 及对应规格迁移；原文已标记实现的换核、品牌/图标、账号与模型面、命令、输入区、隔离及显示菜单保留“已有实现”的状态，长会话响应性保留“已实现首批”。其余细化规格保留验收要求，不因存在源码就标为已验收。
- [历史 Fork 验证记录](fork-baseline-validation.md) 保留早期结果及安装包 GUI 未验收范围；其中当时的版本、模型数量、测试数不是长期需求或当前结果。
- [2026-09-26 GUI 记录](gui-e2e-2026-09-26.md) 只覆盖报告所列的 Web 页面及一条真实对话。该次桌面启动被审批拒绝；辅助对话标签创建失败仍未确认原因。对应整理文档时未重跑真实核心、桌面/手机 GUI、发布或 CentOS 7 原生环境验收，不能用于证明当前版本已通过。
- `session-recovery.md` 中项目级删除接口缺少 workspace 身份的限制仍未解决；不能声称目录形状校验已证明目标属于当前工作区。
- `FORK.md` 中明确不可用的功能保持不可用；未来实现前提不等于已承诺的新增功能。尚无逐项证明某项本地需求已由上游等价满足的结论。

旧图片 spec 的“混合 PDF 时只发送图片”与原权威 FORK 明确拒绝不支持附件的要求不一致，现统一按原权威要求；旧输入区 spec 的窄窗口收起状态不得覆盖原权威要求保留分支名。这是消除从属文档冲突，未改变既有需求。旧换核 spec 涉及源码删除的条件说明由现行保留上游 CLI 快照的规则取代。
