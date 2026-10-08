# 2026-10-08 修复后验收

## 发布结论

- **Windows x64：GO（本次验收范围）**。最终验收提交 `ca04952489646a4d6842c7553d20a030119e17f5` 的打包版通过了实际 Windows 桌面 BTW 首问、追问、关闭后历史恢复和进程重启冷恢复。它覆盖了本次高风险的 live parent ID 与稳定 task UUID 分离场景。
- **CentOS 7：NO-GO**。无真实模型的 fake protocol E2E 通过，但全量非真实模型 omp-agent 用例仍有 5 fail、5 cancelled；Node 24.14.0 构建/打包环境也不可用。CentOS 7 不发布。

## 正式发布结果

Windows 发布流水线 [37711402913](https://github.com/jchanghong023/OmpCode/actions/runs/37711402913) 成功，正式公开 [v3.14.3-omp.10](https://github.com/jchanghong023/OmpCode/releases/tag/v3.14.3-omp.10)。标签指向 `ca94d9b38b86d172f5a4334f93e163da12932223`（相比验收代码提交只新增验收报告）。CI 内嵌 omp 仍为已测试的 `v18.8.3+fork.300`。公开 EXE 为 281,914,101 字节，SHA-256 `d3d15851817ac2a527f332fa8597f6f7ef72b07f7b5614198ebb45dacc6b6e4a`，与公开 `.sha256` 文件、GitHub 资产 digest 及 CI 校验结果一致。下节的 `20bb…` 是本地 GUI 验收包校验值，不是公开 CI 重建包校验值。

## Windows 证据

验收工作区、包和 GUI 均针对提交 `ca04952489646a4d6842c7553d20a030119e17f5`。最终 Windows x64 EXE 为 281,896,364 字节，SHA-256 `20bb17aeef078aff5e3ea2f151a9e6dc138223ec2e5d02fb6d6e63f9fc0a5c51`。根代理确认 bundle、运行时/原生资源和体积校验通过，打包命令退出码为 0。

Node `24.14.0`、pnpm `10.33.2` 环境下，最新提交的 `pnpm typecheck`、`pnpm verify:pre-push`（Lint 与全量架构检查）通过。最后修复的需求、UI selector 和测试三个文件的 `pnpm exec oxfmt --check` 通过；没有执行全仓 `pnpm fmt:check`。完整核心测试合集在前一固定提交 `1fcb84ae23fc68394f38070fc38fe51d56ff0808` 上为 242/242 pass、0 fail、0 skip；新提交只增加 UI scope 过滤及其需求/测试，没有改核心实现，因此未重跑该核心合集。完整 UI 测试在最终提交上为 35 文件、100/100 pass、0 fail、0 skip。UI、services、shared、client、server 五包在前一提交上共 65 文件、198 项，192 pass、0 fail、6 skip；6 项都在 `services/test/tasksDatabaseBackendEquivalence.test.ts`，因 Node 24 下 `better-sqlite3` ABI 不匹配而按测试设计跳过。Desktop 测试目录全量 15 文件、43/43 pass、0 skip。

真实桌面验收使用最终解包版 `OmpCode.exe`、临时应用数据目录和临时 workspace，模型为 `zhipu-coding-plan/glm-5.3-flash`。主会话实际 SessionPane ID 为 `omp-session-muyty604-29-afb2cb`，稳定 task UUID 为 `01a11906-bb34-7565-b963-139e112f292e`，两者不同。以该父会话输入 bare `/btw` 后出现空辅助 pane，主 transcript 行数保持 2。首问主题为 `omp-btw:01a11906-bb34-7565-b963-139e112f292e:159d8f23ffd19dac`；首答和同主题追问均在辅助 pane 显示，pane 标注“父会话模型”及“无工具调用”，两个 marker 都不进入主 transcript。每轮前后主 transcript 都保持 2 行。

关闭该辅助 tab 后，展开侧栏、重新打开“辅助对话”并点击“历史主题”，可恢复两轮内容。再关闭整个打包版进程并用相同临时 profile 重启，打开同一 parent 后从历史入口冷恢复同一 topic，首问和追问仍可见，主 transcript 仍为 2 行。脚本与截图保留在：

```text
C:\Users\jiang\AppData\Local\Temp\ompcode-acceptance-isolated-1e36d92f88dc486e9e99cbfa728e0198\
  separated-parent-empty.cjs
  separated-parent-first.cjs
  separated-parent-followup.cjs
  separated-parent-close-reopen.cjs
  separated-parent-cold-restart.cjs
  separated-parent-empty.png
  separated-parent-first.png
  separated-parent-followup.png
  separated-parent-close-reopen.png
  separated-parent-cold-restart.png
```

应用启动和测试输出也在同一临时目录的 `stdout-final-retest.log` 与 `stderr-final-retest.log`。验收结束时，启动的 OmpCode 进程树已停止，CDP 9231 无监听；临时 profile、workspace、历史数据和证据文件保留。

## CentOS 7 证据

按本轮授权，从指定远端在 `/root/ompcode-acceptance-20261008` 创建隔离检出。CentOS 测试检出分支 `codex/acceptance-20261008`、HEAD `1fcb84ae23fc68394f38070fc38fe51d56ff0808`，与最终验收提交仅相差后续 UI scope 修复；源代码、依赖和测试均位于 Linux 文件系统，未调用真实模型。

- fake protocol `adapter.e2e.test.ts`：30/30 pass、0 skip、退出码 0，使用 Electron 28.3.3 内嵌 Node 18.18.2。
- 排除 `real-omp.e2e.test.ts` 的完整 omp-agent 集合：239 项，228 pass、5 fail、5 cancelled、1 个预期平台 skip，命令退出码 123。4 个 `attachmentStore.test.ts` 用例和 1 个 `ompCustomMessages.test.ts` 用例因 Node 18 的 `t.mock.timers` 不存在而失败；5 个 ask/帧测试因 event loop 退出时仍有 pending Promise 而 cancelled；唯一 skip 是 Windows 专用 `ompStore.test.ts` 用例。
- CentOS 7 实测 glibc 2.17、GCC/G++ 4.8.5、Node 20.19.0、pnpm 10.33.2、mise 缺失。Node 24.14.0 的 Linux x64 预编译包要求 glibc ≥2.28，源码构建要求 GCC ≥12.2；因此未运行 Node 24 pin 下的 build/package 检查。没有用 Node 20 代替，也没有升级全局工具链。
- CentOS 7 release workflow、Electron 28/44 拖放和慢盘退出 flush 未验收。Linux 真实模型范围由用户明确排除。

隔离检出 `/root/ompcode-acceptance-20261008` 保留以便复查，原有两个 WSL checkout 未修改。技能调度尝试生成的 4 个控制脚本仍在 Windows `%TEMP%`；自动审查阻止删除，未重试，脚本不在仓库内。

## 边界与副作用

本次 GUI 未覆盖 editor/select/input/prefill 的完整交互、workspace 有/无上下文切换、子代理控制 GUI、Web replayable 重连，也未覆盖 CentOS 打包链路；这些场景不纳入本次 Windows GO 结论。

生产 GUI 日志出现不支持 `v4/conversation/workflowRuns` 的请求错误及异步 Promise rejection 告警；本次 BTW 问答与恢复链路仍通过，不据此声称生产日志无异常或 workflow 功能已验收。

第一次启动生产版时只设置了 `ZCODE_DESKTOP_HOME_DIR`，没有隔离实际使用的 `ZCODE_DATA_BASE_DIR`，因而短暂使用默认 workspace 并更新了 `C:\Users\jiang\.ompcode\v2\tasks-index.sqlite` 的修改时间；该次没有发送真实模型请求。进程随后停止，数据文件未回滚或删除，内容是否变化未核验。之后所有真实模型问答都使用上述临时 data base、userData、sessionData 和 workspace；OMP 配置文件未改，测试对话只写入以该唯一临时 workspace 为键的新会话桶。
