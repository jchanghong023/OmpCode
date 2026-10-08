# 输入、文件索引与流式历史优化验证

本次实施计划第 2—4 阶段。会话分享已在基线删除，不恢复其入口或计算。需求权威仍是 `docs/requirements/composer.md` 与 `docs/requirements/performance.md`，本文仅记录实现与验证证据。

## 环境与范围

- 基线提交：`45dd2f624ed5a4bb985a4135ff56e0a6fdb0a751`。
- 固定运行时：Windows、Node 24.14.0、pnpm 10.33.2；源码工作区依赖保持原版本。
- 真实核心使用 SHA256 核验的 OMP `v18.8.4+fork.304` 与既有 `zhipu-coding-plan/glm-5.3-flash`。模型选择及审批通过运行时参数注入，不修改用户配置。
- 桌面使用临时数据根与独立 CDP/renderer 端口，未连接或关闭日常桌面。模型测试只创建测试会话；文件索引与性能样本使用合成数据或临时目录。
- 未访问目标 CentOS 7 网络盘服务器；以下本地耗时不代表服务器帧率、磁盘或远程显示收益。

## 已实施

1. 草稿正文、富节点 JSON 与提交配置共用 scope owner 的保存调度：350ms 停顿合批、持续输入最长 2 秒保存，发送占用/失败恢复、切 scope、blur、pagehide 和 beforeunload 复用 flush。普通正文与富节点 dirty 不通知整个会话页；保存失败保留内存与 dirty 标记，后续普通编辑仍合批重试。
2. Composer 接收稳定的展示投影，行历史/seq/队列版本不直接传播；发送入口读取最新完整事实。相关回调保持稳定引用。Lexical 每个 dirty update 只序列化新 Markdown 状态，富 JSON 仅在保存边界读取；同正文富结构变化仍保存。
3. fileService 实例持有唯一文件索引/ignore matcher owner；普通与 refresh 请求在任何 I/O 前合并。规则保存和路径变化产生新代际，后续扫描等待旧扫描并拒绝旧结果回写。完成态缓存、规则及刷新记录统一受 4 项 LRU 限制。每轮无命中仅补扫一次，清空/重新打开/换 workspace 或连接重置轮次。
4. 时间线计时不读取历史行；内容和计时视图分离，导航/查找不因计时重建。结构稳定的流更新只比较行引用并物化变化轮，分页/替换/移除/可见性变化保留完整结果。
5. `ConversationProjection` 持有 toolCallId 索引，保留首个 Map 插入匹配与最近权限锚定的不同语义；水合、改写、替换与清空同步维护。普通工具更新不复制或遍历历史。
6. 折叠思考从尾部查找有效行并复用摘要；流式代码取消全文哈希和内容 React key。完整内容、同长度替换、完成态高亮、主题与语言更新保持原接口。

## 同样本性能证据

除文件索引取 3 次中位数外，其余耗时为本地单次探针；计数探针含 getter/Proxy 仪表开销，计时与计数分开解释。

| 场景             | 输入                             | 改前                                                    | 改后                                                |
| ---------------- | -------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| 草稿保存         | 100 个约 1 万字草稿，30 次编辑   | 30 次 Storage 读取/写入                                 | 编辑期间 0 次；合批后 1 读、1 写、1 次 JSON 读取    |
| 文件无命中补扫   | 20 个目录、1,000 文件、30 个前缀 | 31 扫描、651 readdir、60 ignore read、60 stat；255.84ms | 2 扫描、42 readdir、1 ignore read、31 stat；19.38ms |
| 时间线计时       | 5,000 轮、15,000 行、30 次       | 450,000 输入行访问、750,000 turnId 读取；103.32ms       | 0 历史行访问、0 turnId 读取；0.25ms                 |
| 时间线单轮流更新 | 同上                             | 750,000 turnId 读取；95.65ms                            | 90 turnId 读取；4.05ms                              |
| 工具更新         | 50,000 历史行、100 次更新        | 5,000,000 历史访问；80.88ms                             | 0 历史访问；0.40ms                                  |
| 折叠思考摘要     | 600,000 字符、30 帧              | 累计 36,001,980 字符传入 replace/split；83.814ms        | 1,020 字符访问；0.119ms                             |
| 流式代码哈希     | 同上                             | 18,000,990 字符访问；53.534ms                           | 0 哈希字符访问；0.130ms                             |

