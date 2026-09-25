# 上游同步友好的 omp 边界

## 行为与目标

- 桌面、Web、远控仍由 `@zcode/omp-agent` 对接内嵌 omp RPC；用户界面、模型与思考档、计划模型、压缩、上下文、Git 信息、数据目录及发布产物保持原有行为。
- 保留上游 `apps/zcode-cli` 源码快照以减少后续同步时的修改/删除冲突。该目录不进入根 pnpm workspace，不参与构建、运行、测试、安装包或远端部署；保留源码不表示恢复上游 Agent 功能。
- Fork 特有的 UI、资源准备、远端部署和品牌规则尽量由自有文件承载；上游文件只保留必要的接入调用。

## 所有者与接口

- `@zcode/omp-agent` 是 omp 进程、RPC 与会话事实的唯一所有者，对 Host 仅暴露 ZCode 协议。Host 的 owner/lease、CommandInbox、`desktop-continuous` 与 `web-remote-replayable` 语义不变。
- `ZCodeAgentCommandResolver` 仍是本地进程命令的单一选择接口；桌面资源准备与远端部署复用同一 omp 资产及布局，不增加第二条启动或持久化路径。
- Session/Composer 草稿与提交配置仍由现有 renderer owner 管理；Fork 自有 UI 文件只派生展示与调用现有命令，不保存第二份已接受状态。
- 产品身份配置只提供不变的 OmpCode 名称、图标和 `.ompcode` 路径；不能迁移或读写上游 `.zcode` 用户数据。

## 时序与失败边界

```text
用户操作 → Composer 草稿 → Session 命令 → Host owner/lease → omp-agent → omp RPC
                                      └→ 既有桌面实时 / 手机可恢复投影
构建 → omp 资产准备 → 桌面或远端分发 → 同一适配器入口
```

- 上游 CLI 快照即使存在，也不能成为任何运行时回退；omp 资源不存在时沿用现有显式错误。
- 远端部署仍按现有组件版本、原子替换和完成标记顺序进行；失败不能留下被识别为当前版本的半成品。
- UI 切模、思考档及计划模型命令依旧以对应 Workspace/Session 的 accepted 结果为准；不能用局部展示状态代替服务端事实。

## 验收

1. 根 workspace、打包产物及运行命令都不包含或引用 `apps/zcode-cli` 运行时；OmpCode 的实际行为与重构前一致。
2. 运行相关协议测试、UI 交互测试、类型检查、Lint 与 Windows 打包，并核对内嵌 omp 和适配器。
3. `pnpm architecture:check --changed` 无新增违规；保留的上游 CLI 文件与上游对应提交一致。
