# 单分支重构任务分配指南（给调度 Agent）

> 配套 [refactor-plan.md](refactor-plan.md) 使用。**你是调度者，不是实现者**：按本指南机械执行，不要自行发挥顺序或范围。每一步都是「做 → 查 → 过/停」：检查不符合预期就停下向用户报告，不要猜、不要绕。

## 0. 角色与红线

你只做五件事：读文档、派发任务卡给子代理、检查子代理交付、按固定顺序集成、如实汇报。业务代码全部由子代理写。

红线（违反任何一条立即停止并报告用户）：

1. 需求权威是 `docs/requirements/`；代码与需求冲突时，先向用户确认并更新文档，再改代码。
2. 子代理只能改 `refactor-plan.md`「文件所有权」分给它的文件；`pnpm-lock.yaml` 与 `packages/desktop/package.json` 任何人不得手改，由你在集成时用 `pnpm install` 再生。
3. 子分支（`refactor/w*`）**不 push 到 origin**；集成分支 `refactor/unify-centos7` 仅在 C1 金丝雀或 WSL 测试需要时由**你**push 到 origin（workflow dispatch 和 jch-wsl-git-test 都要求远端可见），P3 合回 main 后再删；**绝不删除 `experiment/centos7-no-proot`**（P3 且 P2 全绿后由收尾卡执行）。
4. 子代理交付必须附真实验证输出（typecheck / lint / UT 的实际命令与结果）；没有验证输出的交付一律打回，视为未完成。
5. 未执行的事项一律写「未验证」；禁止「应该可以」「大概率没问题」这类表述。
6. 修改 `.github/workflows/` 之前，必须已经完成 C1 金丝雀的 CentOS 7 VM 验证（计划硬性时序）。
7. 单个子代理同一问题失败 3 次 → 停下报告，不要换着花样无限重试。

## 1. 开工准备（一次性，任何一步失败就停）

1. `git pull`，确认 HEAD 不低于 `9d0c94e`。
2. 按序通读：`AGENTS.md` → `docs/refactor-plan.md`（重点：分工总览、文件所有权、各工作流任务明细、P2 门禁）→ `docs/requirements/README.md` 索引。
3. 环境就绪：按 `mise.toml` 准备 Node 24.14.0 与 pnpm 10.33.2，根目录 `pnpm install`，运行 `node scripts/check-workspace-freshness.mjs`。
4. 向用户发一次开工汇报（当前基线 commit、环境检查结果、即将派发 P0）。

## 2. 固定执行序列（不得改变顺序）

| 步骤 | 内容                  | 并行度                        | 何时算完                                                                                           |
| ---- | --------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| D1   | P0 集成主干           | 1 个子代理，串行先行          | 集成分支 `refactor/unify-centos7` 推送后 `pnpm typecheck` 通过                                     |
| D2   | 派发 W1–W6 六张任务卡 | 6 个子代理同时（加你共 7 路） | 六个流各自交付且你逐个验收通过                                                                     |
| D3   | 集成                  | 你亲自做                      | 按 W2→W3→W4→W5→W1→W6 逐个合入，每次合入后 typecheck+lint 绿                                        |
| D4   | C1 金丝雀             | W1 子代理续做                 | 集成分支产出 CentOS 7 包并通过 VM 初验（需要时由你把集成分支 push 到 origin 供 workflow dispatch） |
| D5   | P2 验证               | 1 个验证子代理 + 你盯门禁     | P2 门禁 7 条全绿 + 验收文档落盘                                                                    |
| D6   | P3 收尾               | 1 个收尾子代理                | 合回 main、删专有分支、双平台金丝雀、状态更新                                                      |

## 3. 任务卡（复制给子代理，不要改写内容）

每张卡独立自足。派发时原样复制整段。

### 卡 P0（集成主干）

```text
【角色】OmpCode 单分支重构的 P0 集成者。仓库 D:\code1111111111\forkZcode（Windows/Git Bash）。
【先读】AGENTS.md、docs/refactor-plan.md 的「P0 集成主干」与「文件所有权」、docs/requirements/ 全部文档。
【任务】
1. git merge --no-ff experiment/centos7-no-proot 进 main 之上的新分支 refactor/unify-centos7。
2. 解决 13 个冲突文件，裁决依据=docs/requirements/ 现行文档；manifest 冲突取 main 侧（electron 44.4.5、
   undici ^8、@types/node-forge 保留）；代码冲突允许先取一侧并留 TODO 注释给对应 W 流。
3. 产出要求：pnpm typecheck 通过（lint 警告可留给各 W 流）。
4. 过程中把每个冲突文件的裁决理由记成一页 docs/test-reports/p0-conflict-log.md。
【禁止】不 push、不删分支、不改 .github/workflows、不手改 pnpm-lock.yaml。
【汇报】合并提交 hash、13 个文件的裁决摘要、typecheck 实际输出、遗留 TODO 清单。
```

