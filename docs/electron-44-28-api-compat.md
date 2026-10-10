# Electron 44 ↔ 28 API 差异清单（W2 双运行时兼容审计）

> 状态：历史 W2 审计交付（对应 `docs/test-reports/refactor-plan.md` W2-2）；其中实验、扫描及通过记录仅证明当时范围，不是当前测试入口或 CentOS 验收结论。现行产品标准见 `docs/requirements/centos7-release.md`「Ownership and boundaries」。
> 运行时基线：Windows 全功能基准 = Electron 44.4.5（内嵌 Node 22+，`node:sqlite` 可用）；CentOS 7 发布构建 = Electron 28.3.3（Chromium 120、内嵌 Node 18.18.2）。
> CentOS 专属 API 扫描自动测试已取消，不再提供运行命令或测试 baseline 登记要求。新增 Main/Host/renderer 代码仍不得引入清单外仅 Electron 44 可用的 API，产品兼容清单与构建期约束保留；AI 仅按 [现行测试需求](requirements/test-gates.md) 在 Windows 本机测试，不进入 Linux/WSL/VM，也不测试、触发、等待或验证发布 workflow。

## 1. 双 ABI 实测结论：better-sqlite3 9.6.0 不能单驱动

实测环境：Windows x64，Node v24.20.0，node-gyp v12.4.0，VS 2022 BuildTools，better-sqlite3 9.6.0（workspace 实际安装副本）。

| 实验                                                                                                                            | 结果                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prebuild-install`（Node 24 ABI v137，win32-x64）                                                                               | GitHub release 资产 404，无预编译二进制                                                                                                                               |
| `node-gyp rebuild --release`（Node 24 headers，源码默认 `/std:c++17`）                                                          | 失败：`v8config.h(13,1): error C1189: #error: "C++20 or later required."`                                                                                             |
| 同上，改 binding.gyp 为 `/std:c++20` 重试                                                                                       | 失败：85 个 C2xx/C7xx 错误——`CopyablePersistentTraits` 已从 V8 移除、`ObjectTemplate::SetAccessor`/`AccessorGetterCallback` 已删除/改名、`DefineOwnProperty` 签名变更 |
| `node-gyp rebuild --release --target=28.3.3 --dist-url=https://electronjs.org/headers --arch=x64`（Electron 28 headers，C++17） | 成功（`gyp info ok`），产出 `build/Release/better_sqlite3.node`                                                                                                       |

结论：better-sqlite3 9.6.0 是 V8 API 原生插件（非 N-API），同一份源码无法同时覆盖 Electron 28 与 Electron 44 两个 ABI；单一 better-sqlite3 驱动不可行。sqlite 层保持 `packages/services/src/session/tasksDatabase/sqlite.ts` 的双驱动单入口（运行时有 `node:sqlite` 则优先，否则回退 better-sqlite3），与 centos7-release.md 的选型一致。CentOS 7 发布流水线沿用 `scripts/publish/centos7/build-native-assets.mjs` 用 Electron 28 header 现场编译 9.6.0（本机实验证明该路径可编译通过）。

## 2. 已知差异项与回退（全部核查成立）

