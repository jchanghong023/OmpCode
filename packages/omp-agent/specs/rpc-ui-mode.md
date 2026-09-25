# omp rpc-ui 接入

## 行为

- 每个会话的内嵌 omp 子进程以 `--mode rpc-ui` 启动，仍经 stdio JSONL 使用既有 RPC 命令、响应、事件与 v2 分片协商。
- omp 的工具交互（包括 `ask`）与扩展交互通过 `extension_ui_request` 送到现有 ZCode 会话交互面。`select`、`input`、`editor` 复用 ZCode 已有的 `ElicitationDialog` 问答界面，`confirm` 沿用现有确认交互；回答回写为同一请求 id 的 `extension_ui_response`。选择题的「其他」选项由 omp 随后的 `editor` 请求继续输入，不在 UI 平行增加自定义输入。取消、会话销毁和请求失败按取消收口。
- 其它仅用于终端展示的 UI 通知沿用现有适配器处理，不创建新的状态所有者或 UI 协议。

## 所有者与接口

- omp 拥有工具调用和问题等待状态；`OmpInteractionProxy` 拥有每个待应答请求到 Host 交互 id 的映射。Host 仍通过既有 `interaction/requestUserInput` 和 v4 pending interaction 投影展示；投影声明回答是选项还是文本，UI 不接触 omp 帧。
- 会话事件仍由 `@zcode/omp-agent` 投影成 ZCode Protocol/v4；Desktop `desktop-continuous` 与手机 `web-remote-replayable` 复用同一投影和 owner/lease，不更换传输路径。

## 时序与失败

```text
用户提交 → Host owner/lease → omp-agent → omp --mode rpc-ui
                                      ← extension_ui_request(id)
               Host 交互 / v4 投影 ← OmpInteractionProxy
               用户应答 → OmpInteractionProxy → extension_ui_response(id)
                                      ← 会话事件 → 既有桌面实时 / 手机恢复链路
```

- 回复仅按请求 id 汇合一次；超时或销毁回取消，不能让 omp 永久等待。
- 启动失败或协议不支持时显式报错，不回退到上游 CLI 或另建 Agent 运行时。

## 验收

1. fake omp E2E 检查进程确以 `rpc-ui` 启动，并验证 UI 请求与回答闭环。
2. `select` 与 `editor` 在已有问答界面显示并回答；`editor` 自由文本正确返回给 omp，取消不会变成空文本提交。
3. 执行 omp-agent 测试、类型检查、Lint 和架构检查；真实二进制可用时运行对应 E2E。
