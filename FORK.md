# Fork 与上游差异

本仓库 fork 自上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的 `main` 分支，仅供个人使用，持续同步上游。本 Fork 的目的：把 ZCode 的 Agent 核心替换为 omp（oh-my-pi）的 RPC 核心，保留 ZCode 的全部用户界面与交互形态。

本页面向本人和 AI agent，只记录相对当前上游基线仍有效、对使用者有影响的差异需求，不记录实现细节、修复或同步历史。开发规则与上游同步的操作规则见 `AGENTS.md`。

## 当前上游基线

* **分支**：`zai-org/ZCode@main`
* **版本**：`v3.14.3`
* **Upstream commit**：`328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`
* **同步日期**：2026-09-23

版本以提交说明与 README 更新记录为准；根 `package.json` 的 `version` 字段（3.14.0）滞后，不作为基线依据。

## 本 Fork 的目的

把本地 Agent 核心从上游 `apps/zcode-cli`（Agent CLI 与运行时）替换为 omp 的 RPC 核心，ZCode 侧通过适配层对接。产品形态、全部界面与既有双链路语义保持不变；omp 自身的功能演进在其自己的 fork 仓库进行，本仓库只消费其 RPC 核心能力，不重定义 omp。

## omp 侧依赖

* 来源：本人维护的 fork `jchanghong023/oh-my-pi`（本地工作目录 `D:\code1111111111\oh-my-pi`；上游为 `can1357/oh-my-pi`）。
* 接入形态：`omp --mode rpc` 启动的无头核心——stdio 上的 newline-delimited JSON 协议，含 ready 帧、协议版本协商、命令/响应关联、会话事件与 host 工具请求；协议行为以该仓库 `docs/rpc.md` 与对应版本源码为准。
* 分发：使用该 fork 的 GitHub release 二进制；不依赖上游 oh-my-pi 的 npm / Homebrew / Nix / `omp.sh` 分发。

## 差异需求（全部待实现）

本 Fork 刚建立，代码与上游基线一致，尚无任何代码差异（仅 `AGENTS.md`、`FORK.md` 有本地文档改动）；以下为目标需求。需求已确认不代表实现或验证已完成。

### Agent 核心替换为 omp RPC 核心

目标：桌面、Web 与手机远控的全部用户界面保留，本地 Agent 核心由 `omp --mode rpc` 提供；上游 `apps/zcode-cli` 不再作为产品核心维护。

行为边界：

* 换核只替换核心提供方，不缩减用户可感知能力：对话流式输出、工具调用展示、权限确认、会话管理、文件变更展示等现有能力保持对齐。
* Desktop 的 `desktop-continuous` 实时链路与手机/Web 的 `web-remote-replayable` 恢复链路语义保持不变：会话、流式、快照、重连与恢复行为不因换核回退，两条链路的差异由适配层弥合。
* UI 与核心之间保持清晰的契约边界，omp RPC 帧格式不直接渗入 UI 组件；协议适配方式属于实现自由度，不在本文件约束。
* 无法等价提供的能力必须列入「已知与允许的差异」并说明替代行为，不允许静默缺失或回退。

验收结果：

* 桌面应用端到端可用：新建会话 → 发送提示 → 流式回复与工具调用展示 → 权限确认 → 文件变更落地，全程不依赖 `zcode-cli`。
* 覆盖桌面实时链路与 Web/手机可恢复链路的 E2E 场景换核后全部通过，断线重连与会话恢复语义不回退。
* 与现有行为的全部差异可在本文件中逐项看到。

### 已知与允许的差异

* 尚无已确认条目。换核实现中发现无法对齐现有行为的能力时，必须在此逐项记录差异与替代行为，才可作为当前有效行为交付。