边界：Storage 次数不是物理网络盘读写次数。串行普通文件查询保留一次规则 stat，以保持外部编辑下次查询生效。流式时间线仍需 O(rows) 新旧引用比较及 O(turns) 结果浅拷贝；输入引用读取由 450,000 增至 900,090，不能宣称所有遍历消除。计时与流更新逐次实际核对未变化历史，均累计复用 149,970 个历史 unit 引用。历史结构变化仍完整重建。

复现入口：

```powershell
pnpm exec tsx --tsconfig packages/ui/tsconfig.json packages/ui/test/conversationTurnRenderBuilder.perf.ts
pnpm exec tsx packages/ui/test/streamingContentPresentation.perf.ts
pnpm exec tsx packages/services/test/workspaceFileIndex.perf.mts 45dd2f624ed5a4bb985a4135ff56e0a6fdb0a751
```

## 首轮自动化验证

- 定向 UI UT：24/24 通过（草稿与窄投影 8 项、时间线 11 项、思考/代码 5 项），0 跳过。
- 文件索引入口：13/13 通过，涵盖真实临时目录、普通/refresh 共扫、新文件、规则编辑、旧扫描竞态、身份/实例隔离、TTL/LRU 和失败重试。
- OMP 全套：279 项，278 通过、1 失败、0 跳过。三个真实核心 E2E 均通过，包括 GLM 流式、write/审批/文件落盘、临时模型、本地命令和 v3 目录能力；工具索引的实际 publisher 集成覆盖 Desktop 连续交付、Web 水位续传与强制快照。
- 唯一 OMP 失败位于本次未修改的 `coldStoreProjection.test.ts:396`：Windows 执行注入 Linux 平台的虚拟 `/home/u` 测试时，实际回落路径带 `D:`，断言期望无盘符。`ompStore.ts`、共享路径实现与该测试均无本次差异；不将整套测试记为通过。
- 首轮组件 GUI 通过：真实 React/Lexical/CodeViewer/Reasoning/Timeline，独立 Electron；代码 30 次追加容器挂载一次，摘要身份稳定，同长度替换、展开全文、主题/语言切换后的文本显示与最新复制参数正确。首轮脚本未接入产品 worker provider 或断言实际 token/主题颜色，因此不将实际高亮列为首轮通过项。时间线实际计时推进、查找更新、20→21 轮分页与首轮导航通过。Composer 实际 Ctrl+Enter 的 delayed blocked/throw 恢复、pending 同 Markdown 富节点编辑、用户同正文提及插入、切 scope 后旧 blocked/throw/sent 不污染新输入、冻结旧附件消费和新附件/新 scope 错误保留均通过。组件发送使用受控 port、附件使用合成的已属会话引用，不声称覆盖实际附件服务端上传。
- 首轮产品 GUI：实际 @ 输入连续 38 次无命中仅 1 次 refresh，新文件下一轮可检出并选中；实际 Ctrl+C/V 同 Markdown 提及转普通文本，blur 与 reload 后 JSON 恢复正确。稳定 UUID 会话的 A/B 草稿切换、真实 GLM 流式代码首尾和完成标记、运行中草稿、正常关闭后草稿与完成标记恢复已通过。首轮未比较中间 78 行或冷恢复完整代码，不将代码全文列为首轮通过项。
- 全产品流式代码观测到 35 次 DOM 增量与 3 个代码容器，包含 Markdown 形态转换；只将独立 CodeViewer 组件的 30 次追加记为挂载一次。

GUI 原始证据保留于本机 `%TEMP%/ompcode-hotpaths-20261008-1540/evidence`，包含组件、文件提及、稳定会话和冷恢复结果 JSON、截图及首次失败记录。重跑命令及所需隔离环境见 `AGENTS.md` 的性能热路径验收入口。

## 首轮缺口与验证限制