### 卡 W2（双运行时兼容，最先派发）

```text
【角色】W2 双运行时兼容。基线：refactor/unify-centos7；子分支 refactor/w2-runtime；独立 worktree。
【先读】docs/refactor-plan.md「W2」、docs/requirements/centos7-release.md（Electron 选型与 sqlite 双驱动段）。
【只许改】packages/desktop/src/main/chromeCookieManager.ts、packages/services/src/session/*Repo.ts、
packages/services/src/session/tasksDatabase/**、新建 sqlite/undici 封装模块及其测试。
【任务】
1. sqlite 单入口封装：按运行时选 node:sqlite（Electron 44/Node 22）或 better-sqlite3 9.6.0（Electron 28/
   Node 18.18）；先实测 better-sqlite3 9.6.0 能否同时编译两个 ABI，能则单一驱动。四个使用点全部改造，
   两平台数据行为等价，内存库 UT 覆盖行为一致与故障路径。
2. Electron 44↔28 API 差异审计：主进程（webUtils/navigationHistory/fs glob 等分支回退仍成立；main 新增
   代码补回退）+ renderer（Chromium 120 vs 44 的 CSS/JS 兼容扫描），产出差异清单文件。
【完成判据】UT 通过 + pnpm typecheck 通过 + pnpm lint 0 error。
【禁止】不改他人文件、不手改 lockfile、不 push。
【汇报】改动清单、双 ABI 实测结论、UT/typecheck/lint 实际输出、差异清单路径。
```

### 卡 W3（桌面 Main/Host）

```text
【角色】W3 桌面 Main/Host。基线 refactor/unify-centos7；子分支 refactor/w3-main-host；独立 worktree。
【先读】docs/refactor-plan.md「W3」、docs/requirements/centos7-release.md（离线锁定激活链与门控面）、
mobile-relay.md（平台与离线边界）、centos7-performance.md（日志）。
【只许改】packages/desktop/src/main/index.ts、logger.ts、mainLogWriter*、desktopHostProcess.ts、
preload/**、packages/shared/**（新增门控状态接口，只你所有）、scripts/publish/centos7/**（含 UT）。
【任务】
1. 启动器：OMPCODE_CENTOS7_LOCAL_ONLY=1 仅在传 --offline 时设置（现在是常开，要改），--offline 同时
   透传内嵌 omp；--help 文案同步；UT 覆盖参数矩阵。
2. 离线门控面 8 项逐项落地：手机远控 relay、公网更新、公网配置/帮助/社区/反馈、账号/分享、外部浏览器
   拉起、遥测与启动/日活调度、Host 在线 bot、推荐提示词本地化——LOCAL_ONLY=1 时后端全部关闭。
3. packages/shared 定义唯一门控状态接口供 renderer 消费（W4 做禁用态）。
4. relay 门控测试：UT（不监听、握手拒绝、入口状态）+ 本机 WebSocket 探测 E2E。
5. logger 收敛为单一有界异步队列（时间/容量上限显式常量并配测试，参考 25ms/4MiB），保留 LOCAL_ONLY
   下 error-only 过滤与退出 1 秒排空；删除分支 mainLogWriter 重复路径及测试，语义并入 mainLoggerAsync。
6. Host 管道容错（EBADF/EPIPE）保留并补 UT。官方云远控入口的进程侧移除。
【完成判据】UT+E2E 通过 + pnpm typecheck + pnpm lint 0 error。
【禁止】不动 packages/ui、不动 workflow、不 push。
【汇报】改动清单、门控面逐项对照表、测试实际输出。
```

### 卡 W4（UI 统一）

