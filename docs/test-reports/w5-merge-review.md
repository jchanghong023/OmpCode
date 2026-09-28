# W5 会话/协议核验——merge 结果逐文件审查清单

- 审查人：W5（refactor/w5-session worktree，基线 refactor/unify-centos7 @ 6640170）
- 对照：merge-base `5cc286a`；分支 `experiment/centos7-no-proot`（32 提交，tip `f33cd75`）；main 侧 `3776734`（会话级协议并发/背压）至 `9d0c94e`（含 `2bb01cf` Windows 冷历史/技能终态修复）
- 方法：`git diff <parent> 6640170 -- packages/omp-agent packages/services` 双向比对 + 逐文件源码审查；命令均可复现。

## 1. 总体结论

**合并结果 = 两侧改动的干净并集，唯一双改动文件 `cliMain.ts` 为正确合并；发现 1 处 auto-merge 错误（services `undici` 被取为分支 6.23.0 精确钉死，已修复回 `^8.11.2`）+ 1 处同类错误在本域外（server，需集成者处理）。会话并发 × 分支改动的语义叠加点逐项核实无回归，详见第 3 节。**

## 2. 逐文件审查结果

### 2.1 两侧都改过的文件（冲突/叠加面）

| 文件 | main 侧改动 | 分支侧改动 | 合并结果 |
| --- | --- | --- | --- |
| `packages/omp-agent/src/adapters/cliMain.ts` | 3776734：`onClosed(error)` 带错误日志与退出码 | 94c53d4：`OMPCODE_CENTOS7_OFFLINE`/`OMPCODE_CENTOS7_PROFILE` → omp `--offline`/`--profile` 透传 | 正确并集（两改动不相邻但同文件，逐行核实）。W5 顺带把参数装配抽为纯函数 `buildOmpExtraArgs` 供 UT（行为不变） |

### 2.2 分支侧改动（合并后与分支 tip 逐字节一致，`git diff f33cd75 6640170` 为空即证明；语义审查如下）

| 文件 | 分支提交 | 审查结论 |
| --- | --- | --- |
| `packages/omp-agent/scripts/bundle.mjs` | 1aa764a | `target: node18`：内嵌 adapter 由 Electron 28 的 Node 18 子进程执行，正确；Windows 基线不受影响（仅 CentOS 打包脚本使用） |
| `packages/services/src/bots/botsService.ts` | e5951e7 | `LOCAL_ONLY=1` 时工厂提前返回全 unavailable 桩：手动 RPC 也不能重新启用公网机器人，`disposeAll*` 保持 no-op。符合 FORK.md 离线门控 |
| `packages/services/src/node.ts` | c5d0ed4 | Off-Peak/动态工作流/分享在 `LOCAL_ONLY` 关闭；bots 启动轮询关闭。`LOCAL_ONLY` 为部署常量，进程生命周期内不变，无条件扩散可接受 |
| `packages/services/src/providers/api/nodeApiNetwork.ts` | c5d0ed4 | undici 直连绕过 globalThis.fetch 门控的口子已封；`isLoopbackUrl` 来自 `@zcode/shared`（合并后存在，typecheck 佐证） |
| `packages/services/src/file/fileService.ts` | 931abda | 默认/临时工作区落 `ZCODE_DESKTOP_HOME_DIR`；无覆盖时回退 `homedir()`，Windows 行为不变 |
| `packages/services/src/runtime-tools/runtimeCommandEnv.ts` | 931abda | 继承白名单加 `XDG_STATE_HOME`（IBus 状态目录）。属白名单追加，不恢复宽继承；已补 UT |
| `packages/services/src/setting/settingService.ts` | 931abda | `OMPCODE_CENTOS7_HOME` 强制覆盖 `dataBaseDir` 读取 + `updateDataBaseDir` 迁移守卫。守卫在 validate/copy 之前抛出，无副作用；已补 UT |
| `packages/services/src/system/systemService.ts` | 931abda | `info().homedir` 跟随 `ZCODE_DESKTOP_HOME_DIR`；SSH 等系统配置仍读原 HOME（该函数只做展示）。已补 UT |
| `packages/services/src/system/sshConfigAlias.ts` | 7be504d/1aa764a | Node 22 `fs.promises.glob` 的 Node 18 纯逻辑回退（分段 glob 编译）；特性检测 `nativeGlob` 优先。回退实现有界（readdir 逐层），已带 UT |

