import type { ConversationProjection } from "../domain/conversationProjection.js";
import { createId } from "../domain/ids.js";
import { visibleOmpCustomDisplay } from "../domain/OmpCustomMessage.js";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";
import { diagnostics } from "./diagnostics.js";
// 日志依赖需追加，不能替换构造参数仍使用的类型导入。
import type { EngineInit } from "./engineInit.js";

/** 命令显示事实桥：投影仍是唯一行/seq owner，IO 只经注入存储端口。 */
export class OmpCommandOutputBridge {
  constructor(
    private readonly host: {
      projection: () => ConversationProjection;
      sessionPath: () => string | null;
      save: EngineInit["onCommandOutput"];
      flush: EngineInit["flushCommandOutputs"];
      scheduleFlush: () => void;
      refresh?: () => void;
    },
  ) {}

  emit = ({ text }: { text: string }): void => {
    // ACK 后、多轮之间仍可输出；不借当前模型轮，空白与段落按原帧保留。
    const record = { id: createId("omp-command-output"), text, createdAt: Date.now() };
    this.publish(record);
  };

  custom = (message: unknown): void => {
    const visible = visibleOmpCustomDisplay(message);
    if (!visible) return;
    // 原生事件可早于已发布的完成提示；显示用接纳时间，原生时间只供 journal 因果匹配。
    this.publish({
      id: createId("omp-custom-output"),
      text: visible.text,
      createdAt: Date.now(),
      customType: visible.customType,
      ...(visible.timestamp !== undefined ? { nativeTimestamp: visible.timestamp } : {}),
    });
  };

  private publish(record: OmpCommandOutputRecord): void {
    this.host.projection().appendCommandOutput(record);
    void this.host.save?.(record, this.host.sessionPath()).catch((error: unknown) => {
      diagnostics.warn("omp.command_output.persist.failed", {
        failureStage: "history_save",
        errorType: error instanceof Error ? error.name : typeof error,
      });
      const projection = this.host.projection();
      projection.patchSideViewState({
        control: {
          ...projection.stateSnapshot.control,
          lastError: {
            code: "omp_command_history_save",
            message: "命令显示历史保存失败",
            recoverable: true,
            source: "runtime",
            at: Date.now(),
          },
        },
      });
      this.host.scheduleFlush();
    });
    // 输出是背景命令的新事实；复用合并状态回读，不把 ACK 当作压缩完成。
    this.host.refresh?.();
    this.host.scheduleFlush();
  }

  async flush(): Promise<void> {
    await this.host.flush?.();
  }
}
