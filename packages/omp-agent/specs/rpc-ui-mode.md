# omp rpc-ui 接入

## 行为

- 每个会话的内嵌 omp 子进程以 `--mode rpc-ui` 启动，经 stdio JSONL 使用既有 RPC 命令、响应、事件与 v2 分片协商。`ready` 公告 `supportedProtocolVersions` 含 3 时优先协商协议 v3（omp fork surface）；协商失败回落 v2，v2 也不可用保持 v1。v3 是否激活由 omp 侧门控，适配器不因协商结果改变既有命令面。
- v3 激活后 omp 的工具审批升级为结构化权限协议：`permission_request`（含 toolCallId、tier、details、input、origin、prefixSuggestion）投影为 ZCode 权限审批卡（pendingInteraction kind `permission` + 宿主 `interaction/requestPermission` 反向请求）；应答映射回 `permission_response` 的六档选项（allow_once/allow_session/allow_always/allow_always_prefix/reject_once/reject_always），拒绝理由作为 feedback 回传。超时、销毁与宿主应答失败一律 fail-closed 回 `reject_once`，不留静默放行。
- v3 激活后 omp 的 `ask` 以完整问题集一次下发：`ask_request` 投影为 ZCode 富问答（pendingInteraction kind `userInput`，questions/multiSelect/preview，toolName `AskUserQuestion` 走 ElicitationDialog）；应答按题解析为 `ask_response` 的 answers（含「其他」自定义文本），decline/cancel 收口为 `cancelled`。携带 `timeoutMs`/`deadlineAt` 时投影倒计时（autoResolution），到期由 omp 服务端按 recommended 收尾、适配器仅本地清场；UI 首次交互经 `snoozeInteractionAutoResolution` → `ask_pause` 幂等暂停两侧倒计时。
- `extension_ui_request` 的 `input`/`editor` 在 v3 下可携带 `sensitive`，投影为密码输入；login secret 输入由此可用。
- 工作区级 v3 查询走目录常驻 omp 进程（`adapters/workspaceConfig.ts`）：`provider/testModelConnectivity` 映射 `test_model`（六类失败归因进错误信息），`mcp/list` 映射 `list_mcp_servers`（连接状态/禁用名单/错误 → ZCode 状态快照）。未协商 v3 的二进制对 fork 命令回 `Unknown command`，查询按能力缺失降级（测试回 -32601、MCP 状态回空表），与既有行为一致。
- 未协商 v3 的已发布 omp 二进制：omp 工具交互（含 `ask`）与扩展交互仍通过 `extension_ui_request` 送到现有 ZCode 会话交互面。`select`、`input`、`editor` 复用 ZCode 已有的 `ElicitationDialog` 问答界面，`confirm` 沿用现有确认交互；回答回写为同一请求 id 的 `extension_ui_response`。选择题的「其他」选项由 omp 随后的 `editor` 请求继续输入，不在 UI 平行增加自定义输入。取消、会话销毁和请求失败按取消收口。
- 其它仅用于终端展示的 UI 通知沿用现有适配器处理，不创建新的状态所有者或 UI 协议。

## 所有者与接口

- omp 拥有工具调用和问题等待状态；`OmpInteractionProxy` 拥有每个待应答请求（extension_ui、permission、ask 三类）到 Host 交互 id 的映射。Host 仍通过既有 `interaction/requestUserInput`、`interaction/requestPermission` 和 v4 pending interaction 投影展示；投影声明回答是选项还是文本，UI 不接触 omp 帧。
- 会话事件仍由 `@zcode/omp-agent` 投影成 ZCode Protocol/v4；Desktop `desktop-continuous` 与手机 `web-remote-replayable` 复用同一投影和 owner/lease，不更换传输路径。

## 时序与失败

```text
用户提交 → Host owner/lease → omp-agent → omp --mode rpc-ui
   v3: ← permission_request(id) / ask_request(id)
       Host 权限卡 / 富问答 ← OmpInteractionProxy（pendingInteraction + 反向请求）
       用户应答 → permission_response(id) / ask_response(id)（v4 resolveInteraction 或反向请求汇合）
   v2: ← extension_ui_request(id)
       Host 交互 / v4 投影 ← OmpInteractionProxy
       用户应答 → OmpInteractionProxy → extension_ui_response(id)
                                      ← 会话事件 → 既有桌面实时 / 手机恢复链路
```

- 回复仅按请求 id 汇合一次；超时或销毁回取消（权限回 reject_once fail-closed），不能让 omp 永久等待。
- ask 倒计时到期：omp 服务端自动收尾，适配器本地移除 pending 交互、不发帧；`ask_pause` 之后两侧倒计时均取消，等待用户应答。
- 启动失败或协议不支持时显式报错，不回退到上游 CLI 或另建 Agent 运行时。

## 验收

1. fake omp E2E 检查进程确以 `rpc-ui` 启动，并验证 UI 请求与回答闭环（v2 降级路径）。
2. v3 协商成功后：`permission_request` 呈现为权限卡，六档选项与拒绝理由回传正确；`ask_request` 呈现为富问答，多题/多选/其他/取消与倒计时暂停正确收敛；子代理来源 `origin` 徽标正确。
3. `select` 与 `editor` 在已有问答界面显示并回答；`editor` 自由文本正确返回给 omp，取消不会变成空文本提交；`sensitive` 输入按密码处理。
4. v3 下 `provider/testModelConnectivity` 返回实测结果，失败信息含六类归因之一；`mcp/list` 返回 omp 配置服务器与连接状态快照。未协商 v3 的二进制：前者 -32601，后者空 statuses，均与既有行为一致。
5. 执行 omp-agent 测试、类型检查、Lint 和架构检查；真实二进制支持 v3 的发布版可用时运行对应 E2E。
