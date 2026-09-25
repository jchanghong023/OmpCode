# omp v4 图片附件转发

## 产品规则与所有权

- v4 `createSession.firstInput.attachments` 和 `sendText.attachments` 中已提交的图片附件，按输入顺序作为 omp `ImageContent`（base64 数据和 MIME 类型）随同一次输入转发。图片正文不进入 v4 command frame。
- `AttachmentStore` 是已上传字节及 MIME 类型的唯一所有者；v4 命令只按附件 ref 读取，不保存第二份附件状态。`ConversationEngine` 继续负责选择 omp `prompt`、`steer` 或 `follow_up`，三种命令都携带同一组图片。
- 视频、PDF 等非图片附件可上传和回读，但不进入 omp prompt。无附件的文本输入保持原行为。原有 legacy 图片转发路径保持可用。
- 此修复兑现 `FORK.md` 已有差异 #16，不改变需求或协议格式；不迁移历史会话或附件。

## 时序与失败语义

```text
UI 预上传 → Host 转发 begin/chunk/commit → AttachmentStore 持有已提交字节
UI v4 输入携带 ref → V4CommandService 读取图片 → ConversationEngine 选定 omp 命令
  → omp prompt / steer / follow_up 携带 images → 原有 ACK 和会话投影
```

- 上传未提交时仍由现有上传流程处理；非图片 ref 不生成 `ImageContent`。v4 命令的幂等 ACK、会话 owner、桌面 continuous 与手机 replayable 投影语义不变。

## 验收场景

1. v4 `createSession` 首发和已有会话的 `sendText` 均可将已提交图片的原始字节及 MIME 类型传给 fake omp；多图按输入顺序传递。
2. 混合图片与 PDF 时 omp 仅收到图片；无附件时不携带 `images` 字段。
3. 流式中的 `guide` 和 `queue` 输入继续分别使用 `steer` 与 `follow_up`，并携带所提交的图片。