```text
【角色】W4 UI 统一。基线 refactor/unify-centos7；子分支 refactor/w4-ui；独立 worktree。
【先读】docs/refactor-plan.md「W4」、docs/requirements/ 的 FORK.md（界面统一条）、composer.md、skills.md、
integrations.md（浏览器/钩子段）、mobile-relay.md。
【只许改】packages/ui/src/**。
【任务】
1. WorkspaceSidebarFooter：恢复完整入口（内嵌手机远控 trigger），采纳 Monitor 图标；移除上游官方云远控
   入口（两平台统一，替代关系）。
2. locales 取两侧并集；压缩/自动压缩控件在工具栏与输入框下方全部隐藏（/compact 命令保留）。
3. PluginsSection/SkillsSection 合并：技能/钩子/浏览器页纯 omp 事实源；无工作区显示空态不冒充。
4. lib/centos7Desktop.ts 白名单机制：标记只允许出现在枚举的封装模块内，配扫描测试强制。
5. 消费 W3 的门控状态接口：被关功能入口一律禁用态 + 「离线锁定中已关闭」说明。
【完成判据】相关 UT 通过 + pnpm typecheck + pnpm lint 0 error。
【禁止】不动 desktop/shared/services、不 push。
【汇报】改动清单、UI 对照说明、测试实际输出。
```

### 卡 W5（会话/协议核验）

```text
【角色】W5 会话/协议核验。基线 refactor/unify-centos7；子分支 refactor/w5-session；独立 worktree。
【先读】docs/refactor-plan.md「W5」、docs/requirements/session-recovery.md、performance.md、skills.md。
【只许改】packages/omp-agent/**、packages/services/**（除 *Repo.ts 与 tasksDatabase/）、相关 test/。
【任务】
1. 逐文件审查 merge 自动合并结果（对照 experiment/centos7-no-proot 分支 32 提交），重点：会话级并发与
   背压（main 3776734）× 分支 host 日志流/技能目录改动的叠加；输出审查清单文件。
2. 运行并修复 pnpm --filter @zcode/omp-agent test 全量；补分支新行为 UT 缺口（IBus 启动器逻辑、
   profile/offline 转发、--home 链接语义纯逻辑部分）。
【完成判据】UT 全绿 + pnpm typecheck + pnpm lint 0 error。
【禁止】不动他人文件、不 push。
【汇报】审查清单路径、UT 实际输出、缺口清单。
```

### 卡 W1（构建双轨，随 D2 一起派发但分两段交付）

```text
【角色】W1 构建双轨。基线 refactor/unify-centos7；子分支 refactor/w1-build。
【先读】docs/refactor-plan.md「W1」与 C1 阶段、docs/requirements/centos7-release.md（Electron 选型、
发布 workflow 条目）。
【只许改】scripts/prepare-centos7-build.mjs（新建）、.github/workflows/**、vite 配置的 define 注入点。
【任务（第一段，先交付）】
1. 新建幂等切换脚本 scripts/prepare-centos7-build.mjs：electron→精确 28.3.3，运行时依赖→Node 18 兼容
   精确版清单（undici 6.23.0、better-sqlite3 9.6.0，其余从分支 lockfile 提取），注入
   __OMPCODE_CENTOS7_DESKTOP__ 构建标记；脚本不得回传改写仓库文件。
2. 本地验证：跑切换脚本后 pnpm --filter @zcode/desktop exec electron-builder --linux --x64 --dir 出
   28.3.3 目录构建；不切换时 Windows 构建零变化。
【任务（第二段，C1 金丝雀 VM 验证通过后才落地）】
3. release-centos7.yml：preflight 过渡期接受 refs/heads/main 与 refs/heads/refactor/unify-centos7，
   desktop/native job 在 install 前跑切换脚本并改 --no-frozen-lockfile；其余步骤保持。收窄为仅 main
   留给 P3。
【完成判据】第一段：本地构建验证通过 + typecheck/lint 绿；第二段：C1 通过后落地。
【禁止】第二段未获 C1 通过确认前，不改 workflow 文件；不 push。
【汇报】脚本说明、两段交付与验证输出。
```

### 卡 W6（文档与验收矩阵）

```text
【角色】W6 文档与验收。基线 refactor/unify-centos7；子分支 refactor/w6-docs。
【先读】docs/refactor-plan.md「W6」、docs/requirements/README.md。
【只许改】docs/**（不含 test-reports 下他人产出）、AGENTS.md。
【任务】
1. 清理 docs/specs/ 已迁移的分支 spec 与过时引用；需求索引与 AGENTS.md 一致性复核。
2. 产出验收矩阵：覆盖 docs/requirements/ 全部 10 份文档，每条需求→验证方式（UT/E2E/GUI/VM/人工）→
   负责工作流→状态列（未知为空，不预填通过）。
3. 起草两份验收文档骨架（docs/test-reports/）：windows-acceptance 与 centos7-acceptance，含场景清单
   （基本工具调用会话、子代理分配、界面与 omp 数据一致性）与证据栏。
【完成判据】矩阵与骨架落盘、文档间无断链。
【禁止】不填「通过」，验收状态只能来自 P2 实际执行；不 push。
【汇报】矩阵路径、清理清单。
```

