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
