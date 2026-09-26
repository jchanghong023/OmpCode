import assert from "node:assert/strict";
import test from "node:test";
import type { RecordingState } from "../src/settings/ShortcutBindingRow.js";
import {
  resolveRecordingKeydown,
  type RecordingKeydownContext,
  type RecordingKeydownOutcome,
} from "../src/settings/recordingKeydown.js";

// 固定非 apple 平台语义：CmdOrCtrl = Ctrl（与录制器在 win/linux 的产物一致），
// 避免 node 环境的 navigator.platform 差异影响断言。
const WIN_PLATFORM = { platform: "Win32" };

function makeRecording(overrides: Partial<RecordingState> = {}): RecordingState {
  return {
    commandId: "openSettings",
    mode: "replace",
    bindingIndex: null,
    preview: null,
    error: null,
    conflictBinding: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RecordingKeydownContext> = {}): RecordingKeydownContext {
  return {
    formatMessage: (descriptor, values) =>
      values?.command ? `${descriptor.id}:${values.command}` : descriptor.id,
    // 生效表只参与同命令重复判定；按需手写即可，其余命令的默认键由冲突检测走命令表。
    effective: {
      openSettings: ["CmdOrCtrl+,"],
      findInTask: ["CmdOrCtrl+f"],
    } as RecordingKeydownContext["effective"],
    overrides: undefined,
    isDesktop: true,
    platformInfo: WIN_PLATFORM,
    ...overrides,
  };
}

function keydown(key: string, code?: string, modifiers?: Partial<{ ctrl: boolean }>) {
  return {
    key,
    ...(code !== undefined ? { code } : {}),
    metaKey: false,
    ctrlKey: modifiers?.ctrl === true,
    shiftKey: false,
    altKey: false,
  };
}

test("Escape 取消、Backspace 恢复默认都不落盘到绑定表（Backspace 只产出 clear 指令）", () => {
  const current = makeRecording();
  const context = makeContext();

  const escape = resolveRecordingKeydown(keydown("Escape"), current, context);
  assert.equal(escape.next, null);
  assert.equal(escape.persist, null);

  const backspace = resolveRecordingKeydown(keydown("Backspace"), current, context);
  assert.equal(backspace.next, null);
  assert.deepEqual(backspace.persist, { kind: "clear", commandId: "openSettings" });
});

test("无修饰键的普通键标红无效且不落盘", () => {
  const outcome = resolveRecordingKeydown(keydown("g", "KeyG"), makeRecording(), makeContext());

  assert.equal(outcome.persist, null);
  assert.equal(outcome.next?.error, "settings.shortcuts.invalidNoModifier");
  assert.equal(outcome.next?.preview, null);
  // 无效按键不退出录制态
  assert.equal(outcome.next?.commandId, "openSettings");
});

test("同命令物理等价重复拒绝；replace 跳过目标条后允许落盘", () => {
  const context = makeContext();

  // add 模式与全部生效条目比：Ctrl+f 物理等价于已有 CmdOrCtrl+f，拒绝且不落盘
  const duplicate = resolveRecordingKeydown(
    keydown("f", "KeyF", { ctrl: true }),
    makeRecording({ commandId: "findInTask", mode: "add", bindingIndex: null }),
    context,
  );
  assert.equal(duplicate.persist, null);
  assert.equal(duplicate.next?.error, "settings.shortcuts.duplicateBinding");

  // replace 模式跳过正被替换的目标条（下标 0）：对同一条重录同键不构成重复，落盘 replace
  const replaceTarget = resolveRecordingKeydown(
    keydown(",", "Comma", { ctrl: true }),
    makeRecording({ mode: "replace", bindingIndex: 0 }),
    context,
  );
  assert.deepEqual(replaceTarget.persist, {
    kind: "replace",
    commandId: "openSettings",
    bindingIndex: 0,
    binding: "CmdOrCtrl+,",
  });
  assert.equal(replaceTarget.next, null);
});

test("保留键与占用键都只标红不落盘；占用提示带占用命令文案", () => {
  const context = makeContext();

  // Ctrl+r = 保留键（刷新），无抢绑入口
  const reserved = resolveRecordingKeydown(
    keydown("r", "KeyR", { ctrl: true }),
    makeRecording(),
    context,
  );
  assert.equal(reserved.persist, null);
  assert.equal(reserved.next?.error, "settings.shortcuts.conflictReserved");
  assert.equal(reserved.next?.conflictBinding, null);
  assert.equal(reserved.next?.preview, "Ctrl+R");

  // Ctrl+m 被 openModelMenu 占用（物理等价归一：CmdOrCtrl+m ≡ Ctrl+m），给出二次确认入口
  const occupied = resolveRecordingKeydown(
    keydown("m", "KeyM", { ctrl: true }),
    makeRecording(),
    context,
  );
  assert.equal(occupied.persist, null);
  assert.equal(occupied.next?.conflictBinding, "CmdOrCtrl+m");
  assert.equal(
    occupied.next?.error,
    "settings.shortcuts.conflictOccupied:settings.shortcuts.command.openModelMenu",
  );
});

test("连按序列：整段录制只产生一次落盘，最终绑定正确", () => {
  const context = makeContext();
  let current = makeRecording({ mode: "replace", bindingIndex: 0 });
  let persistCount = 0;
  let lastPersist: RecordingKeydownOutcome["persist"] = null;

  // 模拟 useShortcutRecording 的新接线：每次按键解析一次决策，persist 至多执行一次
  const apply = (key: string, code?: string, modifiers?: Partial<{ ctrl: boolean }>) => {
    const outcome = resolveRecordingKeydown(keydown(key, code, modifiers), current, context);
    if (outcome.persist !== null) {
      persistCount += 1;
      lastPersist = outcome.persist;
    }
    current = outcome.next ?? current;
    return outcome;
  };

  apply("g", "KeyG"); // 无修饰键 → 标红
  apply("m", "KeyM", { ctrl: true }); // 占用冲突 → 标红
  apply("r", "KeyR", { ctrl: true }); // 保留键 → 拒绝
  apply("Control"); // 修饰键 → 清残留提示
  assert.equal(current.conflictBinding, null);
  assert.equal(current.error, null);

  const final = apply("q", "KeyQ", { ctrl: true }); // 唯一合法组合 → 落盘并退出

  // 缺陷 F16 的验收口径：同一次录制会话（同一按键序列）下持久化恰好一次
  assert.equal(persistCount, 1);
  assert.deepEqual(lastPersist, {
    kind: "replace",
    commandId: "openSettings",
    bindingIndex: 0,
    binding: "CmdOrCtrl+q",
  });
  assert.equal(final.next, null);
});

test("未分配占位行（bindingIndex null）按追加落盘", () => {
  const outcome = resolveRecordingKeydown(
    keydown("q", "KeyQ", { ctrl: true }),
    makeRecording({ commandId: "findInTask", mode: "replace", bindingIndex: null }),
    makeContext(),
  );

  assert.deepEqual(outcome.persist, {
    kind: "append",
    commandId: "findInTask",
    binding: "CmdOrCtrl+q",
  });
  assert.equal(outcome.next, null);
});