| 差异 API                        | Electron 44                                 | Electron 28      | 回退位置（已核查）                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node:sqlite`                   | Node 22+ 内置                               | 无（Node 18.18） | `packages/services/src/session/tasksDatabase/sqlite.ts` 双驱动；四个使用点（`chromeCookieManager.ts`、`automationRepo.ts`、`offPeakTaskRepo.ts`、`taskIndexRepo.ts`、`tasksDatabase/startup.ts`）全部经 `createDatabaseSync` 单入口，无散落直连（grep 核查） |
| `fs/promises.glob`              | Node 22+                                    | 无               | `packages/services/src/system/sshConfigAlias.ts`：`nativeGlob` 可选探测 + `expandPathGlob` 回退（第 289 行三元）                                                                                                                                             |
| `webUtils.getPathForFile`       | webUtils 自 Electron 29；32+ 移除 File.path | 无               | `packages/desktop/src/preload/index.ts` `getPathForFile`：先检测 `webUtils.getPathForFile`，仅缺少能力时回退 File 的非标准 `path` 属性；原专用测试已随核心门禁减重删除，历史验证不代表当前覆盖                                                               |
| `webContents.navigationHistory` | Electron 31+                                | 无               | 全库未使用 `navigationHistory`（grep 核查）；浏览器历史走 `<webview>`/webContents 经典 `canGoBack/goBack/goForward`（`browserCommandTypes.ts`、`browserGuestManager.ts`），Electron 28 可用                                                                  |

Electron 命名空间面审计：Main/Host/preload 的通用 import 包含 BrowserWindow、Menu、MessageChannelMain、MessagePortMain、NativeImage、Notification、Tray、UtilityProcess、WebContents、WebFrameMain、app、contextBridge、crashReporter、dialog、ipcMain、ipcRenderer、nativeImage、nativeTheme、powerMonitor、powerSaveBlocker、screen、session、shell、utilityProcess、webContents、webFrame，均在 Electron 28 存在；preload 另使用 `webUtils`，必须能力检测后调用，28 走 `File.path` 回退。浏览器 guest 实现为 `<webview>`（Electron 28 支持），无实际 `WebContentsView`/`BaseWindow`/`BrowserView` 类使用。

## 3. Main/Host（Node 18.18 目标）审计发现与修复状态

合并后 main 分叉新增/保留代码逐项扫描（Node 18.18 缺失的运行时 API）。审计曾登记 4 处**未回退的真实不兼容**；经调度者明确授权，W2 已在本分支直接修复并从扫描测试 baseline 移除（修复方式均为等价改写，不改变行为语义）：

| 位置                                                                                                                     | 问题                                                                                                | 修复（已落地）                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/services/src/providers/api/nodeApiClient.ts`                                                                   | `AbortSignal.any`（Node 20.3+，Node 18.18 undefined），超时与调用方 signal 并存路径必触发 TypeError | 改为 abort 监听转发组合：`AbortController` + 对两个来源 `addEventListener("abort", …, { once: true })` 转发原 `reason`，`finally` 解除监听防泄漏，语义与 `AbortSignal.any` 一致 |
| `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts`（pointerFramePoints、frameObstruction 两处） | `Array.prototype.toReversed`（V8 11.0/Node 20+；Node 18.18 为 V8 10.2）                             | `slice().reverse()`——同样返回倒序新副本、不改原数组                                                                                                                             |
| `packages/desktop/src/main/browserView/browserCommandInput.ts`                                                           | 同上                                                                                                | 同上                                                                                                                                                                            |
| `packages/services/src/process/processTreeTerminator.ts`                                                                 | 同上                                                                                                | 同上                                                                                                                                                                            |

其余核查项无回退需求：

- `packages/desktop/src/main/logger.ts`（P0 保留的 main 侧有界异步日志队列）：仅用 `mkdirSync`、`appendFile`、`queueMicrotask`、`Buffer.byteLength`、`process.stdout/stderr.on("error")`——全部 Node 18.18 可用；`OMPCODE_CENTOS7_LOCAL_ONLY` error-only 过滤在队列入队前生效。
- `packages/services/src/runtime-tools/providerRuntimeResolver.ts`、`runtimeToolResolver.ts` 的 `import.meta.dirname`（Node 20.11+ 才有值）：三处均显式 `const moduleDir: string | undefined` 空值保护，Node 18.18 上为 `undefined` 时走无模块相对候选路径分支，安全。
- `structuredClone`（Node 17+）、`AbortSignal.timeout`（Node 17.3+）、`fs.rm/mkdir {recursive:true}`：Node 18.18 可用。
- `fs.watch recursive`（Linux 需 Node 20+）：全库未使用（grep 核查）。
- `node:` 内建导入面（buffer/child_process/crypto/dns/fs/http/module/net/os/path/readline/stream/tls/util/v8/vm/worker_threads/zlib/timers/string_decoder/events）：全部 Node 18.18 存在；无 `node:sea`/`node:test`/`node:sqlite` 之外的 22-only 内建。
- `packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts` 的 `navigator.mediaDevices.getDisplayMedia`/`MediaRecorder` 位于注入隐藏窗口的 HTML 模板内，运行于 Chromium 渲染进程（Chromium 120 均支持），非 main 进程代码。
- undici 双版本（desktop `^8.11.2` ↔ CentOS 构建切 `6.23.0`，services/server 恒 `6.23.0`）：desktop 实际只用 `new Agent({ connect: { lookup } })` 与 `fetch(url, { dispatcher, redirect, signal })`（`desktopSaveFile.ts`），services 用 `Agent`/`ProxyAgent`/`fetch`——两个大版本 API 同形，W1 版本切换无行为分叉；无需独立封装层。

## 4. Renderer（Chromium 120 目标）CSS/JS 兼容扫描

扫描范围 `packages/ui/src` + `packages/desktop/src/renderer`，对照 Chromium 120（Electron 28）可用的 CSS/JS 基线。

### 历史已发现并登记的差异（降级可用，不阻塞启动；当时完整清单由扫描测试 baseline 固化）

