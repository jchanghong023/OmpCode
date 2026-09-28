# P0 合并冲突裁决日志

- 合并操作：在 `refactor/unify-centos7`（基于 main `9d0c94e`）执行 `git merge --no-ff experiment/centos7-no-proot`。
- 裁决权威：`docs/requirements/` 现行文档（main `43bf4fa` 固化的单分支平台需求）；执行计划为 `docs/refactor-plan.md`。
- 冲突共 13 个文件（6 文档 + 7 代码），与计划预测一致；另修正 1 处自动合并错误（见第 14 项）。

## 文档类（6 个）

| # | 文件 | 冲突类型 | 裁决 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `AGENTS.md` | UU | 取 main 侧 | main `43bf4fa`/`9d0c94e` 已按单分支决策改写开发规则；分支旧内容已迁入 `docs/requirements/`（计划 P0-2：文档以 requirements 现行版为准） |
| 2 | `FORK.md`（根目录） | UU | 取 main 侧 | 根目录 `FORK.md` 仅是跳转页，权威副本在 `docs/requirements/FORK.md`，无第二份权威（workspace AGENTS.md「项目定位与需求权威」） |
| 3 | `docs/requirements/composer.md` | UU | 取 main 侧 | requirements 现行版已含压缩全隐藏等新决策；分支旧稿按计划弃用 |
| 4 | `docs/requirements/models-and-commands.md` | UU | 取 main 侧 | 同上 |
| 5 | `docs/specs/centos7-release.md` | DU（main 已删、分支修改） | 维持删除（`git rm`） | 内容已迁入并改写为 `docs/requirements/centos7-release.md`；`docs/specs/` 旧路径按计划 W6 清理 |
| 6 | `docs/specs/omp-skill-parity.md` | DU（main 已删、分支修改） | 维持删除（`git rm`） | 内容已迁入 `docs/requirements/skills.md` |

## 代码类（7 个）

| # | 文件 | 裁决 | 依据与遗留 |
| --- | --- | --- | --- |
| 7 | `packages/desktop/src/main/logger.ts` | 取 main 侧三处冲突：常开有界异步队列（16MiB 容量上限）为唯一写盘路径；删除分支 `mainLogWriter` 依赖与仅 LOCAL_ONLY 启用的第二路径。保留 `flushMainLogs()`（退出排空，1 秒共享预算）改为排空 main 队列 | centos7-performance.md「该异步路径为唯一写盘路径，Windows 构建同样受益；不为单一平台维护第二条同步写盘路径」；计划 W3-4。**遗留 TODO（W3）**：合批时间窗常量未显式定义（现为 microtask 合批）、容量参考值 25ms/4MiB 对照、`mainLogWriter` 语义并入 mainLoggerAsync 测试、LOCAL_ONLY error-only 过滤补 UT |
| 8 | `packages/desktop/src/main/index.ts` | 退出排空取分支侧 `await flushMainLogs()` | 分支语义带共享退出预算，符合 centos7-performance.md 退出排空要求；`flushMainLogs` 已在 logger.ts 保留 |
| 9 | `packages/ui/src/WorkspaceSidebarFooter.tsx` | 仅保留 `WorkspaceMobileRelayTrigger`（内嵌手机远控入口）；移除 `WorkspaceWebRemoteControlTrigger`（上游官方云远控）与 `WorkspaceSidebarFooterUsageSummaryContent`（账号/用量 footer）引用 | FORK.md「上游官方云远控入口两平台统一移除，内嵌 relay 替代」；models-and-commands.md「侧栏账号/套餐/用量 footer 全部移除」；计划 W4-1。两被删文件已不存在，引用必须移除 |
| 10 | `packages/ui/src/i18n/locales/en-US.ts` | 技能页描述取 main 文案（omp 命令目录语义）；删除 `locallyManaged`（main 已按 skills.md 移除本地管理）；并集加入分支新增 `settings.skills.ompEmpty` | skills.md「设置→技能只展示 omp 可执行目录」；计划 W4-2「locales 取两侧并集」 |
| 11 | `packages/ui/src/i18n/locales/zh-CN.ts` | 同 en-US | 同上 |
| 12 | `packages/ui/src/settings/PluginsSection.tsx` | 取分支侧 `skillTarget.*` props（去掉 base 的 `scopeFilter`） | 合并结果的渲染守卫已是分支引入的 `skillTarget`（skills 专用 target），props 须一致；两侧都已删除 scopeFilter prop，与 main 侧 `SkillsSection` 新签名匹配 |
| 13 | `packages/ui/src/settings/SkillsSection.tsx` | 5 处冲突全部取 main 侧（`OmpSkillsCatalogView` 纯 omp 事实源形态），并把分支 GUI E2E 依赖的选择器并入：section `data-testid` 改为 `omp-available-skills`、行级加 `data-omp-skill-name={skill.name}` | skills.md 纯 omp 事实源；main 侧 UT `packages/ui/test/ompSkillsSettings.test.tsx` 依赖 `OmpSkillsCatalogView` 导出；分支 GUI E2E `packages/desktop/test/ompSkills.gui.e2e.mjs` 依赖 `omp-available-skills`/`data-omp-skill-name` 选择器——两侧测试均被合并带入，解析同时满足 |

## 自动合并修正（非字面冲突）

| # | 文件 | 问题与修正 |
| --- | --- | --- |
| 14 | `packages/desktop/package.json` | git 自动合并把 `electron` 错取为分支 `28.3.3`、`undici` 错取为 `6.23.0`。按计划 P0-3「manifest 冲突取 main 侧」修正回 `electron: 44.4.5`、`undici: ^8.11.2`；保留分支新增 `better-sqlite3: 9.6.0`（合并进来的 `packages/services/src/session/tasksDatabase/sqlite.ts` 双运行时封装按运行时条件加载它，Windows 走 `node:sqlite` 不受影响）。**遗留 TODO（W1/W2）**：28.3.3 钉死由 W1 切换脚本承担；better-sqlite3 双 ABI 结论由 W2 实测 |

## 移除的分支文件

- `packages/desktop/src/main/mainLogWriter.ts`、`packages/desktop/test/mainLogWriter.test.ts`：logger 收敛后无引用，按计划 W3-4 删除（语义并入 main 异步队列测试由 W3 落实）。

## 遗留 TODO 清单（移交对应工作流）

1. **W3**：logger 合批时间窗/容量上限显式常量化并配测试（参考 25ms/4MiB）；`flushMainLogs` 排空语义对齐分支 mainLogWriter 测试用例；LOCAL_ONLY error-only 过滤 UT。
2. **W4**：`WorkspaceSidebarFooter` 中 `workspacePath`/`workspaceIdentity` props 可能已无消费方（入口改 relay-only），按需收窄签名；locale 未使用 key（技能本地管理族）清理。
3. **W1**：`scripts/prepare-centos7-build.mjs` 切换 electron→28.3.3、undici→6.23.0 并注入 `__OMPCODE_CENTOS7_DESKTOP__`。
4. **W2**：better-sqlite3 9.6.0 双 ABI（Electron 44 ↔ 28）实测；sqlite 封装四使用点行为等价 UT。
5. **W5**：omp-agent 与 services 的 auto-merge 结果逐文件审查。
6. **W6**：`docs/specs/` 中仍留存的分支迁移 spec（centos7-performance、omp-browser-settings、omp-native-hooks、sidebar-display-icon）与过时引用清理。
