# GUI 探索式 E2E 测试与修复记录（2026-10-01）

> 技能：`jch-gui-android-tui-e2e-repair`（全自动模式，用户授权全部权限）。运行 ID：`gui-e2e-20261001-225016`。
> 目标：OmpCode Windows 桌面（`pnpm dev:desktop` 隔离开发态，devServer 5194 / CDP 9230，agent-browser 0.38.1 经 CDP 驱动）。
> 真实模型：`zhipu-coding-plan/glm-5.3-flash`（用户 omp 既有配置，默认 yolo 无审批弹窗）。证据目录：`docs/test-reports/evidence-gui-20261001/`。

## 范围与切入点

- 上轮（2026-09-26）Web 走查遗留的「辅助对话标签无法创建」桌面端复现与修复；
- 项目模式需求（omp-project-mode.md）中明确未闭环的 **Z04 并行会话审批/队列交叉** GUI 复验；
- 桌面专属面探索扫描（启动/恢复/侧栏一致性/会话删除链路）。

## 缺陷与修复（3 项确认缺陷，全部修复并原路径复测通过）

### 缺陷 1：辅助对话入口静默无反应（违反 Fork 显式反馈约束）

- **复现**：桌面 + Web 一致。打开会话 → 侧面板「辅助对话」→ 无任何可见反馈；console 仅 `[v4-pane] 创建框选副屏会话失败 {error: "fault.command.unsupportedByOmpCore"}`。证据：`e02-auxchat-toast.png`（修复后）、host 日志。
- **根因**：omp 适配层对 `createSelectionSideSession` 显式拒绝（FORK.md 已知差异族），但 UI catch 后仅 `logger.warn`，无用户可见反馈——违反 FORK.md「不可用能力入口必须禁用态 tooltip 或操作失败提示」。
- **修复**：`packages/ui/src/v4/SessionPane.tsx` 两个副屏创建函数（无参数入口 + `/side` 带提示词入口）失败路径补 `toast`：`unsupportedByOmpCore` → 「当前 Agent 核心不支持辅助对话。」；其他失败 → 「辅助对话创建失败：{error}」。`/side` 失败返回 blocked 保留草稿。新增双语词条 `chat.selections.sideUnsupported` / `sideCreateFailed`。FORK.md 已知差异 4 同步补入副屏会话。
- **复测**：原路径点击 → toast 明确呈现（`e03-auxchat-toast.png`）。

### 缺陷 2：预热草稿落盘残留，侧栏「New session」逐次累积

- **复现**：每次渲染器加载/应用启动，侧栏 forkZcode（及默认工作区）多一条「New session」；`~/.ompcode/v2/tasks-index.sqlite` 幽灵行同步累积；部分行点击后报 `session unavailable`（omp 事实源无对应会话）。本次测试期间累计 14 条。
- **根因**：`useDraftSessionPrewarm` 头注释契约要求「draft 纯内存不落盘、不进侧栏（上游 gateway `isDraftSession` 过滤）」；换核后 omp 项目模式 `create_session` **立即落盘会话文件**（722B 空会话），且 omp-agent 从未实现 `isDraftSession` 等价过滤（v4 sessions-index 扇出与 legacy `session/list` 两面都漏），冷扫描将其收入索引、宿主 task-index 落行。
- **修复**（三层）：
  1. 渲染器预热创建携带显式 `draftPrewarm` 标记（`packages/shared/src/zcode-protocol-v4/command.ts` additive 字段 + `useDraftSessionPrewarm.ts`）；
  2. omp-agent 项目模式对带标记的 createSession 明确拒绝（`fault.command.draftPrewarmUnsupportedByOmpCore`，`v4Commands.ts`），渲染器按既有「回落无预热路径」处理（首发现场创建，代价一次本地 RPC）；
  3. omp-agent 补齐上游等价过滤：`SessionIndexTopics.upsertEngineSummary` 与 `legacySessionList.ts` 跳过 draft 相位引擎。
- **复测**：干净构建重启后**零新增**幽灵行与会话文件；预热拒绝日志命中；`projectMode.e2e.test.ts` 新增「项目模式拒绝预热创建/旧拓扑照常接受」用例（红绿双向验证）；Z05 用例扩充「draft 不进 sessions-index / legacy list」断言。

### 缺陷 3：创建即发会话面板永久空白（修复缺陷 2 后暴露的潜伏竞态）

