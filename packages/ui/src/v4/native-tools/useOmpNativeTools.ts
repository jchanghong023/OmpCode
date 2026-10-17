import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ZCodeSlashCommand } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { logger } from "@/logger.js";
import { normalizeSlashCommandValue } from "@/slashCommandHelpers.js";

interface OmpNativeToolsAdmission {
  isCurrent: () => boolean;
  canSubmit: () => boolean;
}

export interface OmpNativeToolsSendOptions extends ConversationComposerSendOptions {
  nativeToolsAdmission?: OmpNativeToolsAdmission;
}

interface NativeToolsScope {
  key: string;
  generation: number;
  active: boolean;
}

interface UseOmpNativeToolsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  commands: readonly ZCodeSlashCommand[];
  unavailable: boolean;
  readComposerBusy: () => boolean;
  readSubmission: () => ComposerSubmissionConfig | null;
  sendText: (
    text: string,
    options?: OmpNativeToolsSendOptions,
  ) => Promise<ConversationComposerSendResult>;
}

function blockedReason(options: UseOmpNativeToolsOptions): string | null {
  const { snapshot, sessionId } = options;
  if (snapshot?.pendingInteractions.some((item) => item.payload.kind !== "workspaceHookReview")) {
    return "ompNativeTools.blocked.interaction";
  }
  if (snapshot?.inputRouting.mode === "choice") return "ompNativeTools.blocked.choice";
  if (snapshot?.control.phase === "running" || snapshot?.control.canStop) {
    return "ompNativeTools.blocked.running";
  }
  if (
    options.unavailable ||
    options.readComposerBusy() ||
    (sessionId !== null &&
      (snapshot?.sessionId !== sessionId || snapshot.inputRouting.mode !== "startNow"))
  ) {
    return "ompNativeTools.blocked.unavailable";
  }
  return null;
}

/** 工具窗口只拥有 admission，不拥有 Composer 草稿、附件或业务执行结果。 */
export function useOmpNativeTools(options: UseOmpNativeToolsOptions) {
  const scopeKey = JSON.stringify([
    options.workspaceIdentity?.trim() || options.workspacePath,
    options.workspacePath,
    options.remoteSessionId ?? null,
    options.sessionId,
  ]);
  const scopeRef = useRef<NativeToolsScope>({ key: scopeKey, generation: 0, active: true });
  if (scopeRef.current.key !== scopeKey) {
    // Bug 防护：按每次进入分配 token，不能只比较 key，否则 A→B→A 会接收旧 A 的 ACK。
    scopeRef.current.active = false;
    scopeRef.current = { key: scopeKey, generation: scopeRef.current.generation + 1, active: true };
  }
  const scope = scopeRef.current;
  const latest = useRef({ options, scope });
  latest.current = { options, scope };
  const [openScope, setOpenScope] = useState<NativeToolsScope | null>(null);
  const [pendingScope, setPendingScope] = useState<NativeToolsScope | null>(null);
  const flightRef = useRef<{ scope: NativeToolsScope } | null>(null);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (scopeRef.current !== scope || !scope.active) return;
      setOpenScope(open ? scope : null);
    },
    [scope],
  );
  const onOpen = useCallback(() => onOpenChange(true), [onOpenChange]);
  const onExecute = useCallback(
    async (text: string): Promise<ConversationComposerSendResult> => {
      const commandName = text.trimStart().startsWith("/")
        ? normalizeSlashCommandValue(text.trim().split(/\s/u, 1)[0] ?? "").toLowerCase()
        : "repo";
      const isCurrent = () => scope.active && scopeRef.current === scope;
      const canSubmit = () =>
        isCurrent() &&
        latest.current.scope === scope &&
        blockedReason(latest.current.options) === null &&
        latest.current.options.commands.some(
          (command) => normalizeSlashCommandValue(command.name).toLowerCase() === commandName,
        );
      if (!text.trim() || !canSubmit() || flightRef.current?.scope === scope) return "blocked";
      const submission = latest.current.options.readSubmission();
      if (!submission) return "blocked";
      // 同步 ref 先占位；React 尚未提交 disabled 时的第二次点击也必须被拒绝。
      const flight = { scope };
      flightRef.current = flight;
      setPendingScope(scope);
      const sendText = latest.current.options.sendText;
      const frozenText = text;
      const frozenSubmission: ComposerSubmissionConfig = Object.freeze({
        ...submission,
        modelSelection: Object.freeze({
          ...submission.modelSelection,
          ...(submission.modelSelection.options
            ? { options: Object.freeze({ ...submission.modelSelection.options }) }
            : {}),
        }),
      });
      // 先移除 modal，原生扩展的询问由既有 V4InteractionDialogs 接管，不能被壳遮住。
      flushSync(() => setOpenScope(null));
      try {
        const result = await sendText(frozenText, {
          submission: frozenSubmission,
          nativeToolsAdmission: { isCurrent, canSubmit },
        });
        return isCurrent() ? result : "blocked";
      } catch (error) {
        // 可见失败沿 handleSendText 的既有 banner；这里不伪造执行成功、不自动重试。
        logger.warn("[omp-native-tools] 提交未获接纳", { scope: scope.key, error });
        return "blocked";
      } finally {
        if (flightRef.current === flight) flightRef.current = null;
        if (isCurrent()) setPendingScope(null);
      }
    },
    [scope],
  );
  const reason = blockedReason(options);
  const pending = pendingScope === scope;
  return {
    scopeGeneration: scope.generation,
    open: openScope === scope,
    onOpen,
    onOpenChange,
    onExecute,
    disabled: pending || reason !== null,
    disabledReason: pending ? "ompNativeTools.blocked.submitting" : reason,
  };
}
