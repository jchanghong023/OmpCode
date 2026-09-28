# 手机远控内嵌中继

本文件维护 OmpCode 自建手机远控闭环的需求：内嵌 relay、桌面接入 host 端与公网隧道边界。上游 ZCode 的手机远控依赖官方闭源 relay（zcode.z.ai/ws），本 Fork 以内嵌 relay 替代，配套手机端为 ompMobile Fork 的 Android APK。协议帧形状与手机端实现（ompMobile `packages/web/src/remote-v4/`）对齐。

## 目标

- 桌面 OmpCode 内置 relay：不依赖官方云服务，手机经公网隧道直连桌面完成连接、桥接与远控，链路全程不经过第三方。
- 复用现有窗口 Host attachment 与 v4 双链路投影：每台手机以 `web-remote-replayable` clientMode attach 到焦点窗口 Host，不为手机另起 Agent 或 Local Host。
- 上游官方云远控（zcode.z.ai 闭源 relay）的桌面入口按替代关系在两平台统一移除；手机远控的桌面入口只有内嵌 relay 一个，属功能替代而非按平台裁剪。

## 架构与所有权

- relay 运行在 Main 进程，是连接管理、bootstrap 与帧转发的唯一所有者：持有 TLS 监听与 terminal 连接状态；不保存任务、会话、快照等业务状态（业务状态仍归窗口 Host）。
- 手机 terminal 的 RPC 帧由 relay 经 `MessagePortMain` 以 `AttachServicePort`（clientMode=`web-remote-replayable`）接入焦点窗口 Host；连接断开或桥接换代时 `DetachServicePort`，不遗留旧端口。
- 公网入口由外部 frp 隧道承担（用户自建 frps，对外 443 → frpc → 本机 relay 监听端口）；frp 配置不属于本仓库。公网 origin 按用户要求固定写死在本仓库与 ompMobile 常量中（`https://8.137.101.112`，即 frps 对外 443），不提供运行时配置。

## 接入模型（无鉴权开放接入）

- 按用户明确要求：不做配对与身份验证。只要 OmpCode 进程存活、relay 监听可达，任何手机均可连接并取得与桌面同等的会话操作能力。信任边界即 frp 隧道与 TLS 层；公网地址本身即凭据，仅适用于个人可信使用场景。
- 握手保留手机端已实现的帧形状以保持零改动兼容：terminal 发送 `auth_init`（sid/hash 为链接参数，relay 不校验内容与时效）→ relay 直接回 `auth_ack`（pair_status=matched）；terminal 重连重复 `auth_init` 回 `pair_status_ack`。畸形帧（非 JSON、缺 role）断开连接。
- 手机入口链接由桌面 UI 生成：`https://8.137.101.112/remote/v4?sid&hash&t`（origin 为固定常量；sid/hash 为随机填充值，仅为满足手机端链接解析的格式校验；t 为生成时间戳，无时效语义）。同一时间允许多台手机各自连接。

## 行为边界

### relay 协议

- WebSocket 端点 `/ws`，JSON 帧，data 帧 payload 按 `zcode_type` 分发：
  - `bootstrap-request` → `bootstrap-response`：返回焦点窗口可桥接工作区列表（workspacePath/workspaceIdentity，local 工作区 kind=local）与当前视图状态；列表为空或无焦点窗口时回错误码 `bridge_unavailable`。
  - `workspace-bridge-open`（requestId/bridgeSessionId/bridgeGeneration/workspaceKey/taskId?）→ `workspace-bridge-ready`：relay 为该连接建立 Host attachment，返回 bridge 元数据（bridgeSessionId/bridgeGeneration/workspacePath/workspaceIdentity/initialTaskId）。未知 workspaceKey 回错误码拒绝。
  - `rpc-frame` / `rpc-frame-ack`：V4RpcBridge host 侧对等实现——入站分片组装（256 KiB/片、≤64 片、CRC32 校验、messageSeq 连续性 fail-closed）、出站分片与 ACK 追踪、连接重开后未确认帧重放、出站积压上限超限断开。序号与 ACK 只存在于桥接两端（手机 V4RpcBridge ↔ 桌面 host 侧对等实现），relay 仅转发。
- 错误码与手机端映射对齐：`bridge_unavailable`、`server_busy`、`relay_unavailable` 等；无配对语义后 `pair_*`/`auth_*` 码不再产生，但映射保留（协议前向兼容）。
- 单帧上限对齐手机端（1 MiB 级），更大消息由两端 V4RpcBridge 分片。

### TLS 与网络