### 2.3 main 侧改动（分支未触碰，`git diff 9d0c94e 6640170` 对这些文件为空即证明未被合并破坏）

- `protocolServer.ts`（会话级串行分发 + post-response outbox + stdout 16MiB 有界背压）、`conversationEngine.ts`、`ompStore.ts`、`ompFrames.ts`、`deleteColdSession/deleteLoadedSession/legacySessionList/ompEngineProcess/ports/serverApp/sessionRegistry/topicPublisher/module/contract.example`：全部保持 main `9d0c94e` 原样，且有 3776734/2bb01cf 自带的回归 UT（protocolServerConcurrency、topicFlowControl、sessionDeletion、ompStore）在合并结果中全部通过。

### 2.4 发现的问题

| # | 严重度 | 文件 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | 高（已修复） | `packages/services/package.json` | auto-merge 把 `undici` 取为分支 `6.23.0` 精确钉死。按 refactor-plan「Windows manifest 按基线维护、6.23.0 由 W1 构建脚本切换」与 P0 冲突日志第 14 项（desktop 同类错误已修正），源码基线应为 `^8.11.2` | W5 已改回 `^8.11.2`（本文件属 W5 所有权）；lockfile 由集成者再生（lockfile 不入 W5 提交） |
| 2 | 高（域外，只记录） | `packages/server/package.json` | 同类错误：`undici` 亦被取为分支 `6.23.0`。packages/server 不在 W5 所有权内 | **移交集成者/W1**：按同一裁决改回 `^8.11.2`，否则 Windows 远程 server 基线漂移 |
| 3 | 信息（核实非问题） | `packages/services/package.json` `better-sqlite3: 9.6.0` | 分支新增依赖在 Windows 基线是否合法 | 合法：`tasksDatabase/sqlite.ts`（W2）经 `createRequire` 按运行时条件加载，Windows 走 `node:sqlite`；P0 日志第 14 项同款裁决 |
| 4 | 信息（核实非问题） | `cliMain.ts` profile 解析 | `OMPCODE_CENTOS7_PROFILE` 已设但 `OMP_PROFILE/PI_PROFILE` 缺失时会透传 `--profile default` | 载荷不变式：desktop main 启动时先把 `OMPCODE_CENTOS7_PROFILE` 复制到 `OMP_PROFILE`（desktop/src/main/index.ts，W3 域，已核实在）。已用 UT 钉住该耦合 |
| 5 | 信息（核实非问题） | `ompStore.ts` `resolveOmpProfileFromEnv` 非法名抛错 | 理论上坏 profile 名会让 adapter 启动失败 | 入口均有校验：launcher argv 校验 + settings `ompProfileSchema` 写入校验；非合并回归 |

## 3. 叠加点专项（任务卡重点：3776734 会话级并发/背压 × 分支 host 日志流/技能目录/`--home`）