- **复现**：无预热路径下新建任务发送首条消息：会话创建、omp 回合真实完成（glm 回复在事实源 jsonl 中），但会话面板永久空白、输入器禁用；冷重载后依旧。证据：`e06-e10` 截图、探针日志。
- **根因**（探针链定位，`evidence-gui-20261001` 探针输出）：会话创建 ACK 后，宿主并发 `session/read` 在 `registry.createSession` 尚未登记引擎的空窗期触发 `resumeSession`；两个并发冷恢复（其一经项目分支、其二因项目进程可用性抖动走 legacy 分支）先后以 0 行冷引擎覆盖注册表，顶替正在运行回合的活引擎——面板订阅到空引擎。
- **修复**（`packages/omp-agent/src/app/sessionRegistry.ts`）：① `resumeSession` 先等待在途 `createSession` 登记（`settlePendingCreates` 串行屏障）；② 同 sessionId 并发冷加载按 `pendingResumes` 去重；③ 冷加载完成后再查注册表，已有更早登记的引擎（并发 create 或先完成的加载）一律返回已登记引擎、丢弃本次冷恢复结果（冷恢复引擎惰性挂载、无子进程，丢弃无副作用）。
- **复测**：带探针验证订阅命中活引擎（`rows=3 phase=running`→`completedSuccess`）；干净构建原路径复测「新建任务→首发送→回复全链路渲染」（`e12`、`e13-final-clean-build.png`）。

## Z04 复验（部分通过）

- 同会话流式中排队两条消息（B2→B3）：各行其位、互不串话、逐条收口（`02:45/02:55` 时间线核对）；跨会话不串话由 2026-09-30 Z08 GUI 验收覆盖。
- 审批交叉未复验：用户 omp 为默认 yolo，GUI 无审批卡（FORK.md 已知差异 10），审批路径由 omp-agent 协议 E2E 覆盖。**维持「Z04 部分完成」状态**。

## 门禁与验证

| 项                                                | 结果                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm typecheck`                                  | 通过（exit 0）                                               |
| `pnpm lint`                                       | 通过（0 warnings 0 errors，2835 files）                      |
| `pnpm fmt:check`                                  | 通过（3175 files）                                           |
| `pnpm --filter @zcode/omp-agent test`             | 140/140 通过（含真实内嵌核 E2E、新增预热拒绝用例、扩充 Z05） |
| `packages/ui` 相关 UT（slashCommandComposing 等） | 通过（2/2，包目录内运行）                                    |
| GUI 原路径复测                                    | 缺陷 1/2/3 全部通过（见各节证据）                            |

## 未验证 / 遗留

1. **遗留垃圾数据——已清理（2026-10-02）**：缺陷 2 修复前累积的 15 条「New session」空任务行与 8 个空 omp 会话文件（722B、无任何 message 行，逐个校验后删除；1 个无索引行的孤儿文件一并清除）。删除前全量备份至 `evidence-gui-20261001/phantom-backup/`（行清单 JSON + 全部文件副本，可回滚）；清理后重启桌面验证：侧栏零幽灵行、sqlite 零行、FILE 类未复活（`e14-after-cleanup.png`），omp 目录仅剩真实历史会话。
2. `/side` 斜杠提交路径：失败处理代码与已验证入口相同（同一 catch/toast），但 GUI 提交本身受合成键盘输入限制未能触发（发送按钮态未同步），记为部分验证。
3. 手机远控、CentOS 7、正式安装包形态：不在本轮范围（见 windows-acceptance.md 既有未验证清单）。
4. 缺陷 3 修复后，`resumeSession` 对「创建中会话」的读请求会等待至多一次 create RPC（数百毫秒），无功能影响；未做性能专项测量。

## 修改文件清单

- `packages/ui/src/v4/SessionPane.tsx`（副屏失败 toast ×2）
- `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`（draftPrewarm 标记 + 注释更新）
- `packages/ui/src/i18n/locales/zh-CN.ts`、`en-US.ts`（新词条 ×2）
- `packages/shared/src/zcode-protocol-v4/command.ts`（createSession payload `draftPrewarm` additive 字段）
- `packages/omp-agent/src/app/v4Commands.ts`(项目模式拒绝预热创建)
- `packages/omp-agent/src/app/sessionIndexTopics.ts`、`legacySessionList.ts`（draft 相位过滤）
- `packages/omp-agent/src/app/sessionRegistry.ts`(resume 并发去重 + 在途 create 串行屏障 + 不覆盖已登记引擎)
- `packages/omp-agent/test/projectMode.e2e.test.ts`（新增预热拒绝用例；Z05 扩充）
- `packages/omp-agent/test/sessionRegistry.identity.test.ts`（夹具补真实相位）
- `docs/requirements/FORK.md`（已知差异 4 补副屏会话）、`docs/requirements/omp-project-mode.md`(草稿预热禁用规则 + 实现状态)