首轮首次新建会话的临时 `omp-session-*` ID 与侧栏持久 UUID 使用不同草稿 scope，真实 `live` 产品 E2E 失败。首轮公开任务事件不提供 from/to；snapshot 回声订阅 ID，UI 无法可靠自行映射。当时尚未实施权威迁移，首次会话恢复未记为通过；后续修复与验收单独记录如下。

首轮另一个既有边界是用户离开 A scope 后，A 的旧发送失败回包会被原草稿 owner guard 拒绝恢复 A 的已占用草稿。首轮验证了 A 的旧回包不能修改 B 的编辑器、JSON、pending/confirmation 或附件错误，尚未验收 A 源草稿恢复；后续以来源 owner 的提交凭据处理，普通旧编辑器 callback 的 scope 守卫保持有效。

Windows 原生 IME 和操作系统焦点丢失未验收；测试覆盖实际中文字符、产品 window blur 生命周期监听器、真实窗口关闭与冷恢复。父页与 Composer 完整产品 render 次数未加诊断计数，稳定引用和局部所有者由源码及 UT 支持，不能宣称已测完整产品 render 数。

真实模型和完整产品 GUI 使用 Desktop continuous；Web replayable 经过实际 publisher/wire/reader 的水位续传及快照集成，未运行真实 Web 产品 GUI。两种交付语义未改动，不把集成测试当作 Web 完整入口验收。

运行时准备的 `prepare:agent-bundle` 已生成/暂存当前适配器，但覆盖已占用的内嵌 omp.exe 时 EBUSY 失败；未结束其占用进程。真实测试通过 `OMP_RPC_BINARY_PATH` 使用校验后的 release cache 二进制，不将该准备命令记为成功。

首轮完整 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与 `git diff --check` 均通过，架构 baseline/new 均为 0。首轮全量格式检查存在 16 个文件的格式问题；本轮仅格式化这 16 个文件，未修改其行为。没有提交、发布或修改 GPU 开关。

## 审查后修复与复验

- 三项审查回归：同 scope 的 pane 改用共享草稿 owner；ignore 正文读取降级时，matcher 和索引均不进入成功缓存；文件提及清空/重开的轮次在真实输入事件接纳，旧 deferred 查询不消耗新轮次补扫名额。
- 既有身份缺口：Host 成功 rekey 同事务保存 `meta_json.taskIdMigration`，通过现有 workspace 事件与任务元信息读面提供权威映射，覆盖晚订阅、漏事件和重启后的读取。普通运行态快照不得伪造或清除关系。
- OMP 全套复验：固定 Node 24.14.0，**279/279 通过，0 跳过**，包含三个真实核心 E2E。原 Windows 测试修正了虚拟 POSIX home 的宿主绝对路径断言，生产路径逻辑未改变。
- shared/SQLite/rekey/event 复验：**12/12 通过，0 跳过**，覆盖失败迁移、重复投递、迟订阅、运行时代际、identity 隔离、冷重开与快照伪造。
- 文件索引与轮次复验：**21/21 通过，0 跳过**，增加了 builtin/gitignore 两种降级与普通查询/刷新/TTL 三种恢复入口、延迟空查询失活及 raw 输入批处理跳空场景。
- SQLite 后端补充检查：17 项中 **11 通过、6 跳过、0 失败**；跳过项要求当前 Node 可加载 `better-sqlite3` 原生模块或两后端同时可用。此结果不计为 CentOS 7 原生后端验收。
- 已重建 desktop main/host/preload/scheduler 和适配器 bundle，单独暂存 JS bundle，未覆盖被其他进程占用的内嵌 omp.exe。构建成功；适配器构建保留既有 CJS `import.meta` 警告，真实核心测试使用经校验的 release cache 二进制。

用户要求先提交，当前作为阶段提交，未宣称所有问题已验收。窗口级 live/冷元信息迁移入口与共享 owner/reader/提交凭据接线已落盘；其真实 hook、多 pane、首次临时 ID 会话及冷恢复尚未完成本轮 GUI 验收。复核最后提出的富 JSON 跨 pane 交接、同 scope 等待回包时另一 pane 新编辑、目标只有显式配置修改的迁移冲突仍需完成收敛验证；已通过的 owner 内存反例不替代这些产品边界。