| 叠加点 | 审查结论 |
| --- | --- |
| 会话级并发 × 技能目录查询 | `skillsReferenceCatalog` 无 sessionId → 队列键 `workspace`，有 sessionId → `conversation/<sid>`；与订阅/会话命令的串行域一致。会话路径 `loadSkillCommands → ensureOmpStarted` 单飞（`ompStarting` promise）。目录进程 `workspaceConfig.ensureProcess` 的并发双建风险仅在「workspace 串行队列之外被调用」时成立——当前调用图全部经 workspace 键串行，记录为潜在不变式而非缺陷 |
| post-response outbox × 分支 `onCommandsUpdate` 推送 | `available_commands_update` 是 omp 进程事件上下文（非请求上下文），直写 `write()` 按生成序上线；请求上下文帧才进 outbox。两者不混序，workspace-config topic 帧区间单调性保持（topicFlowControl/protocolServerConcurrency UT 佐证） |
| stdout 16MiB 背压 × 分支 host 日志流容错（ab608b8，W3 域） | 互补：adapter 协议帧走 stdout（有界、饱和即显式关闭触发 Host 重连），adapter 日志仅走 stderr（`adapters/logger.ts`），Host 侧容忍日志流关闭不致断协议。adapter 侧无与分支冲突的改动 |
| `agent_end.messages` passthrough（2bb01cf）× 分支技能目录 GUI E2E | 互补：技能注入的 custom 字符串历史不再让终态帧被 schema 丢弃；分支 GUI E2E 依赖的技能执行收口（skills.md 验收 6）在该修复之上成立。分支侧无对冲改动 |
| `--home` 链接语义 × `ompStore` 会话目录编码（2bb01cf win32 tmp 优先） | 互补且已核实：launch.sh 用目录链接把数据根指到外部目录，omp 按真实路径落盘；adapter 编码前对 cwd/home/tmp 统一 `realpath`，链接路径与真实路径命中同一会话目录。已补 junction/symlink UT 钉住 |
| `--home` env（`ZCODE_DESKTOP_HOME_DIR`/`OMPCODE_CENTOS7_HOME`）× `ompStore` 的 `homedir()` | 无冲突：ompStore 编码用的是进程 `homedir()`（omp 自身视角），与桌面数据根重定向解耦；`PI_CONFIG_DIR` 生产不设置（注释明示）。两套 env 职责不同且不交叉 |
| undici 版本 × 会话流 | services 仅 `nodeApiNetwork.ts` 消费 undici（Agent/ProxyAgent/fetch 稳定 API）；恢复 `^8.11.2` 不影响 3776734 的帧编解码路径（omp-agent 无 undici 依赖） |

## 4. W2 域文件（只记录，未修改）

- `session/*Repo.ts`、`tasksDatabase/**`（含新 `sqlite.ts` 双运行时封装）、`tasksDatabaseCompatibility.test.ts`：合并后与分支 tip 一致（`git diff f33cd75 6640170 -- packages/services/src/session/` 为空），由 W2 继续负责。
- `packages/desktop/src/main/chromeCookieManager.ts` 等 desktop 文件：W2/W3 域，未审查未触碰。

## 5. UT 缺口与补充（分支新行为）

| 缺口 | 补充 |
| --- | --- |
| profile/offline 透传无 UT | 新增 `packages/omp-agent/test/cliMainArgs.test.ts`：`buildOmpExtraArgs` 参数矩阵（extraArgs 丢弃/过滤、offline 门控、profile 门控与同源解析、参数顺序、desktop-main 复制 env 不变式） |
| `--home` 链接语义纯逻辑无 UT | `packages/omp-agent/test/ompStore.test.ts` 新增「目录链接路径 realpath 后与真实路径编码同一会话目录」（junction/symlink，环境不支持时跳过） |
| IBus 启动器逻辑纯逻辑部分无 UT | 新增 `packages/services/test/runtimeCommandEnvInherit.test.ts`：`XDG_STATE_HOME`（含其余 XDG_*）进入 Bash/终端运行时补丁；NODE_OPTIONS 宽继承不回潮 |
| `--home` 服务层覆盖无 UT | 新增 `packages/services/test/centos7HomeOverride.test.ts`：settingService 读取覆盖 + 迁移守卫、env 未设时不覆盖；systemService home 展示跟随覆盖 |
| IBus 启动器 bash 本体（`scripts/publish/centos7/launch.sh` + `launch.test.sh`） | W3 所有权（refactor-plan W3-1 明确），W5 不改；本清单记录 services 侧可测部分已补 |

## 6. W5 变更清单（本分支提交）

1. `packages/services/package.json`：undici 回 `^8.11.2`（auto-merge 错误修复）。
2. `packages/omp-agent/src/adapters/cliMain.ts`：参数装配抽为导出纯函数 `buildOmpExtraArgs`（行为不变，供 UT）。
3. 新增/扩展测试：`test/cliMainArgs.test.ts`、`test/ompStore.test.ts`（链接语义用例）、services `test/runtimeCommandEnvInherit.test.ts`、`test/centos7HomeOverride.test.ts`。
4. 本清单文件 `MERGE-REVIEW-W5.md`（worktree 根目录，集成时由调度者转存）。

验证结论见提交信息与最终汇报：omp-agent UT、services 新增 UT、`pnpm typecheck`、`pnpm lint` 的实际输出随附于 W5 汇报。
