# OMP 联调阻塞记录

本文件只记录 ZCode 实际联调发现的问题与证据，不新增或替代产品合同。合同以根 `fork.md` 的 FORK-003 和 OMP 仓 `docs-zh-CN/requirements/rpc-ui-protocol.md` 为准。

当前分工：本轮已获两仓联调与相关修复授权。用户确认 OMP fulltest 当前通过，不重跑；优先让 ZCode UT／E2E 通过，确认与 OMP 无关的失败暂时过滤。早期使用安装版 `C:/Users/jiang/AppData/Local/omp/omp.exe`；当前保留集改用下文已实测的 Bun 绝对源码入口，不启动原 `zcode-cli`，不覆盖 Host workspace cwd。源码验证不冒充安装版产物验证。

## 最新验证与平台边界（2026-10-23）

本节是当前结果快照；下文按时间保留的历史门禁、permission 排除与独立 Team 页面记录不覆盖更新后的验收状态。下文“本次仅更新／未运行”只描述对应历史文档 slice，不表示本轮尚未执行验证；旧通过结果也不覆盖后续源码变更。permission、M01／M02、model restore 以及 Tan 子代理／工作流有效通过记录继续保留各自范围。v2 方案及原 17 项工作保持原范围，**已在 Windows 当前源码的授权验收范围完成**，不扩称安装版、其他平台或全产品验收。

### v2 模型、认证与 profile 当前快照

- **v2 当前源码交付已完成**：原生目录／认证链投影、role 逐角色 CAS、profile 写入边界及原生命令回执读取优化已落源码，并有下述 GUI、真实模型、目录与回归证据。结论限本轮 Windows 源码授权范围，不以实现或局部 UT 代替其他平台验收。
- **隔离模型 GUI 已通过**：company run `desktop-e2e-20261023041723334-p115604-1fc03eb3160d5990` 与 codeagent run `desktop-e2e-20261023041957967-p134116-c4cfcaf9b798144f` 各 3／3 PASS、无重试，均为 `omp-management.e2e.ts` 的 M02／M03／M04：连接成功及认证失败、公开原生 CLI 与 GUI 的 provider／模型名／档位一致、外部 native models／auth 写入后的 GUI 热更新及存储认证使用。两组证据均为真实 Electron＋实际 OMP 源码＋隔离 localhost 模型，**不是实际供应商认证或真实模型验收**。原始结果分别见 `packages/desktop/.e2e-artifacts/<run>/test-results.ndjson`，运行日志见同 run 的 `runtime-logs/`。
- **M01 历史局部通过**：run `desktop-e2e-20261023035254206-p168940-50ec0d829350bada` 仅 M01 的当前 native profile Skill 开关持久化与刷新通过；随后 M02 等待 `omp-e2e/omp-chat` 行显示失败。不得将该 run 记为完整 management 通过；上述后续 M02／M03／M04 成功有各自独立 run。
- **Profile 完整 spec 已通过**：bg376 重建最终当前 GUI 源码并完整执行 `omp-profiles.e2e.ts`，**5／5 PASS、无重试、exit 0**，run `desktop-e2e-20261023052242715-p168964-7768c7bc4f0477c1`；墙钟 180266ms、runner 181.68s，case 合计约 1m52.9s。原始 `test-results.ndjson`、summary、shard manifest 均位于 `packages/desktop/.e2e-artifacts/<run>/`。覆盖双 profile 重启后的草稿／角色／模型／default 恢复、逐角色 CAS、新草稿目录恢复及多会话临时模型不持久化与隔离。早期 run `desktop-e2e-20261023044032714-p77948-e355ae8fadb79631`、bg365 `desktop-e2e-20261023045657443-p61276-e8e250884eae0480`、bg371 `desktop-e2e-20261023050517191-p106148-1c789ea4a1995c5b` 和 bg373 `desktop-e2e-20261023051237556-p120052-d9597c398b09555a` 的失败结果不覆盖、不删除：bg365／bg371 的 `triggers=[]` 诊断分别见 `artifact://835:226-231`、`artifact://848:3345`，bg373 shard manifest 的 `firstFailure.error` 保存 scope clear 后目录未水合的原始 JSON，临时探针已移除。bg374 前三项通过后，第 4 项旧 Recent `omp-alternate` 预期与原生 default 合同冲突；仅按既有合同修正 `:601`／`:683` 为 `OMP_MODEL_ID`，未为此改生产或跳 case。上述历史障碍已由最终整 spec 成功收口，不再是当前失败或等待项。
- **GUI 局部 UT 与门禁范围**：最终 GUI 静态 bg377 PASS（24.19s，`pnpm typecheck` 0 errors／`pnpm lint` 97 warnings、0 errors，扫描 6750 files／`pnpm architecture:check --changed` 0 violations），覆盖最终 scope 归一化源码，更新首轮 bg370 的 96 warnings 快照；未改无关工作区内容。生产 `ompModelCatalog` LSP 无 errors；UI test 的 inferred project 无法解析 `@` aliases，不作为 configured typecheck 结果，也不声称所有 test LSP 通过。bg369 store 1 file／45 tests PASS、3.86s；显式 wrapper 13 files／246 tests PASS、12.06s，日志 `.tmp/native-models-final-draft-consumers.log`。后续新 hook 批次 247 tests 曾为 244 pass／3 fail；最终将生产比较中的 null／undefined 统一为未知 scope，两行修正，旧 fixture 未改。新 scope hook 定向 **46 tests PASS、1.63s**，日志 `.tmp/native-models-scope-hydration-final.log`；此前未变的其余 12 files／201 tests 与 store 45 tests 复用，去重共 **14 files／292 tests PASS，非同批执行**。较早 GUI role 合并后 2 files／8 tests PASS（含真实 RPC `conflict.error.data.code` 合同）保留原范围；以上不扩称全仓 UT。
- **OMP process 回归范围**：bg364 报告 `F:/code2026/oh-my-pi/runs/test-timing/2026-10-23T04-56-55.772Z-158540-68a4c5a0/run.json` 保留 partial，68 pass／1 fail、3082 asserts、236.02s；新增测试在 create helper 后仍断言 0 calls 失败，原 owner 将断言移至 create 前，保留无 session 零请求合同。父级 bg368 定向复验该失败项已 PASS，1 test／40 asserts、4.83s，报告 `F:/code2026/oh-my-pi/runs/test-timing/2026-10-23T05-04-14.894Z-158068-ec2f4f2f/run.json` 为 complete；原 68 项通过的输入未变，复用其结果，不改写成一次新跑 69 项全绿。
- **OMP 回执／会话回归已通过**：`zcode-command-ledger.test.ts` 与 `zcode-sessions.test.ts` 共 30 tests、139 asserts PASS。`F:/code2026/oh-my-pi/runs/test-timing/2026-10-23T04-41-49.538Z-144316-d8e594ee/run.json` 为 `completion:complete`、exit 0、30 executed／0 failures，总墙钟 4.268s；只覆盖两文件的当次快照。冷回执新增测试缺少隔离 agentDir 的问题已纠正，不能把纠正前超时记为产品回归或通过。
- **OMP 69 tests 为较早快照**：`zcode-process.test.ts`、`zcode-provider-config.test.ts`、`zcode-hosts-model-roles.test.ts` 的报告 `F:/code2026/oh-my-pi/runs/test-timing/2026-10-23T04-24-55.667Z-12668-2af463d2/run.json` 为 `completion:complete`、exit 0、69 executed／0 failures，总墙钟 172.754s。该结果保留有效范围，但不覆盖后续 ledger／catalog metadata 等源码改动；不声称本轮重跑 OMP fulltest。
- **OMP 最新 metadata 局部回归与静态门禁**：父级观察 metadata／hot-update 定向 3 tests、51 asserts PASS（16.22s）；最终 `fastcheck` bg372 PASS（44.2s，compileExcluded=0、总时限 180s、exit 0，BEP `static/runs/7176df68-a076-4b3a-a1ce-280de6b944c5/events.jsonl`），更新此前 bg367 64.5s 的门禁快照，不将 action 缓存命中冒充新执行。fastcheck 不替代真实 GUI 或 fulltest。
- **真实 TUI 与 GUI 的 Luna 请求均已通过**：父级确认 TUI 以显式会话参数 `--model openai-codex/gpt-6-luna` 返回独立响应 `OMP-LUNA-REAL-20261023`，不是全局 default role 的证明（GUI 默认展示 Sol）。真实 GUI 此前两次首发各等待 180 秒超时；回执重复枚举修复后的新请求已同时观察到 `v4-timeline` 独立 assistant 与原生 journal：`assistant.provider=openai-codex`、`model=gpt-6-luna`、正文 `GUI-LUNA-AUTH-OK-20261023`、`stopReason=stop`。父级核对的 journal 为 `C:/Users/jiang/.omp/agent/sessions/--F--code2026-forkZcode-.tmp-real-luna-gui-home-v3-.ompcode-workspace-default--/2026-10-23T04-47-07-942Z_session_641611d44647ebfd8d04c47293a43d3d.jsonl`；本 slice 未读取用户历史或凭据。该项为真实模型与原生认证链成功，不是 localhost 模型结果；早期超时记录保留，不作为当前请求失败。
- **真实调用的配置未变证据**：父级在 `.tmp/real-luna-gui-auth-evidence.json` 记录真实 GUI 临时选择 Luna 前后 `config.yml`／`models.yml` hashes 完全相等；最终当前 build 的 `.tmp/real-model-final-acceptance.json` 进一步确认两文件 SHA256 仍完全等于最初，两端认证沿用原生 credentials，未替换、无 mock。该证据不扩称所有用户数据均已比对。TUI 使用 `--no-session` 与明确的 Luna 模型，真实响应另见父级 `artifact://833`，不以 TUI 显式模型选择证明 GUI 默认角色。
- **最终当前 build 的默认值与真实 GUI 请求已通过**：49335 当前源码 GUI 新建真实草稿默认按钮为 `openai-codex/GPT-6.1 Sol 高`，与独立 NativeDefaultProof 的 `openai-codex/gpt-6.1-sol/high` 完全一致；随后显式选择 GPT-6 Luna，真实请求约 3 秒完成，`v4-timeline` 独立助手响应 `GUI-LUNA-FINAL-OK-20261023`。父级实际核对原生 journal 的独立 assistant：`provider=openai-codex`、`model=gpt-6-luna`、`stopReason=stop`、`text=GUI-LUNA-FINAL-OK-20261023`。最终证据 `.tmp/real-model-final-acceptance.json`，实际截图 `F:/Temp/User/omp-sshots-15b11c68855dc59f.webp`。Luna 为显式临时选择，不冒充 default role 推理验收。父级已关闭本次自有 TUI／GUI 进程并删除临时 Vitest wrapper 与 title／skillful 覆盖 YAML，保留原始 run、日志、截图与 JSON；未删除用户 journal 或缓存。
- **真实完整目录与全部档位已通过**：父级在相同 native profile／cwd／env 下，将重启后的 49334 resident GUI 与公开 CLI 完整比较：311／311 模型、10／10 providers，provider／id／name 全部相等；再以同一 native `getSupportedEfforts`／`ModelRegistry` capability 补证全部 311 模型，档位差异为 0。原始数据见 `.tmp/real-native-resident-final-verification.json`。原生 `off` 对应 GUI `disabled`，`reasoning && !thinking.unverified` 支持 `auto`，公开 CLI 不输出该 `auto` 元数据；LongCat 的 `reasoning=true`、`unverified=false`、`efforts=[]`，因此 GUI `auto` 为合法原生项。`alibaba/deepseek-v4-pro` 原多出的 `low` 已消失，实际 GUI 为 `[disabled,auto,high,max]`，与 CLI `high/max` 及原生补证一致。此结果仅证明本次完整目录与档位一致，不以显式 Luna 请求推导全局 default role，也不覆盖全部产品验收。
- **完成范围与平台限制**：本轮 v2 及原 17 项工作已在 Windows 当前源码的授权范围完成，证据包括完整 profiles、真实 Luna 两端请求及最终 build GUI 独立响应、默认值读回一致、311 模型全目录与原生档位一致、GUI 门禁及定向回归。最终 49335 GUI 的 311 模型／10 providers 亦与此前已验证原生目录逐项完全相同。安装版、Linux shm／NFS、手机、远端及跨平台全产品验收未由这些结果覆盖；不把源码通过扩称正式发行或全部平台通过。本次文档编辑未运行 checks／tests／build／lint／format 或真实服务，未读写用户凭据、配置或历史。

