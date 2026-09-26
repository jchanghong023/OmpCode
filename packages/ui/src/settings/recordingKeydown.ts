import type { ShortcutCommandId } from "@zcode/shared";
import type { KeyboardShortcutPlatformInfo } from "@/lib/keyboardShortcuts.js";
import {
  type EffectiveShortcutBindings,
  type ShortcutBindingEvent,
  recordShortcutBinding,
} from "@/shortcuts/bindings.js";
import { checkShortcutBindingConflict, isSamePhysicalBinding } from "@/shortcuts/conflicts.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";
import type { RecordingState } from "./ShortcutBindingRow.js";

/** 录制态提示文案格式化（react-intl formatMessage 的结构化子集，纯函数单测可注入桩实现）。 */
export type RecordingMessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

export interface RecordingKeydownContext {
  formatMessage: RecordingMessageFormatter;
  /** 生效绑定表（Section 已按 overrides resolve）。 */
  effective: EffectiveShortcutBindings;
  overrides: Record<string, readonly string[]> | undefined;
  isDesktop: boolean;
  /** 缺省读运行时 navigator（单测显式传入以固定平台语义）。 */
  platformInfo?: KeyboardShortcutPlatformInfo;
}

/** 一次录制按键触发的落盘动作（必须由调用方在 setState updater 之外恰好执行一次）。 */
export type RecordingPersistAction =
  | { kind: "clear"; commandId: ShortcutCommandId }
  | { kind: "append"; commandId: ShortcutCommandId; binding: string }
  | { kind: "replace"; commandId: ShortcutCommandId; bindingIndex: number; binding: string };

export interface RecordingKeydownOutcome {
  /** 计算后的新录制态；null = 退出录制。 */
  next: RecordingState | null;
  /** 落盘动作；null = 本按键无副作用。 */
  persist: RecordingPersistAction | null;
}

/**
 * 录制态单次按键的纯决策（缺陷 F16 修复的抽取）。
 *
 * 原实现把这段逻辑连同 clearBinding/appendBinding/replaceBindingAt（内部 persistBindings
 * 落盘）一起放进 setRecording 的 updater；React 要求 updater 纯，并发渲染（StrictMode）
 * 重放 updater 会把落盘执行多次。本函数只做计算并返回新状态与落盘动作，落盘由
 * useShortcutRecording 在 setState 之外按返回值执行，与 useGroupedTaskView 的
 * 「不在 updater 里做副作用」口径一致。
 *
 * 语义与迁出前完全等价：Escape 取消；Backspace 恢复默认；其余交给内核录制器，按
 * RecordingState.mode 分派：add → 追加一条；replace → 替换 bindingIndex 指向的条
 * （null = 未分配占位行录第一条，等价追加）。同命令物理等价重复在录制入口标红拒绝
 * （add 比全部条目，replace 跳过目标条）。
 */
export function resolveRecordingKeydown(
  event: ShortcutBindingEvent,
  current: RecordingState,
  context: RecordingKeydownContext,
): RecordingKeydownOutcome {
  const { formatMessage, effective, overrides, isDesktop, platformInfo } = context;

  if (event.key === "Escape") {
    return { next: null, persist: null };
  }
  if (event.key === "Backspace") {
    return { next: null, persist: { kind: "clear", commandId: current.commandId } };
  }

  const result = recordShortcutBinding(event, platformInfo);
  if (result.kind === "pending") {
    // 残留的冲突/无效提示会让人以为录制器没在听新按键 —— 修饰键按下即刻清空，
    // 保证「冲突后直接重按第二组组合」在视觉上是活的（实际本来就一直监听着）。
    if (current.preview === null && current.error === null && current.conflictBinding === null) {
      return { next: current, persist: null };
    }
    return {
      next: { ...current, preview: null, error: null, conflictBinding: null },
      persist: null,
    };
  }
  if (result.kind === "invalid") {
    return {
      next: {
        ...current,
        preview: null,
        conflictBinding: null,
        error: formatMessage({
          id:
            result.reason === "no-modifier"
              ? "settings.shortcuts.invalidNoModifier"
              : "settings.shortcuts.invalidKey",
        }),
      },
      persist: null,
    };
  }

  // 同命令物理等价重复：add 与全部生效条目比；replace 跳过正在替换的
  // 目标条。一个命令挂同一组键没有意义，直接标红拒绝。
  const sameCommandBindings = effective[current.commandId] ?? [];
  const duplicate = sameCommandBindings.some((binding, index) =>
    current.mode === "replace" && index === current.bindingIndex
      ? false
      : isSamePhysicalBinding(binding, result.binding, { platformInfo }),
  );
  if (duplicate) {
    return {
      next: {
        ...current,
        preview: formatShortcutBindingLabel(result.binding, platformInfo),
        conflictBinding: null,
        error: formatMessage({ id: "settings.shortcuts.duplicateBinding" }),
      },
      persist: null,
    };
  }

  // Web 端 menu 通道命令不可配置但默认键仍被根级回退监听消费，按保留键拒绝抢绑
  const conflict = checkShortcutBindingConflict(current.commandId, result.binding, overrides, {
    menuChannelReserved: !isDesktop,
    platformInfo,
  });
  if (conflict) {
    return {
      next: {
        ...current,
        preview: formatShortcutBindingLabel(result.binding, platformInfo),
        // 系统保留键直接拒绝（无确认入口）；app 内命令占用提示占用者并支持二次确认抢绑
        conflictBinding: conflict.kind === "occupied" ? result.binding : null,
        error:
          conflict.kind === "reserved"
            ? formatMessage({ id: "settings.shortcuts.conflictReserved" })
            : formatMessage(
                { id: "settings.shortcuts.conflictOccupied" },
                {
                  command:
                    conflict.ownerCommandId !== undefined
                      ? formatMessage({
                          id: `settings.shortcuts.command.${conflict.ownerCommandId}`,
                        })
                      : "",
                },
              ),
      },
      persist: null,
    };
  }

  if (current.mode === "add" || current.bindingIndex === null) {
    return {
      next: null,
      persist: { kind: "append", commandId: current.commandId, binding: result.binding },
    };
  }
  return {
    next: null,
    persist: {
      kind: "replace",
      commandId: current.commandId,
      bindingIndex: current.bindingIndex,
      binding: result.binding,
    },
  };
}