`field-sizing`（Chromium 123）与 `scrollbar-width`/`scrollbar-color`（Chromium 121）在 Chromium 120 上属性被忽略，属渐进增强降级，不阻塞功能：

- `field-sizing-content`（内容自适应）：`components/ui/textarea.tsx`、`components/ai-elements/prompt-input-textarea.tsx`（prompt 输入框）、`settings/model-provider-section/ProviderModelMetadataFields.tsx`、`ProviderModelReasoningLevelEditor.tsx` —— Chromium 120 上退化为固定 min 高度、内部滚动，输入仍可用。如需像素级一致由 W4 加 JS autosize 回退。
- `field-sizing-fixed`（显式固定）：`GitActionMenu.tsx`、`feedback/FeatureRequestDialog.tsx`、`feedback/FeedbackSubmitSections.tsx` —— 元素本身带固定 h/min-h，默认行为即 fixed，Chromium 120 无实际差异。
- `scrollbar-width: none`（隐藏滚动条）：`styles.css`、`presentation/presentationPdfPrintExport.ts`、`settings/model-provider-section/codingPlanEmbeddedWebview.ts`、`v4/ConversationDraftSuggestedPrompts.tsx` —— Chromium 120 上滚动条变为系统默认可见样式；`styles.css` 的 `scrollbar-color` 同理回落默认配色。原 P2/W4 计划曾要求目标平台视觉走查及按需 `::-webkit-scrollbar` 回退（120 支持）；该专属测试计划已取消，历史清单不证明真实观感已验收。

### 已核查无差异

- `light-dark()`：仅出现于 `code-viewer.tsx` 注释；该组件已用显式 token 颜色规避（原文注释说明）。
- Chromium ≤120 已支持的特性在用且安全：容器查询/`@container`（105）、`:has()`（105）、native CSS nesting（112）、`text-wrap: balance`（114）、popover 属性（114，仓库内为 Radix 组件命名非 HTML popover）、`Promise.withResolvers`（119）、`Object.groupBy`/`Map.groupBy`（117）、`toSorted/toReversed`（110）、`URL.canParse`（120）、`@scope`（118）、`@starting-style`/`transition-behavior: allow-discrete`（117）、`@page { size; margin }` 基础打印（远早于 120；131 新增的是 margin boxes，未使用）。
- Chromium 121+ JS API（`Array.fromAsync` 121、Set methods 122、Iterator helpers 122、`Promise.try`、`RegExp.escape`）：renderer 源码扫描零命中。
- 注释/字符串误导项：`z-1`、`shadow-xs`、`border-popover` 等为 Tailwind v4 类名，非新 CSS 特性。

## 5. 双后端行为等价边界（sqlite，机器已验证部分）

- 双后端专项 UT 曾验证默认/强制后端、快照、备份、busy、只读、NOTADB、bigint 和关闭后语句；2026-10-10 按用户要求删除非核心专项，这些是历史结果而非当前入口。保留的 `packages/services/test/ompTaskIdMigration.test.ts` 仍验证 OMP 稳定身份迁移与真实 SQLite 冷读取，不替代完整后端等价性验证。
- 已确认并固化的两后端差异：超精度整数默认读取——node:sqlite 抛 `RangeError`，better-sqlite3 返回不精确 number。等价边界=所有可能超 2^53 的列必须 `setReadBigInts(true)`（`chromeCookieManager` 的 `expires_utc`、迁移校验均已如此）。
- TEXT 内嵌 NUL：驱动读取/比较语义不可依赖（`taskIndexRepo.ts` 已用 JSON 编码 node_key 规避，注释在案）；等价性只在无 NUL 文本上要求。

## 6. 验证状态与未验证范围

- 历史本机已验证：better-sqlite3 9.6.0 对 Electron 28 headers 编译通过、对 Node 24 headers 两种 C++ 标准均失败；sqlite UT/typecheck/lint（见提交记录）；当时扫描测试全绿（§3 的 4 处 Node 18.18 破坏点已修复并移出 baseline，扫描 0 违规 0 baseline）。这些历史事实保留，不作为当前工作树通过结论。
- 未验证边界仍保留：Electron 28.3.3 真实运行时内加载 better-sqlite3 二进制、CentOS 7 glibc 2.17 构建器编译、§3 修复在 Electron 28 运行时的实测、渲染层 field-sizing/scrollbar 降级的真实观感。原 C1/P2 VM 与 UI 专属测试安排已取消，不再作为 Windows 测试或 workflow 修改前提；不得以本清单、取消测试或发布成功冒称已验收。
- 后续兼容行为及构建期完整性仍遵循现行 CentOS 产品需求；不恢复已取消的扫描测试、baseline 或 Linux 专属 UT 入口。
