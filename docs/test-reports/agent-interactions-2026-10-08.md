# 2026-10-08 Agent 交互观察页验收

Windows 隔离桌面的真实 OMP 通信、活动页追加、独立 tab 生命周期、冷恢复、消息摘要与浅深主题验收通过。测试从公开 GUI 发送真实任务，不注入会话、通信事件或投影。CentOS 7 和独立 Web GUI 未验收；全仓检查存在下述已有失败，不能称为全量通过。

## 实际环境与范围

- 构建工具为 Node 24.14.0、pnpm 10.33.2。固定内嵌 OMP `v18.8.3+fork.300`，二进制 SHA-256 为 `8fc97ddf95e80e913578101fd1f6c1b66b58b1dfe5327877cd618a600f35b9da`。真实 live 与所有冷恢复使用同一二进制。
- 隔离应用身份为 `OmpCode Agent Interactions Acceptance`，CDP `127.0.0.1:9232`、renderer `127.0.0.1:5196`。data、home、userData、sessionData 全在 `%TEMP%/ompcode-agent-interactions-20261008-9f930df73299435a8d82ff7c752b3b19/`。Agent cwd 为其 `data/.ompcode/workspace/default`。
- 最终真实回合标记为 `OMP_INTERACTIONS_20261008_9f930df7_V3`，根会话为 `01a11b7a-d2c9-77d0-8440-e439db928eaf`。只执行通信、等待及输出标记；未修改项目文件或用户 OMP 配置。测试对话写入该唯一临时 workspace 对应的 OMP 新会话桶。
- 主会话通过 GUI 选择既有 `zhipu-coding-plan/glm-5.3-flash`、低思考级别。启动器仅在隔离 workspace 的 `.omp/agents/` 创建测试 agent 和默认 task 覆盖，使两个子代理及嵌套代理均使用同一 GLM 模型；四个会话最后的原生 `model_change` 记录均经过核对。
- 为固定验收版本，准备资产可设置 `OMP_RELEASE_TAG=v18.8.3+fork.300`。最终适配器修订只重新 bundle 和 stage，未再获取 latest。一轮标准准备命令曾自动暂存新发布的 fork.304；该自行生成资产已恢复至经过 SHA 校验的 fork.300，未以跨版本结果冒充同版本验收。

## 真实 GUI 结果

| 场景               | 实际结果                                                                                                                                                                                                  | 证据                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 显式入口、空态     | 无工具首问建立实际根会话，零子代理也能从展开状态里的 Agent 交互入口打开空态；未打开时独立查询计数为 0，重复打开只有一个 tab                                                                               | [空态](evidence-20261008-agent-interactions/live-empty-explicit.png)、[live 记录](evidence-20261008-agent-interactions/live-result.json)                                                                                                                                           |
| 活动页追加         | 两个真实子代理运行后显式打开；页面由 2 条记录追加到 10 条，不需要自动打开页面                                                                                                                             | [运行](evidence-20261008-agent-interactions/live-running-explicit.png)、[计数与消息](evidence-20261008-agent-interactions/live-result.json)                                                                                                                                        |
| 准确方向、层级     | 验证 Main → Alpha、Alpha → Main、Beta → Main、Alpha → Beta、Gamma → Alpha 五条独立消息；Gamma 的实际 parent 是 Alpha。搜索定位每条记录，核对时间、正文及选中 SVG 的真实 from/to                           | [live 数据](evidence-20261008-agent-interactions/live-result.json)、[最终冷恢复数据](evidence-20261008-agent-interactions/cold-result.json)                                                                                                                                        |
| 暂停副作用         | 切到子代理详情、收起侧栏、关闭交互 tab 后，mesh 卸载；每次用公开 RPC 方法计数观察 2.5 秒，独立查询没有增加                                                                                                | [live 生命周期](evidence-20261008-agent-interactions/live-result.json)、[最终 cold 生命周期](evidence-20261008-agent-interactions/cold-result.json)                                                                                                                                |
| 冷恢复             | 正常关闭并重启同一隔离 profile，再从已保存根会话打开；五条通信方向与正文恢复。Alpha、Gamma 的明确持久终态显示已完成；Beta 无当前子代理运行证据及结构化终态，显示状态未确认                                | [冷恢复](evidence-20261008-agent-interactions/cold-interaction-page.png)、[源依据与最终 caption](evidence-20261008-agent-interactions/cold-result.json)                                                                                                                            |
| 默认精简、完整原文 | 真实 Alpha task_result 默认显示已完成、35.2 秒、ALPHA_DONE、GAMMA_DONE、报告发送 2 条；默认无可见 XML 包装、JSON 标记与 agent:// 尾提示。查看原文能看到完整原始内容，再收起后隐藏；普通短消息保持真实正文 | [摘要](evidence-20261008-agent-interactions/visual-result-summary.png)、[展开原文](evidence-20261008-agent-interactions/visual-result-original.png)、[断言结果](evidence-20261008-agent-interactions/summary-result.json)                                                          |
| 深浅主题、窄侧栏   | 通过公开偏好菜单切换主题。宽侧栏 684px、窄侧栏 324px，四节点均在 graph viewport 内，无内部横竖溢出；节点字体均为 14px，窄布局不缩字。正文在窄栏正确换行                                                   | [深色](evidence-20261008-agent-interactions/visual-wide-dark.png)、[浅色](evidence-20261008-agent-interactions/visual-wide-light.png)、[窄栏](evidence-20261008-agent-interactions/visual-narrow-light.png)、[边界与字体](evidence-20261008-agent-interactions/visual-result.json) |

