# 性能优化与草稿修复交接（2026-10-09）

> 本文原有“当前状态/尚未完成”是历史停止时点记录；续作状态以末尾「核心体验续作」及性能报告为准，不把历史缺口当作当前结论。

## 停止状态

用户要求「输出交接文档，停止工作」。已中断输入实施、GUI 验收和输入复核三个代理，不再继续修改产品、运行测试或调用模型。

仓库：`D:/code1111111111/forkZcode`；当前分支：`main`；HEAD：`ac6cbd1`。输出本文前工作树干净，本文是停止时新增的未提交交接文件。未 push。

**任务部分完成，不能宣称所有问题修复或草稿功能最终验收完成。** 已完成的性能实现和阶段修复均已提交；下面的草稿组合场景及真实界面复验仍未收敛。

## 提交与合并

| 提交      | 内容                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `61fce8e` | 性能与草稿阶段提交，84 个文件，新增 6,726 行、删除 849 行，包含代码、测试、需求、报告及格式修正，不全是业务代码。 |
| `7e2218a` | 原生命令分支最后一次冷恢复一致性修复；该分支还包含 `227ca3b` 原生命令接入及其合并历史。                           |
| `ac6cbd1` | 将整个 `codex/omp-rpc-ui-core-commands` 分支合入当前 `main`，不是仅 cherry-pick `7e2218a`。                       |

合并解决了三处冲突：

- `packages/desktop/src/host/index.ts`：保留当前 Host 的 debug 日志出口及其他级别路由。
- `packages/omp-agent/src/domain/ompProjector.ts`：接纳原生命令分支的 `activateQueuedTurn(..., true)`。
- `packages/omp-agent/test/coldStoreProjection.test.ts`：保留宿主绝对 home 断言和新增 team-dispatch/skill-prompt 冷恢复回归；去掉自动合并产生的重复变量声明。

`useDraftConfigControl.ts` 和 `composerDraftStore.ts` 已自动合入原生命令模型回投字段与 `applyOmpComposerModelSync`。后续草稿修复须保留它们，不恢复旧 `/plan` 等本地截获逻辑。

## 工作树删除结果

原工作树：`C:/Users/jiang/.codex/worktrees/ebfe/forkZcode`。

删除前确认无未提交内容，且 `7e2218a` 已成为当前 HEAD 的祖先。`git worktree remove` 成功，登记已从 `git worktree list` 消失；分支保留。

**物理目录仍存在，剩下 packages 中的依赖链接和缓存。** 后续两次清理均被自动审批拒绝，工具只返回 `blocked by policy`，未提供更具体原因。未绕过拒绝，也未删除其他工作树。不能把物理目录完全删除记为完成。

其他工作树 `latest-dependencies`、`latest-deps-linux`、`release-build` 均未改动。

## 已实施的性能范围

分享功能已经在此前基线删除。本任务实施原计划第 2—4 阶段：

- 正文、富 JSON 和配置共用草稿调度，350ms 合批、连续输入最大等待 2 秒；边界 flush。
- 输入正文局部化、Composer 窄 snapshot 投影及稳定回调；提交仍读取最新路由、队列和配置。
- 文件服务实例拥有统一索引、规则缓存与在途扫描；每轮无命中只补扫一次。
- 时间线计时不扫描历史，结构稳定的流更新复用未变化轮次。
- 投影工具 ID 索引，普通工具更新不复制和查找全部历史。
- 折叠思考从尾部提取摘要；流式代码移除全文哈希和内容 React key。

审查后已经修复文件规则 fallback 被永久缓存、raw 清空轮次被迟到 RPC/deferred 吞掉的回归。

草稿已经接入同 renderer 的共享 owner/reader 租约、提交 receipt、原子 Storage 迁移。Host rekey 同事务保存 `meta_json.taskIdMigration`，通过现有 workspace 事件及任务列表元信息提供权威临时 ID→UUID 关系，普通快照不能伪造或清除关系。

## 尚未完成的工作