### 其他已保留的局部验证

- Wiki／Repo 真实 GUI bg229 PASS、exit 0，170.04s，run `desktop-e2e-20261022224641003-p64788-9616faedaa677057`；mention 真实 GUI bg230 PASS、exit 0，246.40s，run `desktop-e2e-20261022224640810-p85936-69d818d634ab7f89`。原始结果位于 `packages/desktop/.e2e-artifacts/<run>/test-results.ndjson`；Wiki／Repo 另有 `omp-indexes-evidence.json`、明亮及 900px 窄屏截图。具体动作、可点击证据路径和范围见 [coverage matrix](conversation-session-e2e-coverage-matrix.md#omp-native-wikirepo-与-mention-最新真实-gui-证据2026-10-23)。
- Wiki 新增、完整正文、grep 边界空白、原生纯空白错误、字面 `[ ]`、删除，以及 Repo 文本、真实 Python 符号／路径、更新、重建、删除均通过，`modelRequests=0`、`sourcePreserved=true`。mention 同一个 `it` 中原触发器／session catalog 生命周期与真实 SharedSkill 的 assistant 执行结果均过；受控 localhost 模型不冒充真实模型。
- Parent 已执行根 UT bg233：100 文件、1905 passed／31 skipped；这是当前白名单，不是原完整全仓 UT。Desktop full typecheck bg237 exit 0（28.73s）、lint 98 warnings／0 errors、architecture 0 violations（11.31s）。
- Parent 已执行 Native `check:ts` bg235：新 action PASS（105.25s），37 warnings／0 errors，BEP `static/runs/cafa0c33-7c0b-4c98-a894-aafe34a97b1a/events.jsonl`，不记为旧缓存结果；原生 Team／projection／commands 回归 bg236：3 文件、84 pass、680 asserts（2.65s）。
- **Team 配置与完整聊天 E2E 已通过**：Parent bg323，exit 0，墙钟 146.93s，无重试，真实 Electron `omp-team.e2e.ts` 整 spec 1／1 PASS，run `desktop-e2e-20261023002309604-p63584-57f2834ff080b229`。覆盖全局模型配置 inline 无需 session、优先已配置可用模型、选择／复制／排序／保存与跨两个 session 读取，以及原生讨论阶段、节点角色／模型／边和工具详情、折叠不取消、完成后同会话续聊、取消、刷新与冷启动恢复。该 run 保留 `test-results.ndjson`、summary、配置 saved／relations／cancelled／reopened 截图、native completed journal、Provider requests 与 `omp-team-chat-history.txt`；早期 helper／details 夹具／navigation 输入故障不再是当前阻塞。旧独立 Team 运行页结果未用于替代本轮。本次仅为 Windows 源码 Electron 与隔离 localhost 模型的 ZCode 验证，不报告 OMP 本次验收或发布，不代表安装版、手机、真实模型、远端、其他平台或全产品通过。

## OMP owner 修复状态（2026-10-22 ~11:10，OMP 侧 Agent 回写）

下述内容为 2026-10-22 ~11:10 的历史回写：当时报告 8 项已修复并通过 OMP 门禁（fastcheck PASS；fulltest PASS 573.1s/900s，含用户裁定跳过的 collab 用例）。后续回退和当前验证边界见本文件末节，不将此表当作当前源码状态：

| # | 缺陷 | OMP 侧修复摘要 | 复验前置 |
| --- | --- | --- | --- |
| 1 | modelSelection 缺失 | 投影以 journal `zcode_model_selection` 条目持久化 canonical 选择；`#model` 接受即写回；冷恢复/refresh 保留 | 需重建 exe |
| 2 | forkNotice 分割线 | 真实 parent linkage → `timelineMarker(forkNotice)` + `turnTailBoundary`，无 linkage 不合成 | 需重建 exe |
| 3 | 子代理审批边界+隔离 | executor 删除 blanket yolo，子代理继承父会话审批模式（受限模式走审批链、无 UI fail-closed）；judge 候选按 `enabledModels` 作用域过滤，不再外呼 opencode-zen | 需重建 exe；child 场景可重跑 |
| 4 | git reset 非 critical | `CRITICAL_BASH_PATTERNS` 补 `git reset --hard`（含 `-C`/引号/大小写；普通 git 不升级） | 需重建 exe |
| 5 | 队列输入不计预算 | onTurnEnd 边界把 queued 输入计入 pending token，超阈先压缩再消费队列（G02） | 需重建 exe |
| 6 | 后台交还前台仍 streaming | 非终态 agent_end 专门 settle：idle 判定达标 + `backgroundWorks` 同帧原子发布，保留唤醒/停止语义 | 需重建 exe |
| 7 | 默认标题截断 | `session-listing` 4096 前缀窗口截断行不再被 fallback 误取，按 4× 扩窗重读完整行 | 需重建 exe |
| 8 | redacted thinking 丢失 | `LeakedThinkingProjector` 重投时按源位透传 event-less `redactedThinking`（opaque bytes 不动） | 需重建 exe |

- **重建协调**：`dist/omp.exe` 尚未重建，当前 e2e 仍验证旧 exe;OMP owner 待用户/ZCode owner 确认窗口后重建并通知，避免 Windows 锁与混版证明。
- 用户裁定已入 OMP 需求文档（rpc-ui-protocol.md「范围与验收」）：v4 permission 交互通道不支持、插件引用不支持（fail-open 不拒输入）；collab 在途用例按裁定暂跳过。
- snapcompact fallback 用例已恢复：验证 remote 失败后的真实压缩提交、上下文保留及不额外续跑，不再以单次模型调用断言混淆候选遍历与周期重试。本次 OMP `fulltest` PASS（504.3s/900s，exit 0）；报告 `runs/test-timing/2026-10-22T07-20-56.319Z-49072-149e6df5/run.json`，Bazel 分目标证据见对应门禁日志。

## 已确认的生产端合同缺口

### 1. 刷新后的 canonical modelSelection 缺失

- 场景：`omp-app-server.e2e.ts` 的 B 会话刷新后继续发送问题。
- 已确认：ZCode 刷新仍保留同一个 B、四条历史及 `OMP_E2E_STREAM_B_DONE`；输入问题后发送按钮禁用，工具栏要求选择模型。
- 消费合同：`session-config.ts` 的 `modelSelection` 是已接受的稀疏选择意图；`provider/model/thought` 只是 effective 展示，不能据此伪造选择。
- 只读源码核对：OMP `modes/zcode/projection.ts` 构造与 `refresh()` 不输出 `modelSelection`；`server.ts::#model` 接受 selection 后只刷新 effective 字段。
- 验收边界：修复须保留 B 的 `omp-e2e/omp-alternate` 与 disabled reasoning，不能改全局配置、借默认值或 Recent 替代；同时验证冷恢复。
- 证据：会话 `session_43ebc9d9f1ca12e0a9a1ccbb711aea07`；`artifact://452:6564-6650`；本地 `.tmp/omp-session-model-selection-defect.json`。

### 2. 派生会话没有 forkNotice 分割线投影

- 场景：Cron 创建后派生，卡片 → dislike → fork action → 派生分割线的 DOM 顺序。
- 已确认：真实 `forkAssistant` 已接受并切换子会话；卡片及两个 action 均存在，`boundaryRowId` 为 null。
- 子会话：`01a16133-33f8-737d-9d0a-6ccb130ae900`；父会话：`session_7a9546cda7a225274c190c374b98c701`。子 journal 记录真实 parent linkage 与 accepted ACK。
- Root 既有消费者：`ConversationRowView.tsx` 渲染 `timelineMarker/forkNotice`，`ConversationTurnGroup.tsx` 将 `turnTailBoundary` 放在卡片与 action 之后。
- 只读源码核对：OMP projection 没有 `forkNotice`、`turnTailBoundary` 或 parent-session 映射，其 timelineMarker producer 只处理 compact。
- 证据：run `desktop-e2e-20261022012056400-p89980-8e673363df1ae17c`；`artifact://453`；`.tmp/omp-fork-marker-defect.json`。

### 3. 子代理审批边界与本地模型隔离

- 场景：Guarded 下允许一次父级 task 启动，子代理危险 Bash 应在父 dock 请求审批，拒绝后不得执行。
- ZCode 已修正夹具：父级 task 与 child 标记严格关联，只允许本次启动，不选择会话授权；子命令使用当前隔离目录的真实绝对路径。
- 已确认：子 Bash 无父级 child-origin 审批即执行成功；不是缺失回放，初始相关 fixtures 均返回 200，最终严格回放拒绝制造成功结果。
- 只读源码根因：OMP `task/executor.ts::createSubagentSettings` 明确将 headless 子代理的 `tools.approvalMode` 覆盖为 `yolo`，把父 task 审批当作整个子任务授权边界。
- 另有隔离问题：实际 child journal 记录自动 thinking judge 尝试 `opencode-zen/claude-haiku-5-5`，返回 401 后才回到本地回放。未展示凭据；修复隔离前不再运行 child 场景。
- 证据：run `desktop-e2e-20261022013145519-p80420-4f47d9f83d234d78`，`CheapReindeer.jsonl`；`.tmp/omp-child-approval-isolation-defect.json`。

### 4. Guarded 不覆盖 Git reset 的 critical 审批

- 已确认旧失败 run 执行的是原夹具命令：先写 execution marker，再执行 `git -C .../missing-repo reset --hard`；实际 Git 已运行并因目录不存在退出 128。
- 只读策略：`CRITICAL_BASH_PATTERNS` 不包含 git reset / `git -C`；未命中 critical 或用户规则时 Bash 返回 exec，native guarded 允许 exec。
- 分类：legacy 必须审批合同与 native critical 策略覆盖范围不一致，不是 Root cwd 或 fixture 路径漂移。
- 证据边界：旧 run 早于新增 draft-intent fence，未保留当时 effective-mode admission receipt；源码分析不等于旧 exe 的 mode receipt。
- 证据：run `desktop-e2e-20261022001032596-p51756-0fe58f9f342d4e86`；`.tmp/omp-guarded-reset-contract-defect.json`。

### 5. 队列自动 drain 没有计算待输入预算并提前压缩

- 场景：`compact-auto` G02；当前 usage 为 29912，阈值 30000，后续 queued 普通输入应计入预算并先压缩。
- 已确认：queued 完整正文被发送并完成，但没有 compaction journal 或 auto/success marker；不是队列卡住。同 run 的 G01 超阈值路径通过。
- 待生产端验证的源码解释：post-turn `willContinue` 只考虑 tool calls，followups 稍后才消费；queued preparation 未覆盖直接 prompt 的 pending-budget 边界。
- 证据：run `desktop-e2e-20261022004829706-p54208-7134a9571ca9c2c5`；会话 `session_5627f76e245ebefba88da1c8df2bf7f9`；`.tmp/omp-queued-compaction-defect.json`。

### 6. 后台 Bash 已交还前台但投影仍为 streaming

- 场景：`bash-direct-output` BDO04。
- 已确认：真实 async Bash 与前台回复均推进，但 ZCode 仍收到 streaming 状态，无法满足 idle / 后续输入边界。
- 需要 OMP 区分 yielded-awaiting-background 与 foreground-running，同时保留后台唤醒和停止语义；不能在 ZCode 强制改为 idle。
- 证据：run `desktop-e2e-20261021235403578-p69124-105aed617db0c7df`；`.tmp/omp-background-projection-defect.json`。

### 7. 自动化首条输入默认标题截断

- 已确认：Host 立即运行 ACK 用时 742.6ms；任务、分组与真实执行结果均已落库，不是等待 scheduler tick。
- native journal 保存完整首条输入和实际回复，但 CLI 标题为 `E2E_AUTOMA`、source=default；ZCode 不能自行覆盖 CLI-owned title。
- 证据：run `desktop-e2e-20261021234426609-p42668-08a209b2d1136b5a`；会话 `session_ef566ff0-1a76-45a3-88d0-ea9dfa69504c`；`.tmp/omp-integration-handoff.json` 的 `automation-first-input-title`。

### 8. Anthropic redacted thinking 在 journal 前丢失

- 场景：reasoning-history replay I70。
- 已确认：seed 响应有 `redacted_thinking`；native provider completion 记录四个 block，agent-end maintenance 只剩三个，持久化 assistant 已缺 redacted block；之后 live 请求同样缺失。
- 已保留 signed bytes 与 unsigned-demoted text 的严格断言，未改回放接受损坏历史。具体删除语句仍待 OMP owner 定位。
- 证据：run `desktop-e2e-20261022001208154-p37532-23ddfa463a8c7588`；`.tmp/omp-integration-handoff.json` 的 `anthropic-redacted-block-lost-before-journal`。

## 最小适配边界

- Host 为 fork／编辑输入调整 Provider Registry 刷新的补偿已回退；OMP 必须兼容原有命令准入与 CAS 流程，不靠 ZCode 改调用顺序修绿。
- 问答恢复跳题不提交字段的原合同；原 Agent MCP 转换器不承担 OMP 兼容修复。
- 不在 ZCode 的既有 E2E 回放中解析 OMP 原生工具 schema、翻译工具调用或用特殊预期接受协议差异；专用真实 app-server 联调入口与本地模型隔离保留。
- 通用会话恢复修复、必要 role／Team 配置展示和启动／发行装配保留，不因收缩协议适配而删除有效需求。

## 验证边界

- ZCode 当前 UT 白名单已实跑：42 文件通过，889 项通过、23 项跳过，196.13 秒；没有新增 UT 过滤项。该结果不代表原全仓 UT。
- 首轮 10-shard E2E：`desktop-e2e-20261022080152056-p93584-ee4b1fe54eb2c21e`，真实启动安装版 `omp.exe`，106.321 秒后因自动化 telemetry 等待首错退出。定向 run `desktop-e2e-20261022080959196-p42044-52f7be03d0bb8967` 追加安全诊断后证实 `reports=[]`，连 Host 独有的 `session_create` 都未发送；当前 `resolveBuildTimeConfig()` 实测 `telemetryReportEndpointConfigured:false`，`telemetryCore.ts:418-419` 按既有合同跳过发送，故暂缓该 spec，不归因 OMP。未为测试开启真实遥测。首错取消的其他分片不计通过。
- `fork-merged-assistant` 暂缓原因：同轮 shard 7 journal 第 17—19 行记录旧夹具调用 `Write(file_path,content)` 及真实 `Tool Write not found`；network capture 公布的是 OMP `_write(path,i,content)`。未给 OMP 增加旧工具别名，未改断言或 replay 翻译。此为取消前的明确工具错误证据，不将该分片描述成已独立完成的失败用例。
- 专用 OMP GUI 已通过：`desktop-e2e-20261022080924183-p62620-bb9556e0aef01b6c`，2 项通过、0 失败，父 runner 墙钟 49.428 秒。覆盖同 workspace 双会话、真实写工具、问答、停止、刷新与临时模型隔离，以及 role 保存、Team 失效槽修复／只读预览／重复保存／脏草稿取消。测试本身修正了新草稿错误忽略 Renderer Recent 的假设与 JSON option 值拼接非法 XPath 的定位错误，未修改 Host/UI 或 OMP 产品行为。
- 原 OMP fulltest PASS 按用户确认复用；上述 E2E 尚未全绿，整体仍未验收。历史回退前的记录不替代本轮结果。

## 当前新增暂缓项

本表仅对应 run `desktop-e2e-20261022081214117-p46328-434bcd46fdfcbee9`。`A` 为相对本文件的 `../../packages/desktop/.e2e-artifacts/desktop-e2e-20261022081214117-p46328-434bcd46fdfcbee9/`；`F` 为 `../../packages/desktop/test/e2e/fixtures/upstream/conversation-session/`。表内文件均仅加入既有 `FORK_DEFERRED_E2E_SPECS`，仍可精确 `--spec` 点名；既有硬屏蔽不变。不改原测试、fixture、断言或协议，不将取消分片当作独立完成的失败，也不将暂缓项标为通过。

| 精确暂缓文件 | 原始错误与归因边界 | 原始证据（相对 run／fixture 路径与行号） |
| --- | --- | --- |
| `conversation-session-chat-loading-live-tail.test.ts` | DETACHED 请求返回 `Missing Fixture`。主 fixture 仅 `maxMatches: 2`，用旧 `Generate a concise title` 排除标题请求；OMP 的 `You name coding-agent sessions...` sidecar（`tools: []`）与 FOLLOWING 主请求各消耗一次，真正 DETACHED 请求耗尽次数。不是滚动能力失败证据。 | `F/conversation-session-chat-loading-live-tail.json:15-24`；`A/shard-1-of-10/network-capture/upstream-provider.json:1068-1120,1278,2159-2161`；DETACHED 请求 ID `2a85d325-265d-4683-9988-96c18bcff02e`。 |
| `conversation-session-automation-cron-relative.test.ts` | `CronCreate` 返回 `Native tool approval is not supported by the ZCode host`、`is_error: true`，后续 `Missing Fixture`。用例明确等待 `approveV4Permission()`；依赖用户已排除的 native permission 反馈，不认定 CronCreate 普遍不支持。 | `A/shard-3-of-10/network-capture/upstream-provider.json:940-944,1861-1863`；`../../packages/desktop/test/e2e/conversation-session/conversation-session-automation-cron-relative.test.ts:50-59`；OMP `docs-zh-CN/requirements/rpc-ui-protocol.md:394-396`。 |
| `conversation-session-ask-user-question-keyboard-navigation.test.ts` | 首个 fixture 命中后返回 `Tool AskUserQuestion not found`，错误后续缺 fixture 而返回 500。回放固定旧 `AskUserQuestion(questions[])`，不能由此取消 OMP 原生提问／回答合同。 | `F/conversation-session-ask-user-question-keyboard-navigation.json:34-80`；`A/shard-4-of-10/network-capture/upstream-provider.json:872-873,980-984,1808-1810`；OMP `docs-zh-CN/requirements/rpc-ui-protocol.md:245`。 |
| `conversation-session-background-notification-batch.test.ts` | 三个旧 `Agent({run_in_background:true,...})` 的 `tool_use_id` 分别收到 `Tool Agent not found`。无后台任务启动成功证据，不能将后续 notification 合批断言未完成归为 OMP notification 缺陷。 | `F/conversation-session-background-notification-batch.json:54-80`；`A/shard-6-of-10/network-capture/upstream-provider.json:863-864,950-966,1781-1783`。 |
| `conversation-session-built-in-subagent-model-overrides.test.ts` | 父工具返回 `Tool Agent not found`；回放固定旧 `Agent` 的 `model:"haiku"`／`subagent_type:"general-purpose"`。后续 child fixture 命中不能抵消父工具错误或证明真实派生成功。 | `F/conversation-session-built-in-subagent-model-overrides.json:53-63`；`A/shard-10-of-10/network-capture/upstream-provider.json:875-876,943-947,1867-1868`。 |
| `conversation-session-compact-stream-fallback.test.ts` | journal 为 `Compaction failed: Nothing to compact (session too small)`。capture 仅 seed 请求，无 compact stream／non-stream 请求或 compact `Missing Fixture`；原生正常小会话 guard 未进入 transport，不能声称 fallback 已失败。 | `A/shard-7-of-10/network-capture/upstream-provider.json:871-884`；相对 desktop 的 `.e2e-home-desktop-e2e-20261022081214117-p46328-434bcd46fdfcbee9-shard-7/.omp/agent/sessions/-ZCodeProject/2026-10-22T08-13-10-314Z_session_da2332cf6116909ad45d94da58520fb6.jsonl:17-19`；`../../packages/desktop/test/e2e/conversation-session/conversation-session-compact-stream-fallback.test.ts:29-56`；`F/conversation-session-compact-stream-fallback.json:63-121`；OMP `packages/coding-agent/src/session/session-maintenance.ts:1354-1362`。 |

### 原生修复与后续验收边界

- `context-window-cold-resume`：原水位滞留缺陷已修复；新 exe（`built 2026-10-22T08:25Z`）run `desktop-e2e-20261022082730064-p19156-f44f43ded70692c4` 已越过测试 119—124 行原高 usage UI 断言，随后仅卡在 126 行旧私有日志计数。helper 446—477 行读取 `.zcode/cli/debug/model-io-*.jsonl`，要求旧 `querySource/main_turn` 格式；本轮没有该目录，真实 provider 请求与原生 journal 均存在，journal 32 行 `contextSnapshot.promptTokens=157900`。不复制旧内部日志或旧 `Bash` 别名，现精确暂缓整个 spec；126 行之后的继续、compact 和再次冷恢复未验收。该后续夹具边界不改变原 OMP usage 缺陷的归因。
- `empty-completion-retry`：原 `model_context_window_exceeded` 误作输出上限并重发的缺陷已修复；新 exe run `desktop-e2e-20261022082730077-p92264-392fea9b21779a4d` 的原生 journal 33—34 行保留 `stopDetails.type` 与 80/5 usage，`.omp/logs/omp.2026-10-22.28984.log:112-115` 明确进入 `reason:overflow` 维护，未再注入错误 Continue。未生成 summary 或新主请求，短历史在本地 no-progress 路径结束；完整恢复仍未验收。capture 4494 起的 41 次 `Missing Fixture` 全部是独立 session 的 OMP 标题 sidecar，不是 compact 请求；不能把它们称为压缩 provider 失败。第一 case 保留；仅第二 case 通过既有 `ZCODE_E2E_MOCHA_GREP='^(?!.*明确上下文限制的空流先 Reactive Compact，再重试当前请求且不追加 Continue$)'` 暂缓，不改原测试或旧持久化断言，不新增强制短历史摘要策略。
- `automation-cron-create`：源码 run `desktop-e2e-20261022083644001-p66836-4557d9d77c8655c7` shard4 在测试 90 行硬编码查找旧 wire 名 `CronCreate` 而得到 null；同 run `network-capture/upstream-provider.json:589-604` 实际公布 `_CronCreate` 且保留防递归自动化 description／prompt schema，924—945 行实际调用该工具并得到 `Native tool approval is not supported by the ZCode host`。测试 100 行必须 `approveV4Permission()`；本轮排除该权限反馈，故精确暂缓，不改工具编码、夹具或断言。其余首错取消的 spec 不计失败或通过。
- `automations-workflows-hub.test.ts` 已有七项通过（`A/shard-5-of-10/test-results.ndjson:1-7`）；自动概括请求的 `Missing Fixture` 不足以定性整个 spec，因为该场景刻意不验收模型回合。`conversation-session-highspeed-card-draw-timeout.test.ts` 取消前没有测试结果或 provider 请求。两者仍未知、继续保留。
- `bots/bot-runtime-authority.test.ts` 两项已通过（`A/shard-6-of-10/test-results.ndjson:1-2`），`conversation-session-conversation-workspace.test.ts` 一项已通过（`A/shard-8-of-10/test-results.ndjson:1`）；不调整选择。此前 `fork-merged-assistant` 和 `automation-run-title-stable` 暂缓保留。
- 诊断 bg365 使用 CLI exclude 意外纳入 manual-review 且缺少 `SSH_CONTAINER`，不属于当前 formal 集，不据此新增过滤。保留集完整 E2E 仍须通过，未重跑 OMP fulltest。原生修复回归已实跑：projection 38 项通过；compaction 与 Anthropic envelope 两文件共 84 项通过、4 项跳过。OMP `bun run check:ts` 通过；ZCode `typecheck`、`lint`、`architecture:check --changed` 通过（lint 96 warnings、0 errors），暂缓选择回归两文件 107 项通过。

### 无需编译的源码联调

- 已验证通过 `ZCODE_AGENT_SERVER_COMMAND=C:/Users/jiang/.bun/bin/bun.exe` 与 `ZCODE_AGENT_SERVER_ARGS_JSON=["run","F:/code2026/oh-my-pi/packages/coding-agent/src/cli.ts","app-server","--stdio","--surface","desktop"]` 直接运行当前源码，保留 Host 注入的实际 workspace cwd，不设置指向 OMP 仓库的 `ZCODE_AGENT_SERVER_CWD`。
- 专用 GUI run `desktop-e2e-20261022083209196-p77992-33ec8dec4636088c` 两项通过、0 失败；实际 spawn 参数与 Bun 进程见该 run `runtime-logs/0-0/desktop/2026-10-22.log:165-168`，界面证据 `omp-conversation.png`、`omp-configuration.png`。改动源码后下一次新建 Agent 进程生效，不宣称已有进程热重载。
- 字面量 `bun run dev` 加 OMP 仓库 cwd 的尝试已完成协议预热，但未通过会话绑定（run `desktop-e2e-20261022082914448-p34944-cff646354652008a`）；不将这一尝试标为成功。采用绝对源码入口无需改变 Host/UI 或编译 exe；源码结果不代替发行产物验收。
- 本次新 exe 的原生 TUI 也经隔离 `tui-test` 启动，显示 `isolated-local` 编辑器并通过文本断言；未发送模型请求，已关闭本次自有 terminal session 并清理隔离配置。

### 当前选择与旧 Agent 夹具边界（2026-10-22，源码联调）

以下是本轮明确选择，不删除 spec、不修改 fixture／断言、不改 Host/UI，也不新增 replay 翻译或旧工具别名。硬排除不纳入本轮 OMP 集；精确暂缓加入既有 deferred 选择，仍可用 `--spec` 点名，但不得因此启动旧 CLI。过滤、取消、未运行均不记通过。两份只读调查 `agent://FixtureBoundaryFirstHalf`（shard1–5，28 个非 cron spec）与 `agent://FixtureBoundarySecondHalf`（shard6–10，32 个 spec）覆盖 run `desktop-e2e-20261022083644001-p66836-4557d9d77c8655c7` 的 60 个非 cron spec；它们的静态依赖不是独立运行失败证据。下列行号来自两报告；ToolSearch CLI／feedback 与 provider history seed helper 已另行只读核对当前源码。

路径缩写：`C` = `packages/desktop/test/e2e/conversation-session/`，`F` = `packages/desktop/test/e2e/fixtures/upstream/conversation-session/`，`H` = `packages/desktop/test/e2e/helpers/`；表内简称 `x` 表示 `C/conversation-session-x.test.ts`，同名 fixture 为 `F/conversation-session-x.json`。非该目录的文件写出 e2e 相对路径。

#### 硬排除：物理旧 CLI driver

**更正此前“特别保留 feedback”的执行对象判断**：provider body／纠错／冷恢复业务合同确实有效，但这些 spec 的物理 driver 不是 OMP。`H/toolsearch-cli-process.ts:106` 暴露旧 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，`:119-123` 直接以 `process.execPath` 启动该路径；`:87-101` 的隔离 env 不消费 `ZCODE_AGENT_SERVER_COMMAND`／`ARGS_JSON`。所以即便 Desktop env 选择 OMP，也不能覆盖此子进程。`H/toolsearch-feedback.ts:56-67` 的 `runFeedback` 在 `:62` 调用的是 **`fixture.start(...).done`**，不是另一个可切换的 OMP runner。此前基于名称或 provider body 断言保留整个 feedback 文件的结论撤回；不撤销实际 native ToolSearch/provider body 合同，不将原 CLI 测试结果替 OMP 记通过。

| 精确文件／选择 | 逐项证据 | 运行边界 |
| --- | --- | --- |
| `toolsearch-recovery`：硬排除 | spec `:16,18-37` 调用旧 CLI fixture 并改旧 `session.sqlite/part`；执行路径见 `H/toolsearch-cli-process.ts:106,119-123`。 | 原 source run 首错后取消，未见该 spec 开始；不是 OMP recovery 失败。 |
| `toolsearch-scope`：硬排除 | spec `:13,22-35` 使用同一旧 CLI fixture，写旧 permission/tools/custom-agent 配置。 | 未见独立终态；不是 OMP scope 验收。 |
| `toolsearch-tui`：硬排除 | spec `:5,48` 使用 `startToolSearchTerminal`，`:101-107` 写旧 credentials；共享 driver 审查确认其旧 CLI 启动链，而不是 Desktop app-server override。 | 未取得 OMP TUI 运行证据；不再以 OMP env 可覆盖为由纳入。 |
| `toolsearch-catalog`：硬排除 | spec `:3,42` 使用 `startToolSearchRuntimeDriver`；共享审查的 `H/toolsearch-runtime-driver.mjs:1-4` 导入原 bootstrap，`:44-165` 的目录/compact 断言运行于该旧 runtime。 | 静态执行对象不兼容；不是已实测 OMP catalog 失败。 |
| `toolsearch-feedback`：硬排除 | spec `:35-67,123-144,210-233,276-285` 的真实 body 断言仍有业务价值；`:69-76,145-154,183-203` 还读写旧 SQLite。`H/toolsearch-feedback.ts:62` 确认落到上述硬编码旧 CLI。 | 撤回旧执行对象判断，不删除断言，不宣称该原测试替 OMP 通过。 |
| `provider-readiness-agent-startup.test.ts`（e2e 根目录）：硬排除 | `H/provider-readiness-history-fixture.ts:64-75` 执行旧 `storage-migrate`，`:77-83` 打开 `.zcode/cli/db/db.sqlite`，`:115-134` 插入旧 session schema；spec `:74-79` 消费该 seed。 | 未见独立运行终态；不是 OMP 缺库。无 provider 的只读启动、历史与单进程复用业务仍保留（spec `:103,140-145`）。 |

父级旧 driver 探测 bg383 已取消，不采用其结果；本次文档更新未启动任何 driver。

#### 硬排除：明确不支持的合同

本组按已确认合同排除，**不是声称每个 spec 均实跑失败**。permission 通道 `permissionCount=0`／`pendingPermissions=[]`、插件引用投影排除及原生不制造旧 trust store，分别见 OMP `rpc-ui-protocol.md:398-399,153-156`。

| 精确文件 | 逐项证据 | 运行边界 |
| --- | --- | --- |
| `permission-hook-rewrite` | spec `:97-104` 查询旧 `session.project_id`／写旧 `local_setting`；`:218-219` 打开 `storageRoot/cli/db/db.sqlite`；`:130,162-174` 要求专用审批 UI。 | **新实际首错**：source run `desktop-e2e-20261022084020260-p29896-cfa8bcf60372a0c8` 在 beforeAll `:97 → withDatabase :219` 报 `unable to open database file`。这是旧私库 setup，不是 OMP 存储缺失，也未到审批业务断言。 |
| `permission-hook-race` | spec `:39-44` 安装 helper；`H/permission-hook-race-fixture.ts:16-24,34-81` 仅写文件／旧 hooks，`:59-71,118-120` 绑定 Write/PermissionRequest；fixture `:53` 为旧 Write，spec `:61-72` 为审批 UI。 | 无实测失败；**没有 SQLite setup**，不能套用 rewrite 的开库错误。 |
| `v4-bash-command-prefix-permission` | fixture `:54,110,165` 旧 Bash；spec `:49-53,68-72` 要求 prefix permission scope／always-allow UI。 | 静态合同排除，未见单 spec 终态。 |
| `v4-permission` | spec `:57,87,107,161` 强制 permission dock；`:101-151` 要求 denial feedback；fixture `:50,128,210,294` 旧 Write。 | 静态合同排除，未见单 spec 终态。 |
| `v4-refresh-permission` | spec `:42-43,60-61` 强制刷新前后 permission／feedback；fixture `:56,111` 旧 Bash。 | 静态合同排除，不能记 OMP refresh 失败。 |
| `plugin-reference-subagent` | spec `:33,50-63` 要求已取消的 `plugin_reference` reminder 投影。 | 静态合同排除；含引用输入仍须 fail-open，不得阻断正文。 |
| `hook-trust` | spec `:11,106-120,131-177` 要求旧 `.zcode/security/workspace-hook-trust-v1.json` 与旧 Hook 事件。原生无等价策略不造 trust store，schema accepted=false。 | 静态不兼容／未独立运行，不是 native Hook 缺陷已证实。 |

#### 精确暂缓：旧 Agent／私有存储夹具

以下仅为明确名单；不是把原生能力判成不支持。除下述静态依赖外，两 scout 所查 run 中没有这些文件的独立失败终态（取消不等于执行）。不要求 OMP 复制旧日志、目录、工具名或原 system prompt。

| 精确文件 | 已确认静态证据与暂缓边界 |
| --- | --- |
| `model-output-token-preflight` | spec `:62-68,85-88` 固定 preflight-v1 reserve／threshold／41671 cap，`:206-229,272-314` 消费旧 model-io／auto-compact 日志；fixture `:92-98,168-170,272-278` 绑定旧摘要 prompt 与精确预算。未独立运行通过／失败。 |
| `model-output-token-budget` | spec `:127-136,253-261,304-316` 固定 preflight-v1、`.zcode/cli/debug/model-io-*.jsonl` 与 `compact.auto.started`。未证明原生输出预算有缺陷。 |
| `send-message-resume-stop` | spec `:58,65,68,96` 要求旧 Agent／SendMessage 卡与 `agent_` ID；fixture `:51,148` 旧工具。原生子代理恢复／取消合同不取消。 |
| `subagent-runtime-catalog-reasoning` | fixture `:50,169,288` 旧 Agent；spec `:145-151,165-176,234-250` 固定旧工具目录／agents-state／frontmatter。原生模型／思考隔离仍保留。 |
| `subagent-prompt-assembly` | fixture `:57,164,269,377` 旧 Agent；spec `:259-260,334-340` 固定旧工具卡与双 system block／旧 ZCode system prompt。不是 OMP prompt 标准。 |
| `subagent-respond-to-coordinator` | fixture `:269,312,384,425,433,638` 旧 Agent／SendMessage／Bash／RespondToCoordinator／Read／TaskOutput；spec `:186-190,343-347` 依赖旧消息协议与工具卡。没有原生代理消息失败证据。 |
| `memory` | spec `:95-108,187-194,234-238` 固定旧 memories／agents／agent-memory 布局、Extraction 与 frontmatter；fixture `:59,273,306` 旧 Bash／Agent／Write。创建期原生 Memory 偏好仍须落实 backend（合同 `:240`）。 |
| `background-bash-output` | spec `:61-67,191` 硬读旧 `cli/exec/<session>/<toolcall>-stdout.log`；fixture `:53,112,170,229,288,347,406,523` 旧 Bash，`:465` 旧 Agent。原生后台输出所有权／尾窗查询合同仍有效。 |
| `background-subagent-rate-limit` | fixture `:57` 旧 Agent；spec `:91-95` 遥测固定 `tool_name:"Agent"`，`:152-182` 验证 failed 卡／child 入口。无 native 429 恢复失败证据。 |
| `pasted-image-path-projection` | spec `:53,249-277,391-410` 固定 `.zcode/cli/image-cache`、`image-<32hex>` 与旧 body 顺序。未由旧缓存路径推出原生图片投影失败。 |
| `tool-group-settings-persistence` | fixture `:51,58,163,168,199,207` 旧 Read／Bash／Write；spec `:74-78,97-103` 依赖这些调用后检查分组持久化。未证明原生分组 UI 缺陷。 |
| `v4-rewind-files` | fixture `:55,84,175,204` 旧 Read／Write 无法创建供本测试恢复的真实文件；spec `:71-88,113-132` 要求真实恢复／冲突。`:156-161` 权限处理为可选，不按 permission 排除；原生文件回滚事务未被本夹具验收。 |

**后续实际运行新增精确暂缓（不是上述静态结论）**：`conversation-session-toolsearch.test.ts` 的 Desktop base 经源码 run `desktop-e2e-20261022084903410-p66240-0eabf19b4586d659` 实跑，测试 `:48` 要求存在旧 `TodoWrite` schema，实际为 false。该 run `network-capture/upstream-provider.json:2465,3446` 广告原生 `_todo`；`:2881` 回放旧 `TodoWrite`，`:3027-3028` 为同一调用 ID `toolu_e2e_toolsearch_todo`，`:3048-3056` 真实返回 `Tool TodoWrite not found`、`is_error:true`。因此仅该文件新增 deferred；它与物理旧 CLI driver 硬排除分开，原生 todo／真实 provider body 业务仍有效。不加旧 TodoWrite 别名、不改 fixture／断言；后续冷恢复断言未验收，不记通过。

#### 仍保留的真实验收边界

- **`model-output-token-preflight-smoke` 独立实跑后精确暂缓**：源码 run `desktop-e2e-20261022093234491-p80224-4626d362622ab5d2` 的 `OTB11` 已越过前置正文完成和实际 provider cap 校验，随后在 spec `:135-140,445` 等待旧 CLI `compact.auto.skipped`／`below_threshold` 私有日志失败。读取路径为 `:464` 的 `ZCODE_LOG_DIR` 或 `cli/log`，不属于公开协议；不能据此判定原生预算失败，也不补造旧日志。保留精确 `--spec`，后续 30K 压缩、48K 场景和完整 smoke 均未验收。实际输出上限进入 provider body、明确 context exceeded 的原生恢复仍须验收；已通过的 `model-provider-add-send` 保留真实 `max_completion_tokens=64000` 与 provider overlay 隔离断言（`:79-98,122-132`）。
- **公开队列／Goal／模型隔离保留**：`v4-queue`、`v4-sendnow`、`v4-stop-queue`、`v4-queue-drain`、`v4-goal`、`v4-model-switch`、`readstate-model-isolation`、`thought-level-session-isolation` 不随旧工具过滤。`modified-submit-delivery`、`side-pane-full-view`、`v4-rewind-queue-background` 的混合 case 文件不整文件排除；未知 `highspeed-card-draw-timeout`、`unregistered-tool-cold-snapshot` 继续保留，未运行的不记通过。普通 ToolSearch 主 spec 原先保留，现仅因上列后续实际旧 TodoWrite 错误新增精确暂缓，不扩大到其他文件。
- **native ask 仍验收**：真实模型提问／回答不是已排除的 permission 面板（合同 `:243-247`）；旧 AskUserQuestion 夹具失败不能取消该合同。专用 OMP GUI 两 case 的源码 PASS 仍以 run `desktop-e2e-20261022083209196-p77992-33ec8dec4636088c` 为准，覆盖写文件、ask／回答、stop、双会话与模型隔离、role／Team 保存；启动为 Bun + 绝对 `cli.ts app-server --stdio --surface desktop`，没有 cwd 覆盖。不得把其 PASS 转记到其他取消的 spec。
- 上节已修 **usage 水位滞留**与 **显式 context stop 误入输出截断 Continue** 的真实原因和原始证据保持不变。后续旧 model-io 计数、短历史 no-progress、旧摘要／持久化断言是新验收边界，不倒推原缺陷无效，也不把尚未完成的完整恢复记通过。
- 最新 permission rewrite 首错后的其余分片取消，不构成新增失败名单。保留集整体仍待父级后续验证；本次仅更新此文档，未运行 build／test／gate／lint／format，未删除文件或修改测试断言／fixture。

### 显式 OMP E2E 配置隔离（2026-10-22）

- **Harness 规则（实现前确定）**：只要显式指定 OMP Bun/source 或 exe，worker 在 resetHome 后、Electron 启动前都必须设置本轮 home 下私有 `OMP_CONFIG_ROOT`／`PI_CODING_AGENT_DIR`，按原生参数优先级选择私有 profile，清空继承的 `PI_CONFIG_FILES` 与提供者认证环境。普通 E2E 不启动专用 `omp-e2e` server、不写固定 `smol=omp-e2e/omp-chat`；模型和凭据只由该 case 原有动态 mock provider 注册提供。原 Agent 无显式覆盖时维持原行为。用户的 root、profile、auth、role 文件一律不读写、不复制。
- 普通 case 的 tiny／commit／smol／judge 与其 native retry fallback chain 由 WDIO 当前 `resolveActiveE2EProviderEnv()` 的 provider/model 二元身份写入私有 config.yml，不能引用专用 fixture 的固定 ID，也不改 default role 或主会话选择。这使后台候选直接使用本轮动态 mock 注册，而不是依赖 catalog 优先链恰好选中本地模型。
- **标题选择来源**：`title-generator.ts:122-157` 使用 native `Settings` 的 smol 或 tiny/commit/smol role 再追加 currentModel；`config/model-roles.ts:104-107` 从全部 available registry models 取候选，不局限 Host source registration。`Settings` 的 global 文件位于 agentDir，`PI_CONFIG_FILES` 可追加配置（`config/settings.ts:696-702`）；role 的 merged 配置优先于 process default（`:2020-2043`）。这是合法生产配置语义，不为测试修改生产选择。普通 harness 原先在判断非 `omp-app-server.e2e.ts` 后立即返回，未覆盖这些 OMP 环境入口，也只在专用 case 清凭据，故存在继承配置／认证入口；不能据此声称已定位旧 run 的具体 global role 文件。
- **旧 run 证据修正**：`desktop-e2e-20261022085221763-p78840-f1c40fd366e198b3` shard7 的 `.omp/logs/omp.2026-10-22.83916.log:100-113` 确认标题选 `opencode-zen/claude-haiku-5-5`，请求 URL host 为 `opencode.ai`，得到 401 `api_key_expired` 后转本地 provider。日志第 2 行同时确认安装了系统代理 `127.0.0.1:7890`。没有代理上游连接／socket peer 证据，故此前报告的“真实直接出站”应改为 **实际执行了非 case provider 的逻辑请求，是否经本地代理出站未核实**；URL 本身不是实际网络目的地证据。run home 下 `.omp/agent` 无 config.yml，也不足以区分继承环境认证、默认 role 优先链或外部配置来源；不展示或探测用户凭据。
- **验收交接**：父级应核对 worker 私有 root/profile 和 case provider 注册，使用原有 capture／OMP title 日志确认实际模型与本地目标，不以仅配置 URL 替代 HTTP 请求证据。保留 native 标题功能和原 prompt／fixture matcher；旧标题匹配造成的 MissingFixture 仍独立未解决，不以隔离改动宣称 E2E 通过。本任务未运行任何验证命令、外网请求或安装。

### Account HTTPS 回放与最新源码证据（2026-10-22）

- **实现前边界**：Highspeed／Account 继续使用官方 HTTPS endpoint 与已有本地 `startCodingPlanDataPlaneProxy`，不把普通 HTTP replay server 的 `E2E_PROVIDER_CAPTURE_PROXY_URL` 当成 CONNECT 代理。worker 标准 proxy 环境与 Host settings 的显式 proxy／CA／no_proxy 必须指向同一个 MITM；显式 OMP fixture 清除继承的 `PI_PROXY`／`PI_PROXY_*`，不改用户配置。OMP app-server 消费 Host 显式网络配置由 OMP owner 实现，原 TUI／独立 RPC 不改变。
- **实际缺口**：`wdio.conf.ts` 已按 `shouldPrepareCodingPlanTeamMock` 启动 Account MITM 并载入 Highspeed 原 fixture，但 startup settings 只消费 `upstreamCaptureProxy`，遗漏 `codingPlanDataPlaneProxy`；Host 清除标准代理环境后，OMP 主请求可能回到系统代理。`network-capture-proxy.ts` 的未命中 mock 路径直接 `callback()`，现有 Account responder 对未匹配轮次也返回成功 fallback，因此现状不能称为 fail-closed；修复必须拒绝未命中，不制造新成功响应或外连兜底。
- **拒绝策略**：仅 Account 本地 replay 显式开启 MITM 未匹配拒绝，普通采集保持原语义；Highspeed 原 fixtures 无对应轮次时记录本地失败，不再使用通用成功 body。响应回调异常也必须转成本地错误，不进入上游或留下未处理异常。Account MITM 优先于普通 upstream capture，proxy／CA／no_proxy 统一取同一 owner。
- **已实施的回放边界**：startup settings 优先取实际 Account MITM 的 proxy／CA／no_proxy；OMP fixture 删除继承的全部 `PI_PROXY` 与 `PI_PROXY_*`。Account MITM 启用 `rejectUnmatchedRequests`，Highspeed 未匹配原轮次时由本地回放返回 `Missing Fixture`，不再落入成功 fallback；未改动任何 endpoint、请求体、Header、模型名、成功响应、原 fixture 或 scope helper。原 `highspeed-card-draw-timeout.json` 的两条主请求 fixture 仍分别匹配 `E2E_HIGHSPEED_DRAW_TIMEOUT_TURN_1/2`。
- **网络修复前证据**：run `desktop-e2e-20261022091158949-p82288-ec040deb293fcd07` 在修正 scope helper 后真正选中 GLM，但正文等待收到 401；普通 capture 只有本地 deepseek title，不能据此认定主 fixture 缺失。后续 Account capture 已确认 GLM 请求进入本地 MITM 并命中原 fixture，最新完整 case 结果见下。
- **Goal 原缺陷已回归通过**：native pause／resume 修复后，源码 run `desktop-e2e-20261022091158942-p100200-fcf8a81f22e647b3` 的原 E2E 1 项 PASS。
- **provider-add-send 原 case 已通过**：取证 helper 正确识别 OMP title 后，源码 run `desktop-e2e-20261022091158940-p62276-831561dc82136038` 原 case 1 项 PASS；捕获到的模型请求目标均为 `127.0.0.1`，主请求实际保留 64000 输出上限／high。title 仍返回 fixture 500，但不再误取为 main；不把 title 标为通过。
- **side-pane 仅精确暂缓旧 Ask case**：native turnHeader 真缺陷已改，组合四文件 90 项通过、修正失败 fixture 时间后的定向 1 项通过。源码 run `desktop-e2e-20261022091444128-p68296-51bb9e0537940622` 已越过原 `:139` 工作时长断言，到 `:155` 旧 Ask 卡才失败；fresh capture `:6232` 为 `Tool AskUserQuestion not found`、`is_error:true`。仅按 `SPFV-E2E-008` 精确标题暂缓，`SPFV-E2E-007` 保留；专用 OMP native ask 已 PASS，不能整体取消提问／回答功能。
- 以上运行证据由父级交接；本 slice 不运行 tests／build／gates／lint／formatters，不以实现完成代替新的 HTTPS 回放验收。

- **Highspeed 原 GUI 与真实 process 回归已通过**：源码 run `desktop-e2e-20261022094407743-p59948-45e935ffbd7eaf4d` 的原 `HS-E2E-02` 1 项 PASS，覆盖两轮正文、首轮不带卡、次轮 composer 加速及唯一历史卡标签。OMP 原先解析后丢弃 `highspeedMeta`，现按原生 inputId 保存并投影，不修改 Host/UI 或 fixture。独立 Account capture 的两条 `GLM-5.3` 主请求均 200；不能混用普通 `upstream-provider.json` 的辅助请求取证。新增真实 process 回归在修复停止队列显式提升后 1 项 PASS／102 断言，覆盖卡指标、错误 target、busy 入队、提升、刷新、冷恢复及会话隔离，报告 `runs/test-timing/2026-10-22T10-11-37.492Z-102312-ca6071bb/run.json`。
- **工作流回收未改产品、未过滤原 case**：先前 10-shard unknown-model case 的全局 DOM 数量不等，不能仅凭文案认定新增。原失败 run 的两条新会话最终在 Host DB 与 native journal 均已删除，删除精确时序及原 DOM IDs 当时未留证。独立原文件 run `desktop-e2e-20261022100100424-p55388-051ceb4019caa27f` 全 10 项通过，临时探针观察到任务数 `2 → 3 → 2`，新增行在 21ms 内移除；后续 10-shard run `desktop-e2e-20261022101549295-p35660-e6362f52a1075260` 也通过原 unknown-model case。未确认旧波动的精确根因，不伪称已修复；全部临时 DOM 探针已删除。
- **最新静态结果**：ZCode `typecheck` 与 `architecture:check --changed` 通过（0 架构违规）；`lint` 通过，96 warnings／0 errors。OMP 本轮 `check:ts` 的 BEP 为 `INTERRUPTED`（code 8），不是通过或已确认编译错误；待源码修正完毕后核验。
- **停止后显式队列提升的真实缺陷已修复**：native `queuedMessagesHeld` 正确保留停止队列；旧无 execution 的 `sendQueuedNow` 只重排后返回成功，仍被该 hold 阻止消费。idle 明确提升现复用既有 `takeQueuedInput → prompt admission` 与失败恢复，保留原输入身份、卡和未选队列的 hold；不修改 TUI 或全局 autoDrain。
- **保留集合最新首错**：上述 `20261022101549295` run 的首错转为 `running-guide-steer` 的 P06 MCS，capture 同一 `toolu_e2e_running_guide_timeline_read` 明确 `Tool Read not found`／`is_error:true`，不能据此修原生 steer。另 `v4-stop-queue` B02/B04 已通过两项保留与 3s 不消费断言，随后缺少暂停 banner；正在核对原生 hold 变化与 `queue.autoDrain` 投影，不删除该真实验收。
- **最终 ZCode UT 白名单已重跑通过**：42 文件、889 passed／23 skipped，211.99s；不含被明确排除的原全量范围，未将 skip 或 GUI 首错取消记为通过。
- **P06 精确边界**：仅暂缓 `P06 MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示`、`P06 non-MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示`。前者在 `20261022101549295` shard9 的 capture `.records[28]` 广告 `_read`，fixture 却返回 `Read(file_path)`／`toolu_e2e_running_guide_timeline_read`；`.records[38]` 同 ID 的真实结果为 `Tool Read not found`／`is_error:true`，随后 Missing Fixture。后者本轮未执行，仅同源静态判断；旧 system/user 黄金 steer 包装是另一依赖，不能声称其已进入断言。整个文件不排除；其余 plain guide、active goal、verifier 仍实跑，私有 prompt 静态迹象只作定位线索，不提前过滤。
- **Goal guide 独立实跑后的精确暂缓**：run `desktop-e2e-20261022103203903-p87352-39f8f16f96deb4c3` 的 plain guide 明确 PASS；active goal 在发送 guide 之前要求旧 `Continue working toward the active session goal` matcher 失败。capture `.records[21]` 是带 19 个工具、原生 `<goal_context>` 与完整 objective 的首次主请求，仍 pending，不能称作主请求 500，也没有已发生 autonomous continuation 的证据；末尾 12 条 500 实为 11 条 Skill hint 与 1 条 title。仅暂缓原 active-goal 完整标题；verifier 完整标题按同源旧 continuation／`Verify whether the active session goal` 夹具静态阻塞单列，未运行不记失败。不改原 Goal 生命周期、fixture 或断言；plain guide 留作本文件真实验收。

### 剩余默认集合的静态旧工具边界

本节依据完整只读报告 `agent://DirectSubmitFixtureBoundary` 与 `agent://BackgroundRewindFixtureBoundary`：实际 manifest 均加载 `upstream/common.json` 和各自同名 conversation-session fixture，`fileFixtures=[]`。以下为已观察到旧工具不存在之后的**静态同源路径判断**，不是这些 case 新取得的实跑失败或通过证据。路径缩写沿用上文 `C`／`F`／`H`。

| 默认文件暂缓（既有 `FORK_DEFERRED_E2E_SPECS`） | 必经成功前置与证据 | 保留边界 |
| --- | --- | --- |
| `conversation-session-v4-background-work.test.ts`，唯一标题 `后台 bash 启动 → 面板显示 running → 取消 → cancelled` | `F/conversation-session-v4-background-work.json:43-60` 实际返回 `Bash({"command":"sleep 300","run_in_background":true})`；`:64-85` 后续必须收到 `Command running in background`。`C/...:41-53,76-105` 必须先有 bashCount=1／running work，才能取消。 | permission 等待 `:32-39` 是可选 try/catch，不能以 permission 排除此例。暂缓仅因必经旧 Bash；原生后台计数／布局／取消需求有效。 |
| `conversation-session-subagent-interaction-delegate.test.ts` | T01 完整标题 `T01: Full access 下 child AskUserQuestion 仍代理到父 task`，`F/conversation-session-subagent-interaction-delegate.json:7-158` 必经旧 Agent／AskUserQuestion，成功要求真实 answer、child result 与工具 ID。T02 完整标题 `T02: build 模式下 child Bash permission request 代理到父 task`，同 fixture `:160-297` 必经旧 Agent／Bash，`C/...:129-185` 还强制父 dock permission 与批准反馈。 | 全文件两例均有必经旧工具，故允许默认文件暂缓；T01 是问答 wire 阻塞、不是 permission 排除；T02 单列不支持的 permission 合同兼旧工具阻塞。不取消 native ask／子代理需求。 |

混合文件只记录以下三个完整标题，由父级传入**既有** `ZCODE_E2E_MOCHA_GREP`；不向文件 deferred 集合添加这两个混合 spec，不新增调度器或 helper：

| 精确 case 暂缓标题 | 静态必经路径 |
| --- | --- |
| `M06k MCS：工具结果后 Cmd/Ctrl+Enter 抢占，human reminder 全文与角色正确` | `C/conversation-session-modified-submit-delivery.test.ts:90-136` 在按键前必须等 BASE 与真实文件内容进入请求。`F/conversation-session-modified-submit-delivery.json:120-224` 返回 `Read({"file_path":"{{e2eRuntimeRoot}}/shared/readonly-tool.txt"})`，后续 hold／selected 必须含 `E2E_READONLY_TOOL_FILE_CONTENT`；不能以 unknown-tool 错误替代真实读取。 |
| `M06k non-MCS：工具结果后 Cmd/Ctrl+Enter 抢占，human reminder 全文与角色正确` | 与 MCS 必经相同 Read(file_path)／文件结果链；差异为后续 golden reminder 要求 user，而 MCS 要求 system。尚未走到 golden 断言，不能称该断言已实测失败。 |
| `PV4-23 edit 前取消被裁 turn 的后台 Bash，新分支只启动一次` | `F/conversation-session-v4-rewind-queue-background.json:228-288` 实际返回旧 `Bash(command:"sleep 300",run_in_background:true)`，原 turn 成功回复必须含 `Command running in background`；`C/...:108-148` 在 edit 前必须取得原回复与 running work。新分支“只启动一次”断言的是 edited provider 请求次数，不是再启动一次 Bash。 |

`H/conversation-session-readonly-tool.ts:5-10` 真实创建上述只读文件，阻塞是旧 Read wire，不是原生存储缺失。shared common 里的 Read 仅命中特定 Read prompt，不能据其被加载而过滤其他 case。

**继续实际执行**：modified-submit 的 `M06k：running 且尚无输出时 Cmd/Ctrl+Enter 直接抢占，不经过 QueueItem` 和 `M06n：guide running 下 Cmd/Ctrl+Enter 只反向进入 future queue`；running-send-now 全部五例（队首 MCS／non-MCS、非队首、goal、双击）；`PV4-20 edit 保留 held queue，再按原 ID/顺序各消费一次`；`PV4-18 附件 edit 保留 canonical ref，新 provider request 只收到编辑分支`；`PV4-19 两次 compact 后跨最新 boundary edit，cold restore 保留更早 summary`。running 队首两个 case 存在旧 reminder golden，goal 有旧 continuation matcher；PV4-18／19／20 的 compact matcher 要求 `CRITICAL: Respond with TEXT ONLY` 和 stream。它们均不是本节必经旧工具路径，不仅凭静态 prompt 差异提前排除或报告失败。

本 slice 仅修改上述选择与两份既有文档，未运行 tests／build／gates／lint／formatters，未修改 fixture、E2E 断言、Host 或 UI；父级负责 regex 传参与剩余真实验收。

### 短种子压缩与旧 MCP 管理面边界

- `desktop-e2e-20261022105117535-p43868-c5f3c7c39347e089` 仅执行 `首轮完成 → /compact → 时间线出现 manual compact success marker` 并失败。原生 journal `2026-10-22T10-51-41-421Z_session_210939145e97ccf5df03ba03418d3e2b.jsonl:20` 明确 `Compaction failed: Nothing to compact (session too small)`；全部 59 条 provider 请求只有 seed、title 与 skill hint，没有会话摘要。当前历史不足 native `keepRecentTokens=20000` 的可压缩前置，不是 producer 丢失 success；accepted ACK 不等于压缩成功。暂缓当前唯一 case 所在 `v4-compact`，PV4-18／19／20 另行实跑，不以相邻短种子结果推断它们失败。
- `desktop-e2e-20261022105117524-p57768-cd6560f270b6d084` 仅 MVN04 实跑失败；原 Desktop 日志 `:279` 为 `Unknown method: mcp/list`，实际 seed 在隔离 `.zcode/cli/config.json` 的 `mcp.servers`，native journal 为 `mcp.identity=ambient`，wire 目录为空。native ambient 读取 `mcp.json`／`.mcp.json` 的 `mcpServers`，没有消费该 seed，不能说握手失败。第二个完整 case `MVN01/MVN02/MVN05/MVN06/MVN08: 真实 Agent 按 server 协商并记录精确版本` 未执行，另依赖旧 modern/probe、node_repl 及私有连接日志。两例所在文件默认暂缓；独立 MCP 管理面不在当前承诺，不补旧接口／存储兼容。native MCP discovery、显式 create/resume MCP、真实工具调用及回收需求不取消。
- 后续 PV4-18／19／20 已分别独立实跑，不再靠相邻 case 推断。PV4-18 run `desktop-e2e-20261022110045487-p85352-95bec7e0c4c0ad26` 的 native journal `2026-10-22T11-05-02-790Z_session_dc23d0f496f5f7ea87ae2409063dfb84.jsonl:19`、PV4-19 run `desktop-e2e-20261022110045487-p51812-867e81aeb7b6c130` 的 `2026-10-22T11-05-04-032Z_session_f0f3898ede312d4a75a75d30e6027fa9.jsonl:20`、PV4-20 run `desktop-e2e-20261022110045505-p57004-f24ff7121924d0e2` 的 `2026-10-22T11-04-56-957Z_session_454d42312fb104282d224cdf50654778.jsonl:20` 均明确同一 small-session 错误，各自 capture 均无会话摘要请求。18／19 停在首次 compact success 等待，20 停在首次 compact running 等待；后续 edit／cold restore／队列组合没有执行。18 的实际模型不支持图片，原请求为 image omitted 及本地 image ref 文本，不能说 provider 已收到原始图片。两个 rewind 文件据上述逐 case 依据默认暂缓，原生行为要求及后续验收缺口保留。
- **原生正向压缩已实跑通过**：专用 OMP GUI run `desktop-e2e-20261022111616637-p69148-b77c2ae238f6c83f` 全 3 项 PASS。压缩场景使用真实大回复及独立保留尾回合，不修改 native 阈值；实际 structured-summary 请求覆盖旧历史，提交后新请求包含摘要且不再包含被压缩的大回复。刷新并重新选择原会话后，manual success marker 的 rowId 保留，后续请求继续消费该摘要。`omp-compact-restored.png` 已核对实际恢复界面。此证据不替代上述尚未执行的附件／两次 boundary／held queue 组合。
- **Host 无新材料提升屏障已修复**：`sendQueuedNow` 不携带新 `modelSelection`／`modelExecution` 时立即转发原 CAS 信封，不再等待冗余 Provider registry refresh；携带新材料时仍等待刷新，失败仍阻断。真实 stop-queue 文件 run `desktop-e2e-20261022111340616-p54848-5a78dcb81b680f4d` 5 项 PASS，覆盖 keep/clear 新输入、FIFO 恢复及原 ID 显式提升；后续 10-shard run `desktop-e2e-20261022111718371-p101524-5b5c6a8232e78f3a` 的 B14 Resume 再现暂停未消费，正独立定位，不以先前单文件通过掩盖该失败。

### 最后独立运行的旧夹具边界

- `v4-edit`：run `desktop-e2e-20261022112430252-p48380-0034fc6e0f79ae2d`，native journal `2026-10-22T11-25-05-076Z_session_9c311fc6a78ca77176c000ff40902da4.jsonl:21` 明确 `Compaction failed: Nothing to compact (session too small)`；唯一 case 停在首次成功 marker 等待，edit 尚未执行。
- `v4-fork`：run `desktop-e2e-20261022112430287-p41892-504399b011bf6011`，child journal `2026-10-22T11-25-34-435Z_01a1635b-f963-72c7-883c-669546f50cc0.jsonl:2,17-20,29-30` 已保留 parentSession、父问答、durable fork boundary 与 child 回复。capture `upstream-provider.json:3173-3223` 的 GLM-5.2 请求含继承父问答及新问题。失败仅在 test:97-108 的固定英文 notice、字符串 content 和旧 wrapper 断言；未执行到的后续 GUI 历史断言不算通过。原生公共 marker/cold linkage 另有 process 回归，不用模型提示词伪造。
- `running-send-now`：run `desktop-e2e-20261022112134532-p70352-6b00a127bffa01e3` 的 `M07a MCS：running 中点击队首立即引导，消费原文并以 user reminder 降级` 在 `incoming-message-evidence.ts:62` 的旧 prefix 搜索失败。实际已验证所选 ID、请求出现、UI user row 出现与 queue 清空，捕获的 user 原文前为真实原生 `<system-notice>`，紧邻 `send-now-head-partial` assistant。仅此完整标题与共用相同回调的 non-MCS 标题暂缓；non-MCS 本轮未运行，不记实测失败，helper 之后的唯一行／气泡断言不记通过。后续 run `desktop-e2e-20261022112520868-p11428-8e742044cf55f6f7` 的非队首原用例 PASS，但 queued Goal 失败正在修复，不能把它归为旧黄金文案。
- `tool-input-validation-provider-content`：run `desktop-e2e-20261022112430251-p60848-4562cdaaf96de174`，首个主请求命中 `tool-input-validation-malformed-call`（200）；fixture 却返回未声明的 `AskUserQuestion`，原生目录广告 `_ask`。capture `:2015-2040` 的真实结果为 `Tool AskUserQuestion not found`，主 continuation 不匹配旧 XML `InputValidationError` 文案和 raw-marker 禁令，返回 500。原生 schema validator、live 完成与 cold restart 均未触达，不能归因原生校验失败或伪称通过。
- `unregistered-tool-cold-snapshot`：run `desktop-e2e-20261022112430286-p73440-ef52578062d74db8` 的 native journal 已持久化全部 61 个失败结果，首次 continuation `46577d5c-7e1d-436e-ab21-11094b622eec` 实际上送 61 个 `tool_result`。fixture:613-647 要求旧 `Tool not found: Grep`，实际为 `Tool Grep not found`，所以包含完整结果的主请求被 fixture 拒为 500。未知工具结果和 continuation 没有丢失；60-row tail、最终终态及 cold UI 补齐未执行到，仍不作为通过证据。
- 上述四个单 case 文件复用默认 deferred 集合，仍可精确 `--spec` 执行；原文件、断言和回放均保留。混合 running-send-now 只通过现有 `ZCODE_E2E_MOCHA_GREP` 精确暂缓两个 M07a 标题，不过滤真实 Goal 准入失败。

### 最新 owner 修复与回归证据

- **终态 context 原子发布**：B14 透明 wire `resume-b14-20261022/d77428552a98/2026-10-22T11-24-12-884Z-proxy-102800-agent-41812.ndjson:150,161,165,167,172` 证明 Stop idle/choice 携带旧 usage=11373，随后仅 usage=11381 的迟到刷新推进 revision。原失败 run 没有 wire，不能断言其 13→14 一定是该字段；已捕获的同型 publication 缺陷由 projection 在 terminal/background settle 同批读取 native context 修复，不改 CAS、不重试。46 项 projection 回归通过，原完整 stop-queue GUI run `desktop-e2e-20261022113704675-p65360-74cedbc9b51056e1` 5/5 PASS。
- **显式 queued Goal 提升**：修复前 Goal input 已 admitted、提升已 ACK，但控制器只在 dequeue hook 执行，打开的 HTTP stream 期间目标未应用。显式提升现在在同一 command owner 先应用原生 Goal，再保留原生 steering 的真实输入消费边界；不 abort、不伪造 promoted，普通排队 Goal 不提前生效。原 GUI run `desktop-e2e-20261022113704764-p88756-a7fff6ae441495bd` 的 queued Goal 与 double-click 两项均 PASS；先前非队首原用例也 PASS。旧 fixture 的 60s 流与 45s queue 断言有时序差异，但这次实际通过，不据该静态差异额外暂缓 Goal。
- **工作流菜单**：原失败现场在打开菜单阶段再次启动同一真实 `direct-launch-save`，没有删除请求；删除项在 UI 无条件存在，未证实 OMP catalog 缺陷。case9 仅将可见且启用的 trigger 聚焦后通过真实 ArrowDown 打开菜单，不修改产品或删除／原样保存断言；run `desktop-e2e-20261022112624379-p58096-2250c9e6edf51149` 原 case PASS。具体旧点击像素偏移机制缺少当时截图，不作确定归因。
- **最新 ZCode UT**：42 文件、893 passed／23 skipped，195.25s；随后 E2E selection 三文件 162 项通过。均为既有临时白名单／指定选择范围，不冒充原全量。

### 本机联调收口

- 最终源码联调 run `desktop-e2e-20261022122036593-p9140-ee2e6459f99d1be9`：10 shards 全部退出 0，23 个文件、45 个用例全部通过，外层墙钟 250.50 秒（runner 统计 249.087 秒）。本轮重新构建了包含 Root 修复的 Desktop（build cache miss `c047724ccff3`），Host 直接启动 Bun 加载 OMP `src/cli.ts app-server --stdio --surface desktop`，没有运行原 `zcode-cli`。`shard-10-of-10/omp-compact-restored.png` 已核对真实刷新恢复界面。
- 刷新恢复前发现 Root 提前发布 migration-complete：应用设置尚未刷新时，一次性 provider 守卫可能将空 domain 锁定为需要登录，关闭 workspace/pane 恢复。现在等设置及 Provider 刷新结束后，仅由未失效的启动代次发布完成。原失败现场缺少 Root DOM，**不能断言先前每次 pane=null 都来自该竞态**；本轮修复后，原 vertical-slice 与 OMP 双会话刷新恢复均通过，没有修改恢复动作或断言。
- M06k 在前一并行 run `desktop-e2e-20261022120940606-p69140-6d3f55a4d4b63570` 停在快捷键后 3 秒清空等待。源码确认 streaming/Stop 可先于首发 ACK 出现，而 Lexical 在提交 pending 时拒绝修饰键发送。测试现在先等待实际发送按钮 enabled，再执行原 trusted Ctrl+Enter；原 3 秒清空、请求次数、用户行与无 QueueItem 断言均保留。失败时的 pending 值未被采集，不能将其当作已经捕获的现场事实。最终两个保留的 modified-submit 用例通过；临时 DOM/按键探针已移除。
- 最终 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均通过；Lint 为 96 warnings／0 errors，架构为 0 violations。Root 的 LSP diagnostics 无可用 language server，不冒充诊断通过。
- 当前选择模块有 111 个临时硬排除 spec、56 个可用精确 `--spec` 重开的 deferred spec；清单与上述逐项证据保持分开。最终运行另通过既有 `ZCODE_E2E_MOCHA_GREP` 精确暂缓 10 个混合文件标题：I74 明确 context stop、SPFV-E2E-008 旧 AskUserQuestion、两个 P06 旧 Read、两个 active-goal/verifier 旧 continuation matcher、两个 M06k 旧 reminder 黄金全文、两个 M07a 旧 reminder 黄金全文。没有新增整文件排除来隐藏 Root 或 M06k 失败，也不将这些排除、暂缓或首错取消记为通过。
- 上述是隔离本地模型回放下的真实 Desktop→Host→OMP→模型 HTTP 边界验证，不是模型服务质量、所有旧 Agent 私有合同、正式签名发行或远端平台的完整验收；已确认的 OMP fulltest 结果复用，不作为所有后续改动本轮重跑的记录。

对应的 Windows PowerShell 源码复跑入口（从 ZCode 仓库根运行，OMP 源码位置按当前双仓布局）：

```powershell
$env:ZCODE_AGENT_SERVER_COMMAND = (Get-Command bun -ErrorAction Stop).Source
$env:ZCODE_AGENT_SERVER_ARGS_JSON = '["run","F:/code2026/oh-my-pi/packages/coding-agent/src/cli.ts","app-server","--stdio","--surface","desktop"]'
$env:ZCODE_E2E_MOCHA_GREP = '^(?!.*(?:明确上下文限制的空流先 Reactive Compact，再重试当前请求且不追加 Continue|SPFV-E2E-008 最小化时出现 AskUserQuestion 会自动恢复浮窗并显示卡片|P06 MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示|P06 non-MCS：tool-batch 与 text-only drain 后 steer 按同轮时间线顺序显示|guide 模式下 active goal 运行中发送引导消息，不得 stop active target|guide 模式下 goal verifier 运行中发送消息，应保留为 future queue 且不 stop active target|M06k MCS：工具结果后 Cmd/Ctrl\+Enter 抢占，human reminder 全文与角色正确|M06k non-MCS：工具结果后 Cmd/Ctrl\+Enter 抢占，human reminder 全文与角色正确|M07a MCS：running 中点击队首立即引导，消费原文并以 user reminder 降级|M07a non-MCS：running 中点击队首立即引导，消费原文并以 user reminder 降级))'
pnpm --config.use-node-version=24.14.0 test:e2e --shards=10 --logLevel warn
```

此段只选择执行对象与上述精确暂缓项，不设置 `ZCODE_AGENT_SERVER_CWD`，也不跳过 Desktop 源码构建；使用后可清除这三个进程级环境变量以回到默认启动选择。

最终清理后再次运行门禁：`pnpm test:unit` 为 42 文件、893 passed／23 skipped，Vitest 墙钟 164.21 秒；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 及本轮三个 TS/TSX 文件的格式检查通过。OMP `bun run check:ts` 为 Bazel 有效成功缓存命中（`status=cached`，BEP `static/runs/f43071f4-1d86-43d2-9743-91c27d7952df/events.jsonl`），不冒充重新执行了检查 action；未重跑 OMP fulltest。