视觉视口使用 Chromium CDP 的 1800px/1000px renderer viewport，未操纵日常窗口。测试没有把缩放截图当成响应式适配。

## 冷恢复的真实源边界

Alpha → Main、Beta → Main、Gamma → Alpha 的原生 `wait.details.waited` 保留消息 ID 与 `ts`。GUI 对这些记录严格核对原 ID、原发送时间及 `timeBasis=sent`，live 与 cold 均一致。

Main → 正在运行的 Alpha 仅保存接收方的用户消息包装及发送工具 receipt；Alpha → Beta 在本回合也只有发送 receipt。这两个源没有持久消息 ID/`ts`，冷页使用真实发送 tool-call 的 `send:` 观察 ID、原记录时间与 `timeBasis=recorded`，并明确提示部分历史记录。没有补造消息 ID、发送时刻或已处理回执。源字段证据已保存在 [cold-result.json](evidence-20261008-agent-interactions/cold-result.json) 的 `native.source` 中。

Beta 的背景完成通知出现在一个原生 wait error 正文中，但该回合没有 Beta 的结构化 `wait.jobs`/task progress/results 终态。观察页不能把旧冷投影的 running 当成当前运行，也不凭文本推断完成；最终状态未确认。该规则与 Alpha、Gamma 的明确 `wait.jobs.completed` 分开核验。

## 可复现入口

从仓库根目录执行，先使用固定工具链准备桌面 bundle 与 tsup 产物。启动器要求 `OMP_E2E_ISOLATED_ROOT` 为独立临时目录，且测试进程不设置 `OMP_CONFIG_ROOT`，避免应用数据被其派生根覆盖。

```powershell
$env:OMP_RELEASE_TAG = 'v18.8.3+fork.300'
node scripts/build-desktop-agent-cli.mjs
pnpm --filter @zcode/desktop exec tsup
$env:OMP_E2E_ISOLATED_ROOT = '<独立临时绝对目录>'
node packages/desktop/test/ompAgentInteractions.launch.mjs
```

在另一个终端通过启动器保存的 `runtime.json` 指定该测试实例。真实 live 会调用模型；cold 和 visual 使用 live 已保存的同一回合，不创建模型轮次。

