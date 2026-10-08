import type { ConversationProjection } from "../domain/conversationProjection.js";
import { createId } from "../domain/ids.js";
import { visibleOmpCustomDisplay } from "../domain/OmpCustomMessage.js";
import type { OmpCommandOutputRecord } from "../domain/OmpCommandOutput.js";
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
    // OMP custom-only 父会话可能未跨 assistant 落盘门；只保存实际缺失的可见显示事实。
    this.publish({
      id: createId("omp-custom-output"),
      text: visible.text,
      createdAt: Math.trunc(visible.timestamp ?? Date.now()),
      customType: visible.customType,
      ...(visible.timestamp !== undefined ? { nativeTimestamp: visible.timestamp } : {}),
    });
  };

  private publish(record: OmpCommandOutputRecord): void {
    this.host.projection().appendCommandOutput(record);
    void this.host.save?.(record, this.host.sessionPath()).catch(() => {
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
