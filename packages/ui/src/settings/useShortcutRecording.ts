import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ShortcutCommandId } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { EffectiveShortcutBindings } from "@/shortcuts/bindings.js";
import { resolveRecordingKeydown } from "./recordingKeydown.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

interface UseShortcutRecordingOptions {
  recording: RecordingState | null;
  setRecording: Dispatch<SetStateAction<RecordingState | null>>;
  /** 生效绑定表（Section 已按 overrides resolve）。 */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** 录制态 Backspace：恢复默认（Section 的预检逻辑）。 */
  clearBinding: (commandId: ShortcutCommandId) => void;
  appendBinding: (commandId: ShortcutCommandId, binding: string) => void;
  replaceBindingAt: (commandId: ShortcutCommandId, bindingIndex: number, binding: string) => void;
}

/**
 * 录制态键盘捕获：window keydown capture。Escape 取消；Backspace 恢复默认；
 * 其余交给内核录制器。落盘按 RecordingState.mode 分派：add → 追加一条；replace → 替换
 * bindingIndex 指向的条（null = 未分配占位行录第一条，等价追加）。
 * 同命令物理等价重复在录制入口标红拒绝（add 比全部条目，replace 跳过目标条）。
 */
export function useShortcutRecording({
  recording,
  setRecording,
  effective,
  overrides,
  isDesktop,
  clearBinding,
  appendBinding,
  replaceBindingAt,
}: UseShortcutRecordingOptions): void {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!recording) {
      return;
    }
    function handleRecordingKeydown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      // 缺陷 F16 修复：原实现把 clearBinding/appendBinding/replaceBindingAt（内部
      // persistBindings 落盘）与 recordShortcutBinding 放进 setRecording 的 updater，
      // 而 React 要求 updater 纯，并发渲染（StrictMode）重放 updater 会重复落盘。
      // 现基于 effect 闭包的最新 recording 计算（deps 含 recording，离散按键事件之间
      // state 必然已提交），落盘在 setState 之外按 resolveRecordingKeydown 的返回值
      // 恰好执行一次；与 useGroupedTaskView 的「不在 updater 里做副作用」口径一致。
      const current = recording;
      if (!current) {
        return;
      }
      const { next, persist } = resolveRecordingKeydown(event, current, {
        formatMessage: intl.formatMessage,
        effective,
        overrides,
        isDesktop,
      });
      if (persist?.kind === "clear") {
        clearBinding(persist.commandId);
      } else if (persist?.kind === "append") {
        appendBinding(persist.commandId, persist.binding);
      } else if (persist?.kind === "replace") {
        replaceBindingAt(persist.commandId, persist.bindingIndex, persist.binding);
      }
      setRecording(next);
    }

    window.addEventListener("keydown", handleRecordingKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleRecordingKeydown, true);
    };
  }, [
    appendBinding,
    clearBinding,
    effective,
    intl,
    isDesktop,
    overrides,
    recording,
    replaceBindingAt,
    setRecording,
  ]);
}