```powershell
$env:OMP_E2E_RUNTIME_MANIFEST = '<独立临时绝对目录>/runtime.json'
$env:OMP_E2E_EVIDENCE_DIR = '<证据绝对目录>'
$env:OMP_E2E_RUN_ID = '<唯一验收标记>'
$env:OMP_E2E_PHASE = 'live'
node packages/desktop/test/ompAgentInteractions.gui.e2e.mjs
# 正常关闭、重启同一个隔离实例后：
$env:OMP_E2E_PHASE = 'cold'
node packages/desktop/test/ompAgentInteractions.gui.e2e.mjs
node packages/desktop/test/ompAgentInteractions.visual.e2e.mjs
```

`ompAgentInteractionSourceEvidence.mjs` 只读取该独立 workspace 对应的原生测试桶；不读取其他会话或凭据。消息列表有虚拟化，脚本通过产品搜索逐条定位，避免用可视 DOM 冒充全量历史。

视觉脚本通过 ALPHA_DONE、task_result 类型及 Alpha 发送方定位真实结果，先只读折叠原文的 textContent，再从本次原文提取 duration/status/结果/子结果/报告发送数量进行断言。耗时和数量没有固定为截图值；源未提供的可选字段不要求 UI 补造。修改为动态源检查后，已在同一保存 profile 上再次实际通过 visual（无新模型），完整展开原文与原字符串一致。

## 自动化检查与限制

- 新功能及必要前提修复的目标测试合计 **56 通过、0 skip**：backend/协议 20、legacy error strict schema 3、UI/调度/展示 33。其中协议检查覆盖 Desktop continuous 与 Web replayable 读面；这些不等同于独立 Web GUI 验收。
- `pnpm --filter @zcode/omp-agent test` 的较早完整执行为 **270 项、269 pass、1 fail**，包含 3 项真实内嵌核心 E2E，0 skip。唯一失败为已有 `test/coldStoreProjection.test.ts:396` 的“ompSessionsRoot：锚点不存在回退 ~/.omp 布局；XDG_DATA_HOME 为空不参与；win32 不受影响”，第 401 行 actual `D:\home\u\.omp\agent\sessions`，expected `\home\u\.omp\agent\sessions`。后续最终修订已执行对应目标回归与真实 cold GUI，不将该完整合集称为全绿。
- Root 编排者最后执行 `pnpm lint`（0 warning / 0 error）、`pnpm architecture:check --changed`（0 violation）与 `git diff --check`，均通过；本任务 70 个新增/修改的可格式化文件（含报告与证据 JSON）格式检查全部通过。本任务新增验证脚本的单独 oxlint 为 0 error/0 warning。
- 最后执行的 `pnpm typecheck` 未通过：未修改的 `packages/desktop/src/host/index.ts:2062` logger debug 索引类型错误。全仓 `pnpm fmt:check` 有 17 处未改文件的已有格式失败；没有为通过全仓检查而重写无关文件。
- 首轮实测发现并修复了 OMP 子代理 transcript 对 string content 调用 `.filter` 的崩溃，以及原生 wait error 的 legacy tool state 多出 strict schema 不允许的 output。首轮失败不计验收。另两次测试 setup 发现用户默认 task 角色和 nested 默认 task 仍使用 OpenAI 模型，均被模型严格断言挡住；最终 V3 用仅隔离 workspace 的 agent 定义证明主/子/嵌套均为 GLM。
- 没有打包安装包；没有执行 CentOS 7 或独立 Web GUI。CentOS 7 本次未提供指定 WSL 测试技能环境，不以 Windows、UT 或 fake protocol 代替该平台验收。
- 最后同一 provenance 修订的 cache 签名补充已证明子状态值，覆盖 directory revision 不变时 unknown → running 的缓存失效；该分支由对应目标 UT 验证。它晚于本次最终 cold/visual 执行，未再次调用模型或声称执行新的 live 状态转换 GUI；最终本地适配器资产已重新 bundle/stage 到当前源码，内核仍固定 fork.300。

验收结束后启动器退出码为 0，自己启动的 Electron/Host/Vite 进程已结束；9232/5196 监听数量为 0。隔离 profile、OMP 测试会话、fixture 与证据保留，以便复查；未连接或关闭用户日常实例。
