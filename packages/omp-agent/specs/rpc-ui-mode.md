# omp rpc-ui 接入实现边界

产品规则与验收唯一权威：[omp-core-integration.md](../../../docs/requirements/omp-core-integration.md)；恢复、技能及原生集成分别引用该页链接的对应需求。此 spec 只记录实现责任，不保留旧项目宿主或旧 v3 权限/问答协议。

## 所有者与协议

- `OmpChildProcess` 拥有持续 stdout 读取、ready 等待、v3 优先/v2 回落协商、命令关联与 EOF 销毁；start 在协商完成后才返回。每会话一进程，`OmpDirectoryGateway` 唯一持有工作区 `--no-session` 目录进程。
- v3 只增加 commandCompletion/modelRoleConfig/sessionDirectory；审批仍是 `extension_ui_request {method:"select",options:["Approve","Deny"]}`，富 ask 通过 `set_ask_dialog` 启用同一载体的 `method:"ask"`。
- `OmpInteractionProxy` 汇合 v4 与宿主反向应答，按请求 ID 只接受一次。select 缺失/未知/冲突选项取消；input/editor 传递 sensitive/prefill 与实际文本；销毁、取消或断连 fail-closed。
- ask 服务端持有真实超时与 recommended 收尾；适配器不发送不存在的 `ask_pause`，本地 snooze 不声称暂停核心倒计时。
- 当前核心无 `test_model`/`list_mcp_servers`：连通性测试显式 -32601；MCP 查询仅合法空状态，不伪造连接事实。
- 原生 `custom` 消息由现有 `OmpEventProjector` 在 `message_end` 投影为独立完成文本行；`message_start` 不重复落行。`ConversationProjection` 仍唯一拥有行 ID/seq，纯 domain helper 只提取显式可见文本、组装行，不调用模型或修改主 turn/usage/error/stream anchor。冷 `custom_message`/message 包装复用同一可见性与文本提取；两链路继续使用同一 publisher，进程 callback gate 不变。

## 时序与恢复

```text
ready → 持续读流 → 协商 ACK → 订阅/ask opt-in → start 完成
用户输入 → 斜杠/附件校验 → 模型选择 → 核心 admission → 投影终态
核心 UI → 单一交互 owner → v4/反向应答汇合 → extension_ui_response
冷子代理 → 父会话身份/子代理 ID 校验 → 受限持久记录 → 同一只读投影
记录 reset → row.removed 屏障 → 行追加 → 同一订阅水位
desktop-continuous / web-remote-replayable → 同一投影，不同交付边界
```

## 验证入口

相关真实边界、模拟回归与未执行范围按产品权威文档记录；本 spec 不把静态检查或 fake 核心通过写成真实验收。
