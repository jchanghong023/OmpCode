# 已核实缺陷的恢复与拒绝语义

## 产品规则与所有权

- v4 topic 的生产者与组装器使用同一物理帧计量函数。帧上限覆盖 CLI NDJSON、Channel socket 与手机 relay 三种承载；超过上限时生产者先分片，组装器只接受合法帧。逻辑快照的序号和重放语义不因分片变化。
- omp 会话引擎拥有当前轮、排队轮和待回答交互。命令发送失败或核心退出时，引擎将相关轮次与交互终结；本地命令没有 `agent_start` 时，按关联的完成事实终结其排队轮。已完成轮次不得被迟到的结果再次更改。
- 远端 server 和 Agent 的部署根统一为 `~/.ompcode/server`。启动 wrapper 只执行当前部署的 Node 和 Agent 文件，不读取 `~/.zcode`。
- HTTP server 在无鉴权凭据时只监听回环地址；显式指定非回环监听时必须配置鉴权凭据，否则启动失败。WebSocket 断开时客户端拒绝未完成 RPC，Web 页面显示连接中断并重新建立服务连接。
- Desktop Main 是 window-scoped Host 的生命周期所有者。Host 非预期退出时通知 renderer 并重建连接；旧 Host 的迟到 exit 事件不得注销新 Host。退出清理预算与 Main 强杀预算一致，不能依赖超时掩盖未完成清理。
- workspace-config 的 slash command 目录由 Host syncer 按 workspace identity 推送给 UI，首次快照和热更新走同一状态入口。UI 对不支持的 `/goal` 操作给出可见的拒绝提示。

## 时序与失败语义

```text
omp 输入 → 会话引擎 → omp RPC → prompt_result / agent_end / 发送失败
                         └→ 同一轮次所有者终结投影与 pending 交互

desktop: continuous ──┐
                      ├─ 同一 Host owner / topic seq → UI 投影
mobile: replayable ───┘

Host 旧进程退出 → 比对当前登记身份 → 仅清理旧登记 → 重建或通知当前窗口
```

重连只能以当前 workspace identity 和 session owner 为准。重复关闭、迟到回调、重复 commandId 必须幂等；失败须在 UI 或 RPC 结果中可见。既有数据不迁移，现有用户设置与未提交工作区改动保留。

## 验收场景

1. 800 KiB 级会话帧在生产者分片后通过三种承载的相同上限校验，接收端可组装快照。
2. omp 发送拒绝、核心退出、流式期间本地命令和已取消交互都能收口，不留下永久 running 或假 accepted。
3. 干净远端只部署 `~/.ompcode/server` 仍能启动 Agent；无 token 的 HTTP 入口不暴露在非回环接口。
4. Web 断线拒绝挂起 RPC，恢复后重新订阅；Host 意外退出后窗口能恢复或明确显示失败。
5. 命令目录热更新刷新当前 workspace 的 `/` 面板；不支持的 `/goal` 操作显示提示。