- relay 监听 127.0.0.1:8765（常量，不提供配置），TLS 证书为本机自签（证书与私钥存于用户数据目录，首次启动生成，SAN 固定覆盖公网 IP 与 127.0.0.1）；手机端 debug 构建通过 ompMobile 的测试 CA/用户 CA 机制信任该证书，release 不信任。
- relay 不监听公网接口、不做 NAT 穿透；公网可达性完全由外部 frp 隧道保证，本仓库不管理 frp 进程。

### 桌面 UI 与设置

- 远控入口生成入口链接与二维码及可复制文本，origin 为固定常量，不随刷新轮换、无过期；显示当前连接的手机数量，手机连接期间桌面任务列表维持现有"手机正在操作此任务"展示语义，不新增第二套状态源。
- 入口链接内容固定，不随刷新轮换、无过期；显示当前连接的手机数量，手机连接期间桌面任务列表维持现有"手机正在操作此任务"展示语义，不新增第二套状态源。

### 平台与离线边界

- Windows 为全功能基准。CentOS 7 启动器传入 `--offline` 时 relay 后端关闭（不监听、不建立桥接）并透传给内嵌 omp；不传入时 relay 正常运行，与 Windows 行为一致。桌面远控入口在两平台始终保留，锁定期间呈禁用态并附「离线锁定中已关闭」说明；无法做禁用态的触发（手机主动连入）明确报错，不静默删除入口。

### 断线与生命周期

- 手机 WebSocket 断开：relay 释放该连接的 attachment（`DetachServicePort`）；Host 侧 attachment 关闭，在途 RPC fail-closed（复用现有 attachment close 语义）。
- 桌面窗口关闭/切换焦点：relay 对新 bridge 请求解析当前焦点窗口；无窗口或 Host 不可用时回 `bridge_unavailable`，手机端按可重试处理。
- 应用退出：relay 停止监听并断开全部 terminal；连接状态随进程消失，不持久化。
- 链接参数、RPC 帧内容不写入日志与遥测。

## 验收条件与状态

1. UT：握手直通与畸形帧拒绝、bootstrap 分发、rpc-frame 分片组装（乱序/缺片/CRC 错/messageSeq 跳号）、ACK 推进与重放、出站积压上限。
2. E2E（本机）：Node 模拟 terminal WebSocket 直连 127.0.0.1 → 完成握手 → bootstrap → bridge → 与真实运行中的桌面 Host 完成 v4 RPC 往返（读取工作区/会话列表）。
3. 公网链路：frp 隧道 + ompMobile 改造版 APK 真机扫码，完成连接、项目列表、消息收发与断线恢复；该验收跨仓库，通过后方可声明闭环可用。
4. 无人连接时 relay 常驻资源占用有界；多手机并发、异常断开后无端口或定时器泄漏。
5. 离线锁定门控（CentOS 7）：`--offline` 下 relay 不监听 8765（本机探测连接被拒），桌面远控入口为禁用态并附说明；不传 `--offline` 时入口可用、relay 正常监听。门控逻辑有 UT 覆盖（不监听、握手拒绝、入口状态），并有本机 WebSocket 探测 E2E；frp 真机链路缺失时如实记录为未验证范围，不得以条件判断替代。

已实现首批并完成链路实测（2026-09-27）：

- UT 9/9 通过（握手帧、证书 SAN/CA 链、rpc-frame 分片/ACK/重放/跳洞 fail-closed）；typecheck/lint 绿。
- 本机与公网（frps 443 → frpc → 127.0.0.1:8765）真实 wss 链路：auth_ack、bootstrap（3 工作区）、workspace-bridge-ready、Node 端 RPC 往返（setting.get / model-selection.getView）全部实测通过。
- 模拟器（API 36）真机链路：深链进入 → 握手 → 桥接 → 手机项目列表渲染桌面真实工作区，实测通过；连接心跳（15s setting.get）稳定。
- 遗留（2026-09-27 下午已闭环）：手机"聊天"发送此前被模型门禁挡——根因是 ompMobile 上游 UI 草稿的模型目录 hydration 依赖官方 provider/presentation 初始化链，与本仓 workspace-config（omp catalog）事实源未套接。已由 ompMobile 侧适配修复：presentation 协议 schema 承接 `configOptions`、草稿水合回写 omp 目录、官方 provider readiness 门禁停用（可用性由 omp 目录承担）、composer 工具栏换 omp catalog 分组。三项 E2E 已实测通过：聊天（glm-5.3-flash/thought=low 发送 → 回复渲染）、子代理（消息流 live「SubAgent · running」→ 展开态「SubAgent · success」→ 主回复整合）。openai-codex 系模型（GPT-6-Luna/Sol）的选中与 thought 切换 UI 正常，但推理被 omp 后端拒绝（invalidated oauth token / Model not found），属后端账号凭据/权益限制：恢复需在桌面端重新授权该供应商，与本仓 relay/桥接链路无关。