| 项目                                | 当前证据与下一步                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 富 JSON 跨 pane 交接                | `readComposerDraft`/跨 pane 内容投影的恢复边界须获取最新富结构；新 pane 不能只拿 Markdown 或旧 JSON，再把旧结构写成最新值。避免逐按键序列化完整 JSON。尚需真实双 hook/Lexical 回归。                                           |
| 同 scope 等待回包时另一 pane 新编辑 | receipt 已新增 `hasNewerEdits()` 并接入成功清空守卫，但尚未通过真实双 pane pending 成功/失败验证。须保留另一 pane 的正文、富 JSON、附件和 pending 归属。                                                                       |
| 目标只改配置的迁移冲突              | `hasUserEdits` 与显式模型/思考意图需要区分初始化配置；目标空正文但用户已经改选时，迁移不能把目标选择退回来源。须与新合入的 `ompModelEdited`/`ompThoughtEdited` 及 OMP 模型回投协同。                                           |
| 来源失败恢复                        | receipt 接线已落盘；A 提交→离开 A→失败→返回 A，以及 A→B→A 后新编辑保护，尚未完成真实 hook GUI 复验。                                                                                                                           |
| 首次临时 ID→UUID 恢复               | Host/shared/SQLite 单测已通过，窗口级 live 与冷元信息入口已经接线；首次真实创建、UUID 切回和冷启动仍未通过本轮产品 GUI 复验。不能仅靠稳定 UUID 场景替代。                                                                      |
| 窗口级迁移入口                      | 根代理新增 `useComposerDraftMigrationEvents.tsx`，正确订阅 `zcodeTaskService.onDynamicWorkspaceEvent`；query cache 在接纳后只发布有 migration 的元信息，绑定时读一次已有缓存，无额外 RPC。尚缺入口级自动化验证和独立最终复核。 |
| 完整代码验收                        | 80 行逐行比较及冷恢复同数组断言已加入脚本，尚未执行本轮真实模型 GUI；此前首尾/完成标记不能当全文通过。                                                                                                                         |
| 合并后整体验证                      | 合并后静态检查与 48 项定向核心测试通过，但尚未重跑合并后的全部核心/性能 GUI，desktop 与 adapter 构建产物仍是合并前的版本，须重建后再启动验收。                                                                                 |

owner 复核期间已修正的最小反例包括：迁移时未完成 receipt 保活、目标胜出时来源备份、pending 期间来源新编辑保护、跨 owner 配置 revision 通知、lease cleanup/setup 重登记、Storage 失败保留来源。复核代理运行的 6 项隔离反例通过，但这些不能替代持久 UT 和真实 hook 验收。

## 验证结果与适用版本

固定 Node 24.14.0、pnpm 10.33.2。

| 范围                      | 真实结果                                                                   | 时点/边界                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OMP 全套                  | 279/279 通过，0 跳过；含三个真实核心 E2E                                   | 原生命令分支合入前；不能写成合并后全套通过。                                                                         |
| UI 四文件                 | 24/24 通过，0 跳过                                                         | 阶段提交前；新共享 hook/迁移组合场景未完整覆盖。                                                                     |
| 文件索引/轮次             | 21/21 通过，0 跳过                                                         | 包含真实临时目录、两种 fallback×三种恢复入口和 raw/deferred 竞态。                                                   |
| shared/SQLite/rekey/event | 12/12 通过，0 跳过                                                         | 包含失败、重复、晚订阅、冷重开、代际、identity、快照伪造。                                                           |
| SQLite 补充               | 11 通过、6 跳过、0 失败                                                    | 当前 Node 的 better-sqlite3 原生模块不可用；不是 CentOS 7 后端验收。                                                 |
| visual 组件 GUI           | 通过                                                                       | 产品 DiffsWorkerPoolProvider 的实际 token 与深浅主题颜色；真实 provider hook 的 raw/deferred 行为，服务为受控 port。 |
| 合并定向核心              | 48/48 通过，0 跳过                                                         | coldStoreProjection、ompCommandOutputHistory、ompNativeCommandProjection、sessionRegistryAliases。                   |
| 全量静态检查              | typecheck、lint、fmt:check、changed architecture 通过；架构 baseline/new=0 | 合并状态及其格式修正后；合并中 10 个新证据/报告文件仅做格式化。                                                      |

此前稳定 UUID 产品 GUI、草稿正常关闭/冷恢复、原有组件失败路径的历史结果保留在性能报告中；它们不替代上述新缺口。

未验收：目标 CentOS 7 网络盘环境、原生 IME、真实 Web 产品 GUI和新组合边界。不得把本地探针耗时、模拟服务或静态检查写成目标性能/完整功能验收。

## 续作定位与执行前提

生产代码主入口：