### 卡 P2（验证官，D3 集成完成后派发）

```text
【角色】P2 验证官。对象：refactor/unify-centos7 集成结果。严格按 docs/refactor-plan.md「P2 集成验证门禁」
7 条逐项执行并记录证据。要点：
1. 静态门禁：freshness/typecheck/lint/fmt/architecture。
2. UT：omp-agent 全量；real-omp.e2e 必须实际执行，环境缺失即不绿并如实记录。
3. Windows 真实界面验收：pnpm dev:desktop 起真实桌面，经真实界面操作完成 a) 基本工具调用会话（新建→
   工具调用展示与结果→实际文件变更→完成/中断）b) 子代理分配（状态与记录核对）c) 核心界面与 omp 数据
   一致性（会话列表、技能目录、模型目录与角色、上下文用量、子代理状态逐一对照 omp 事实源）。模型统一
   zhipu-coding-plan/glm-5.3-flash。
4. CentOS 7/Linux 侧：用 jch-wsl-git-test 技能（需要用户确认 WSL2 发行版名），运行同一组核心场景。
5. VM 终验按 centos7-release.md「Package acceptance」。
6. 产出验收文档（每平台一份 docs/test-reports/，逐场景记操作、证据、结果、未验证范围）。
7. IBus 公司主机验收单独记录。
【红线】任何一条不绿→整体不绿，禁止进入 P3；不得降低标准或以跳过充当通过。
【汇报】7 条门禁逐项结果 + 验收文档路径 + 未验证清单。
```

### 卡 P3（收尾，仅当 P2 全绿且用户确认后派发）

```text
【角色】P3 收尾。前置：P2 门禁全绿且用户明确确认。
【任务】按 docs/refactor-plan.md「P3」执行：refactor/unify-centos7 合回 main 并 push；同批把 workflow
分支校验收窄为仅 refs/heads/main；发布一个 Windows EXE tag 与一个 CentOS 7 金丝雀 tag 验证两条流水线；
删除本地与远端 experiment/centos7-no-proot（保留既有 centos7 tag）；更新 docs/requirements/README.md
「实现与验证状态」；归档 refactor-plan.md。
【汇报】推送结果、删除结果、两条流水线 run 链接、最终状态。
```

## 4. 你亲自做的集成动作（D3）

1. 依次 merge 子分支：W2 → W3 → W4 → W5 → W1（第一段）→ W6。
2. 每合入一个：跑 `pnpm typecheck` 与 `pnpm lint`，红了就把错误贴回该子代理修复，绿了才合下一个。
3. 全部合入后：`pnpm install` 再生 lockfile，再跑一遍 typecheck + lint + `pnpm --filter @zcode/omp-agent test`。
4. 子分支间的合并冲突：把冲突文件与两侧意图贴给相关子代理裁决，你不自行猜测业务语义。

## 5. 常见情况处理

| 情况                                  | 动作                                           |
| ------------------------------------- | ---------------------------------------------- |
| 子代理说完成但没贴验证输出            | 打回：「附 typecheck/lint/UT 实际输出」        |
| 冲突裁决不清楚、文档没写              | 停下问用户，附两侧代码与相关需求段落           |
| better-sqlite3 9.6.0 双 ABI 失败      | 按卡内备选走运行时双驱动，不算阻塞             |
| CentOS 7 VM / frp / WSL 发行版不可用  | 该项记「未验证」，问用户是否继续，不得宣称验收 |
| 子代理同一问题失败 3 次               | 停下报告用户                                   |
| 有人试图改所有权外文件或手改 lockfile | 拒绝并重申红线                                 |
| P2 有条目不绿                         | 停在 P2，禁止进入 P3                           |

## 6. 汇报模板（每步结束后向用户发）

```text
【步骤】D1/D2/D3/D4/D5/D6
【已完成】逐项（对应任务卡条目）
【验证结果】命令 + 实际结果，区分：通过 / 失败 / 未验证
【阻塞】无，或具体描述 + 需要用户决定的问题
【下一步】即将执行的步骤
```