补强的独立 visual GUI 已通过：接入产品 `DiffsWorkerPoolProvider`，实际关键词与标识符 token 不同色；暗色/浅色关键词分别为 `rgb(249, 117, 131)` / `rgb(215, 58, 73)`，代码背景分别为 `rgb(43, 43, 43)` / `rgb(255, 255, 255)`。真实 file provider hook 的 raw 清空、deferred 跳空及空查询迟到响应也通过；服务端为受控 port。结果保留于 `%TEMP%/ompcode-hotpaths-20261009-allfixes/evidence/components-visual-result.json`。完整 80 行比较断言已加入脚本，尚未执行本轮真实模型 GUI，不记为通过。

阶段提交前复验：固定 Node 24.14.0，UI 四文件 **24/24 通过，0 跳过**；完整 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed` 与 `git diff --check` 通过，架构 baseline/new 均为 0。这些结果不替代上段尚未完成的草稿功能验收。

## 核心体验续作验收

范围已收缩为 OMP 核心会话、输入/草稿、附件完整性、目录/配置与事件恢复；未恢复商业账号、登录或付费套餐，也未修复范围之外的 Bot、品牌及独立 HTTP/Git 展示问题。会话事件流的协议 ACK 不是商业订阅。

- 原生命令分支已通过 `ac6cbd1` 合入 `main`，未重复合并。以下证据来自 `eccd0b1e` 上的续作工作区，不冒充旧阶段或正式发布版本的整体结果。
- 固定 Node 24.14.0 / pnpm 10.33.2，安装核 `%LOCALAPPDATA%/omp/omp.exe`；使用既有 `zhipu-coding-plan/glm-5.3-flash`，所有产品验收使用专用隔离根与端口。
- OMP 全集 **374/374 通过，0 失败、0 跳过**，含真实核心及显式开启的原生命令场景。定向 UI/Host 组合回归通过；真实 Electron 组件覆盖最新富 JSON、双 pane 焦点与真实 mention picker、pending 成功/失败、新附件引用、来源失败/A→B→A、配置-only 迁移、窗口事件与已有缓存晚绑定。组件的发送 port 与附件引用边界不冒充上传 E2E。
- 重建 desktop 与 adapter 后，最终 `HOTPATH_CORE_FINAL_20261009` 的真实 GLM live/stable 通过：沙箱项目内建任务、首次临时 ID→UUID、Host 权威元信息与旧 scope 消费者、唯一 canonical 草稿、切回恢复、流式期间新草稿保护及完整 80 行顺序。stable 排除发送前轮次，等待新增回答完成。
- R7 同一隔离根的正常退出已观察到窗口/进程退出且服务 exit code=0，非托盘隐藏或强杀；随后 cold 验证完整 80 行与草稿恢复通过。正常退出记录为 `evidence/normal-exit-result.json`，cold 结果为 `evidence/cold-hotpaths-result.json`。
- 最终 mentions 产品 GUI 通过：连续无命中共享补扫轮次、快速清空后新文件可选、实际 Ctrl+C/V 同 Markdown 富节点转文本以及 blur/reload 保持 JSON。首个失败来自全局“新建任务”选择无项目工作区；脚本现复用项目侧栏公开入口，未放宽候选或结果断言。
- 实际 Chromium WebSocket 积压探针峰值 15,729,495 字节、18 个待处理 RPC；连接以应用关闭码 4008 关闭，18 个 RPC 均拒绝，新连接实际文件读取恢复。该探针不是整套 Web 产品 GUI。

证据根：`%TEMP%/ompcode-performance-acceptance-20261009-resumed`；R7 组件/cold/正常退出在 `evidence`，最终 live/stable/mentions 在 `evidence-core-final`。保留早期失败记录，不把它们与后续通过混淆。

用户已明确授权完整 `slowtest`、当前全部工作区提交/推送和两条 `origin/main` 正式发布。完整门禁记录独立保存于 `%TEMP%/ompcode-allfixes-20261009/authorized-slowtest-*.log`；本节仅陈述已实际完成的定向验证，不预先声称完整门禁或发布成功。现有门禁将真 CentOS 7 VM 包级、Citrix IME 与目标网络盘记录为缺少统一自动入口，不能用本地探针、WSL 或静态结果替代。