- `packages/ui/src/v4/composer/{composerDraftOwner,composerDraftRegistry,composerDraftStore,useDraftConfigControl}.ts`
- `packages/ui/src/v4/ConversationComposer.tsx`、`SessionPane.tsx`、`LexicalChatInput.tsx`
- `packages/ui/src/hooks/useComposerDraftMigrationEvents.tsx`
- `packages/ui/src/store/{taskQueryCacheStore,taskQueryMetaMigrationEvents}.ts`
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts`、`packages/services/src/session/taskIndexRepo.ts`
- `packages/shared/src/{task-id-migration,validation,task-realtime-core,zcode-task-types-core}.ts`

GUI 测试已包含真实 hook fixture 与断言：`packages/desktop/test/ompPerformanceHotPaths.{draftHookFixture.jsx,draftHookAssertions.mjs,components.e2e.mjs,gui.e2e.mjs,mentions.e2e.mjs}`。fixture/断言需要按最终产品 API 再核对，不能只看脚本存在。

恢复时先读当前 `AGENTS.md`、architecture-governance、`DESIGN.md` 及需求权威；先收敛上述组合反例及 UT，再运行新 hook GUI，最后 fresh live/stable/cold/mentions 及合并后的核心全集。实际命令与隔离参数以当前 `AGENTS.md` 为准。

运行时：`C:/Users/jiang/AppData/Local/Temp/ompcode-node-24.14.0/node.exe`。系统默认 Node 是 24.20.0，需显式使用固定版本。

经核验的 OMP：`packages/desktop/.omp-release-cache/v18.8.4+fork.304/omp-windows-x64.exe`，SHA256 `7ab71c738968279788c179e78ea9778f9eee4a0b40ca215e706decc82d15f7fd`；测试用 `OMP_RPC_BINARY_PATH` 指向此文件。

完整 `prepare:agent-bundle` 曾因其他进程占用 bundled omp.exe 返回 EBUSY，不能关闭用户进程来覆盖。可以重建 desktop tsup、执行 `packages/omp-agent/scripts/bundle.mjs`，再调用现有 `stageAgentBundle` 仅暂存 JS bundle。合并后尚未重建。

隔离 GUI 使用新数据根与专用端口，不连接日常实例；启动前避免外部 `OMP_CONFIG_ROOT` 将测试导向用户数据。模型使用既有 `zhipu-coding-plan/glm-5.3-flash`，不改用户模型角色、凭据或配置。真实原生命令五项 E2E 为显式 opt-in：`OMP_NATIVE_E2E=1`；未启用的跳过不能算通过。

证据与报告：

- `docs/test-reports/performance-hot-paths-2026-10-09.md`：首轮、修复复验及阶段提交边界。
- `%TEMP%/ompcode-hotpaths-20261008-1540/evidence`：首轮 GUI、稳定/冷恢复及首次失败。
- `%TEMP%/ompcode-hotpaths-20261009-allfixes/evidence/components-visual-result.json`：本轮实际高亮/主题/provider 通过结果。
- `%TEMP%/ompcode-performance-validation-20261009/core-final.log`：合并前核心 279/279。
- `docs/test-reports/omp-native-commands-2026-10-08.md` 及其 evidence 目录：被合入分支的验收历史，不当作此次合并后的新测试。

## 代理交接

- `composer_input`：输入 owner、receipt、Composer/Lexical 接线与 UT；已中断。
- `gui_acceptance`：性能 GUI fixture、真实 hook 和隔离桌面验收；已中断。
- `review_input_drafts`：独立只读输入复核与组合反例；已中断。
- `file_index`、`review_indexes_contracts`：实现与定向检查已完成、停止写入。

下一位编排者应以当前已提交源码与本文件的未完成表为起点；不要撤回已合入的原生命令能力，也不要把此阶段提交/合并视为所有问题已修复。

## 核心体验续作

原分支已完整合入，不再重复合并。共享最新 reader 富 JSON、目标显式配置合并、Lexical 非当前 pane 选区保护以及 legacy Zod 导入修复已落地；真实双 hook/组件通过，覆盖原交接中的 pending、附件引用、来源失败、A→B→A、配置-only、窗口事件和已有缓存晚绑定场景。

OMP 全集最新复验为 374/374、0 失败/跳过。desktop 与 adapter 已重建；最终真实模型 live/stable、R7 正常退出后 cold、项目内 mentions 均通过，完整 80 行比较不再只看首尾或完成标记。mentions 的首个失败已确认为测试误建无项目任务，现走沙箱项目侧栏入口并通过原断言。

最终证据与适用边界见 [核心体验续作验收](performance-hot-paths-2026-10-09.md#核心体验续作验收)。用户已明确授权当前全部改动提交/推送、完整 slowtest 与 Windows/CentOS 7 正式发布；正式门禁及发布不由上述定向结果推断，实际结果记录于仓库外 `authorized-slowtest-*.log`。

原空工作树物理根目录仍报告 EBUSY；登记已移除，未关闭未知用户进程。目标 CentOS 7 网络盘、原生 IME/系统原生失焦、真实 Web GUI、真实附件上传仍保留各自验收边界，不降低要求。
