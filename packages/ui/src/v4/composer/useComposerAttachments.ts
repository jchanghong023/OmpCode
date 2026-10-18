/* oxlint-disable eslint(max-lines) -- 附件采集、分 scope 上传调度和生命周期必须在同一 hook 中原子收口。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { nanoid } from "nanoid";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import {
  MAX_CHAT_ATTACHMENTS,
  MissingInlinePdfContentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  createChatComposerAttachment,
  createChatComposerPathAttachment,
  createClipboardTextAttachmentFilenameForDate,
  createClipboardTextPathComposerAttachment,
  formatAttachmentSize,
  revokeChatComposerAttachment,
  serializeChatComposerAttachment,
  shouldCreateClipboardTextAttachment,
  shouldPreferSpreadsheetClipboardText,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import {
  WHITEBOARD_ADD_TO_CHAT_EVENT,
  buildWhiteboardWorkspaceKey,
  createWhiteboardPngFile,
  isWhiteboardAddToChatEvent,
} from "@/lib/whiteboard.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import type { ChatComposerPasteEvent } from "@/LexicalChatInput.js";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  exposeComposerAttachmentScopeKeyForE2E,
  promoteComposerAttachmentScope,
  readComposerAttachmentScope,
  resolveComposerAttachmentOperationScope,
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
  type ComposerAttachmentUploadItem,
} from "@/store/composerAttachmentUploadStore.js";
import { uploadComposerAttachment, type AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { resolveSharedComposerDraftScope } from "@/v4/composer/composerDraftRegistry.js";

const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
const COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS = 500;
const COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS = 300;
/**
 * 换代重传的兜底上限。dev 实测同一 workspace 可达 runtimeGeneration=4（3 次换代），
 * 取 5 留余量；它只防 Helper 反复崩溃时的无限重传，正常使用不该触达。
 */
const COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT = 5;
const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachmentUploadItem[] = [];
const REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE = "remoteAttachmentNotStaged";

interface UploadTarget {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachmentPut: AttachmentPutFn;
  transferService: IPromptAttachmentTransferService;
}

interface UploadQueueEntry {
  scopeKey: string;
  attachmentId: string;
  operationId: string;
}

export interface ComposerAttachmentsApi {
  attachments: ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  hasAttachments: boolean;
  hasUnreadyAttachments: boolean;
  composerDragKind: "attachment" | "workspace" | null;
  isDraggingOverComposer: boolean;
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  openAttachmentPicker: () => void;
  handleAttachmentInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: ChatComposerPasteEvent) => void;
  handleDragOverComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDragLeaveComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDropComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleWhiteboardMentionSelected: (boardId: string) => Promise<void>;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  /** 发送成功只清冻结的附件 id；不传表示用户主动清空整个附件区。 */
  clearAttachments: (
    attachmentIds?: readonly string[],
    options?: { preserveError?: boolean },
  ) => void;
  /** 把已由 session 接管的 queue refs 原样恢复为 ready chips；不触发 upload/adopt。 */
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  /** 只返回已 ready ref；任一附件未就绪时返回 null 作 submit 二次门禁。 */
  prepareForSend: () => Promise<AttachmentRef[] | null>;
  /** sendText accepted 后才移交远端暂存内容，发送失败时仍由草稿持有。 */
  adoptSentAttachments: (attachmentIds: readonly string[]) => Promise<void>;
  setAttachmentError: (message: string | null) => void;
  /** 仅由真实 accepted 的原生首发调用；保留未提交附件，不向命令传 ref、不 adopt。 */
  promoteUnsubmittedAttachments: (sessionId: string) => void;
}

interface UseComposerAttachmentsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  scopeId: string;
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /**
   * 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。
   * unavailable 在 workspace-dispose 当场到达，把作废与唤醒拆到两个真实时点。
   */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  disabled?: boolean;
  /**
   * 是否消费全局 add-to-chat 事件（whiteboard 引用）。
   * 语义与 useWebElementContexts 等一致：由调用方传 `listenAddToChatEvents && !disabled`
   * （SessionPane 以 focused 区分聚焦 composer）。SidePane forceMount 常驻多个同
   * workspace 的 SessionPane，若不门控，一次白板引用会被所有 composer 同时
   * preventDefault 并各自注入附件，用户看不见的后台草稿被静默塞入画板内容。
   */
  listenAddToChatEvents?: boolean;
}

async function selectAttachmentLocalPaths(
  platform: Pick<IPlatformService, "selectFile" | "selectFiles">,
): Promise<string[]> {
  const selectedPaths = platform.selectFiles
    ? await platform.selectFiles()
    : await platform.selectFile().then((selectedPath) => (selectedPath ? [selectedPath] : []));
  return selectedPaths.filter((path) => path.trim().length > 0);
}

function buildScopeKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}\u0000${scopeId}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && error.cause !== undefined ? isAbortError(error.cause) : false;
}

class RemoteAttachmentNotStagedError extends Error {
  readonly code = REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE;
}

function isTransientAttachmentUploadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof OversizedInlineVideoAttachmentError) return false;
  if (error instanceof OversizedInlinePdfAttachmentError) return false;
  if (error instanceof MissingInlinePdfContentError) return false;
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  // video 超限错误必须在黑名单里，否则会触发一次无意义重试；按错误类型精确拦截，
  // 避免扩大 message 正则后改变 image 超限的既有判定。
  return !/(?:payloadTooLarge|invalidBase64|invalidServerProgress|frameTooLarge|permission|EACCES|ENOENT|not found|unsupported|附件缺少|缺少可读取内容|远端附件未完成物化)/iu.test(
    message,
  );
}

function progressPercent(uploadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(99, Math.max(0, Math.floor((uploadedBytes / totalBytes) * 99)));
}

function isRemoteAttachmentTarget(
  target: Pick<UploadTarget, "remoteSessionId" | "workspaceIdentity">,
) {
  // 这里曾要求 workspaceIdentity 能被当前解析器识别。远端 identity 新增格式或
  // 暂时非规范时，在 remoteSessionId 注入前会被误判为本地 workspace，使 host localPath
  // 直接走零复制交给远端 Agent。identity 只承担隔离语义；任意非空值都必须按远端 fail closed。
  return Boolean(target.remoteSessionId?.trim() || target.workspaceIdentity?.trim());
}

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachmentsApi {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId,
    attachmentSessionId = null,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled = false,
    listenAddToChatEvents = true,
  } = options;
  const platform = usePlatform();
  const { promptAttachmentTransferService, fileService } = useServices();
  const { intl } = useZCodeIntl();
  const canonicalScopeId = resolveSharedComposerDraftScope({
    workspacePath,
    workspaceIdentity,
    scopeId,
  });
  const scopeKey = buildScopeKey(workspacePath, workspaceIdentity, canonicalScopeId);
  exposeComposerAttachmentScopeKeyForE2E(scopeKey);
  const pickerScope = useMemo(() => ({ active: true }), [scopeKey]);
  const currentPickerScopeRef = useRef(pickerScope);
  currentPickerScopeRef.current = pickerScope;
  useEffect(() => {
    pickerScope.active = true;
    return () => {
      pickerScope.active = false;
    };
  }, [pickerScope]);

  const targetsRef = useRef(new Map<string, UploadTarget>());
  const uploadQueueRef = useRef<UploadQueueEntry[]>([]);
  const activeUploadsRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const completeTimersRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, number>());
  // ID 是一次附件的身份；scope 只是显示归属。promotion 后旧闭包仍操作同一个附件，
  // 但不能把整桶 scope 做别名，否则 A→B→A 的新草稿会被旧上传/ACK 写入。
  const attachmentScopesRef = useRef(new Map<string, string>());
  const attachmentOperationsRef = useRef(new Map<string, string>());
  const pumpQueueRef = useRef<() => void>(() => {});
  const attachments = useComposerAttachmentUploadStore(
    (state) => state.scopes[scopeKey] ?? EMPTY_COMPOSER_ATTACHMENTS,
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * runtime 换代计数。换代后 attachmentSessionId 可能原地不变（正式会话由 cold-resume 恢复），
   * 只靠它做依赖会漏掉唤醒，附件将永久停在 waitingSession。
   */
  const [restartEpoch, setRestartEpoch] = useState(0);
  const [composerDragKind, setComposerDragKind] = useState<"attachment" | "workspace" | null>(null);
  const isDraggingOverComposer = composerDragKind !== null;
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const dragFeedbackTimerRef = useRef<number | null>(null);

  targetsRef.current.set(scopeKey, {
    sessionId: attachmentSessionId
      ? resolveSharedComposerDraftScope({
          workspacePath,
          workspaceIdentity,
          scopeId: attachmentSessionId,
        })
      : null,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    attachmentPut,
    transferService: promptAttachmentTransferService,
  });

  const commitScope = useCallback(
    (
      targetScopeKey: string,
      update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
    ) => {
      updateComposerAttachmentScope(targetScopeKey, update);
    },
    [],
  );

  const updateItem = useCallback(
    (
      targetScopeKey: string,
      attachmentId: string,
      update: (item: ComposerAttachmentUploadItem) => ComposerAttachmentUploadItem,
      operationId = attachmentOperationsRef.current.get(attachmentId),
    ) => {
      const originalScopeKey = attachmentScopesRef.current.get(attachmentId) ?? targetScopeKey;
      const ownerScopeKey = operationId
        ? resolveComposerAttachmentOperationScope(originalScopeKey, operationId)
        : originalScopeKey;
      commitScope(ownerScopeKey, (current) => {
        if (
          !current.some(
            (item) =>
              item.id === attachmentId && (!operationId || item.operationId === operationId),
          )
        )
          return current;
        return current.map((item) =>
          item.id === attachmentId && (!operationId || item.operationId === operationId)
            ? update(item)
            : item,
        );
      });
    },
    [commitScope],
  );

  // The scoped draft remains the sole owner. Native selection has no browser File
  // or object URL; hydrate only its display URL through the existing preview port.
  const nativeImagePreviewIds = attachments
    .filter((item) => !item.file && item.localPath && item.mimeType.startsWith("image/"))
    .map((item) => item.id)
    .join(" ");
  useEffect(() => {
    let disposed = false;
    const ids = new Set(nativeImagePreviewIds.split(" "));
    for (const item of readComposerAttachmentScope(scopeKey)) {
      if (!ids.has(item.id) || item.objectUrl || !item.localPath) continue;
      void fileService
        .readMediaPreview({ path: item.localPath })
        .then((preview) => {
          if (disposed || !preview.mediaType.startsWith("image/")) return;
          commitScope(scopeKey, (current) =>
            current.map((candidate) =>
              candidate.id === item.id &&
              candidate.operationId === item.operationId &&
              candidate.localPath === item.localPath &&
              !candidate.objectUrl
                ? {
                    ...candidate,
                    // Data URLs need no resource lease/revoke and follow the
                    // existing draft's retention/removal lifecycle.
                    objectUrl: `data:${preview.mediaType};base64,${preview.dataBase64}`,
                  }
                : candidate,
            ),
          );
        })
        .catch((error: unknown) => {
          if (!disposed) logger.warn("[v4-composer-attachments] 读取图片缩略图失败", error);
        });
    }
    return () => {
      disposed = true;
    };
  }, [commitScope, fileService, nativeImagePreviewIds, scopeKey]);

  const enqueueUpload = useCallback(
    (targetScopeKey: string, attachmentId: string, expectedOperationId?: string) => {
      const originalScopeKey = attachmentScopesRef.current.get(attachmentId) ?? targetScopeKey;
      const operationId = expectedOperationId ?? attachmentOperationsRef.current.get(attachmentId);
      const ownerScopeKey = operationId
        ? resolveComposerAttachmentOperationScope(originalScopeKey, operationId)
        : originalScopeKey;
      const item = readComposerAttachmentScope(ownerScopeKey).find(
        (entry) =>
          entry.id === attachmentId &&
          (!expectedOperationId || entry.operationId === expectedOperationId),
      );
      if (!item) return;
      attachmentOperationsRef.current.set(attachmentId, item.operationId);
      attachmentScopesRef.current.set(attachmentId, ownerScopeKey);
      const exists = uploadQueueRef.current.some((entry) => entry.operationId === item.operationId);
      if (!exists)
        uploadQueueRef.current.push({
          scopeKey: ownerScopeKey,
          attachmentId,
          operationId: item.operationId,
        });
      queueMicrotask(() => pumpQueueRef.current());
    },
    [],
  );

  const finishWithReady = useCallback(
    (
      targetScopeKey: string,
      attachmentId: string,
      operationId: string,
      ref: AttachmentRef,
      staged: boolean,
    ) => {
      updateItem(
        targetScopeKey,
        attachmentId,
        (item) => ({
          ...item,
          uploadStatus: "ready",
          uploadProgress: 100,
          uploadError: undefined,
          uploadErrorKind: undefined,
          attachmentRef: ref,
          staged,
          showComplete: !item.localZeroCopy,
        }),
        operationId,
      );
      const timerKey = attachmentId;
      const previousTimer = completeTimersRef.current.get(timerKey);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        completeTimersRef.current.delete(timerKey);
        updateItem(
          targetScopeKey,
          attachmentId,
          (item) => ({
            ...item,
            showComplete: false,
          }),
          operationId,
        );
      }, COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS);
      completeTimersRef.current.set(timerKey, timer);
    },
    [updateItem],
  );

  const runUpload = useCallback(
    async (
      targetScopeKey: string,
      attachmentId: string,
      operationId: string,
      target: UploadTarget,
    ) => {
      const controllerKey = attachmentId;
      const controller = new AbortController();
      controllersRef.current.set(controllerKey, controller);
      updateItem(
        targetScopeKey,
        attachmentId,
        (item) => ({
          ...item,
          uploadStatus: "uploading",
          uploadProgress: Math.min(item.uploadProgress, 99),
          uploadError: undefined,
          uploadErrorKind: undefined,
        }),
        operationId,
      );
      // operation 的 lease 随异步上传存活，不随 pane 卸载释放。全局迁移/目标冲突
      // 只通过唯一 store 改所有权；仍被规范 scope 持有的同一 operation 不能 abort。
      const releaseOperationLease = useComposerAttachmentUploadStore.subscribe(() => {
        const ownerScope = resolveComposerAttachmentOperationScope(targetScopeKey, operationId);
        if (
          !readComposerAttachmentScope(ownerScope).some(
            (item) => item.operationId === operationId,
          ) &&
          controllersRef.current.get(controllerKey) === controller
        ) {
          controllersRef.current.delete(controllerKey);
          controller.abort();
        }
      });
      let progressSubscription: { dispose(): void } | null = null;
      try {
        const item = readComposerAttachmentScope(
          resolveComposerAttachmentOperationScope(targetScopeKey, operationId),
        ).find(
          (candidate) => candidate.id === attachmentId && candidate.operationId === operationId,
        );
        if (!item || !target.sessionId) return;
        if (item.localPath && isRemoteAttachmentTarget(target)) {
          if (!target.remoteSessionId) {
            updateItem(
              targetScopeKey,
              attachmentId,
              (current) => ({
                ...current,
                uploadStatus: "waitingSession",
              }),
              operationId,
            );
            return;
          }
          progressSubscription = target.transferService.onDynamicProgress(item.operationId)(
            (progress) => {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(
                targetScopeKey,
                attachmentId,
                (current) => ({
                  ...current,
                  uploadStatus:
                    progress.phase === "committing" ? "committing" : current.uploadStatus,
                  uploadProgress: Math.max(
                    current.uploadProgress,
                    progressPercent(progress.uploadedBytes, progress.totalBytes),
                  ),
                }),
                operationId,
              );
            },
          );
          const result = await target.transferService.stage({
            operationId: item.operationId,
            sessionId: target.sessionId,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            remoteSessionId: target.remoteSessionId,
            localPath: item.localPath,
            fileName: item.filename,
            mime: item.mimeType,
            sizeBytes: item.sizeBytes,
          });
          if (controllersRef.current.get(controllerKey) !== controller) return;
          // 远端 ServiceAccessor 曾错误注入本地 transfer service，并返回
          // staged:false + host localPath。远端 Agent 无法读取该路径，因此必须阻止发送。
          if (!result.staged) {
            throw new RemoteAttachmentNotStagedError(
              intl.formatMessage({
                id: "chat.attachments.upload.remoteMaterializationRequired",
              }),
            );
          }
          finishWithReady(
            targetScopeKey,
            attachmentId,
            operationId,
            {
              ref: result.ref,
              fileName: item.filename,
              mime: item.mimeType,
              bytes: result.bytes,
            },
            result.staged,
          );
          return;
        }

        const serialized = await serializeChatComposerAttachment(item, {
          // 底层序列化边界不拼用户可见文案（chatAttachments 序列化边界约定），
          // 截断标记由 UI 层按当前 locale 传入；传标记而不是让序列化抛错，
          // 是为了保留"前 64K 内容仍可发送"的截断语义，而不是整体拒绝附件。
          truncatedTextMarker: intl.formatMessage({ id: "chat.attachments.truncated" }),
        });
        const ref = await uploadComposerAttachment(
          target.attachmentPut,
          target.sessionId,
          serialized,
          {
            signal: controller.signal,
            onProgress(progress) {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(
                targetScopeKey,
                attachmentId,
                (current) => ({
                  ...current,
                  uploadStatus: progress.phase === "committing" ? "committing" : "uploading",
                  uploadProgress: Math.max(
                    current.uploadProgress,
                    progressPercent(progress.uploadedBytes, progress.totalBytes),
                  ),
                }),
                operationId,
              );
            },
          },
        );
        if (!ref) throw new Error("附件缺少可读取内容");
        if (controllersRef.current.get(controllerKey) !== controller) return;
        finishWithReady(targetScopeKey, attachmentId, operationId, ref, false);
      } catch (error) {
        if (controllersRef.current.get(controllerKey) !== controller || controller.signal.aborted) {
          return;
        }
        const current = readComposerAttachmentScope(
          resolveComposerAttachmentOperationScope(targetScopeKey, operationId),
        ).find(
          (candidate) => candidate.id === attachmentId && candidate.operationId === operationId,
        );
        if (!current) return;
        // 结构化超限错误在 UI 层按 locale 格式化（与 chatAttachments 序列化边界约定一致）。
        const message =
          error instanceof OversizedInlineVideoAttachmentError
            ? intl.formatMessage(
                { id: "chat.attachments.oversizedInlineVideo" },
                {
                  filename: error.filename,
                  size: formatAttachmentSize(error.sizeBytes),
                  maxSize: formatAttachmentSize(error.maxSizeBytes),
                },
              )
            : error instanceof OversizedInlinePdfAttachmentError
              ? intl.formatMessage(
                  { id: "chat.attachments.oversizedInlinePdf" },
                  {
                    filename: error.filename,
                    size: formatAttachmentSize(error.sizeBytes),
                    maxSize: formatAttachmentSize(error.maxSizeBytes),
                  },
                )
              : error instanceof MissingInlinePdfContentError
                ? intl.formatMessage(
                    { id: "chat.attachments.missingInlinePdfContent" },
                    { filename: error.filename },
                  )
                : error instanceof Error
                  ? error.message
                  : String(error);
        const transient = isTransientAttachmentUploadError(error);
        if (transient && current.autoRetryCount < 1) {
          updateItem(
            targetScopeKey,
            attachmentId,
            (item) => ({
              ...item,
              uploadStatus: "queued",
              uploadProgress: 0,
              uploadError: message,
              uploadErrorKind: "transient",
              autoRetryCount: item.autoRetryCount + 1,
            }),
            operationId,
          );
          const timerKey = attachmentId;
          const timer = window.setTimeout(() => {
            retryTimersRef.current.delete(timerKey);
            enqueueUpload(targetScopeKey, attachmentId, operationId);
          }, COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS);
          retryTimersRef.current.set(timerKey, timer);
        } else {
          updateItem(
            targetScopeKey,
            attachmentId,
            (item) => ({
              ...item,
              uploadStatus: "failed",
              uploadProgress: Math.min(item.uploadProgress, 99),
              uploadError: message,
              uploadErrorKind: transient ? "transient" : "permanent",
            }),
            operationId,
          );
          logger.warn("[v4-composer-attachments] 附件上传失败", {
            attachmentId,
            error: message,
            scopeKey: targetScopeKey,
          });
        }
      } finally {
        releaseOperationLease();
        progressSubscription?.dispose();
        if (controllersRef.current.get(controllerKey) === controller) {
          controllersRef.current.delete(controllerKey);
        }
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
        pumpQueueRef.current();
      }
    },
    [enqueueUpload, finishWithReady, intl, updateItem],
  );

  const pumpQueue = useCallback(() => {
    while (
      activeUploadsRef.current < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY &&
      uploadQueueRef.current.length > 0
    ) {
      const entry = uploadQueueRef.current.shift();
      if (!entry) break;
      const originalScopeKey = entry.scopeKey;
      entry.scopeKey = resolveComposerAttachmentOperationScope(entry.scopeKey, entry.operationId);
      const item = readComposerAttachmentScope(entry.scopeKey).find(
        (candidate) =>
          candidate.id === entry.attachmentId && candidate.operationId === entry.operationId,
      );
      if (!item || (item.uploadStatus !== "queued" && item.uploadStatus !== "waitingSession")) {
        continue;
      }
      let target = targetsRef.current.get(entry.scopeKey);
      if (!target && entry.scopeKey !== originalScopeKey) {
        const previousTarget = targetsRef.current.get(originalScopeKey);
        if (previousTarget) {
          target = {
            ...previousTarget,
            sessionId: entry.scopeKey.slice(entry.scopeKey.lastIndexOf("\u0000") + 1),
          };
          targetsRef.current.set(entry.scopeKey, target);
        }
      }
      const waitingForRemoteSession = Boolean(
        target && item.localPath && isRemoteAttachmentTarget(target) && !target.remoteSessionId,
      );
      if (!target?.sessionId || waitingForRemoteSession) {
        updateItem(entry.scopeKey, entry.attachmentId, (current) => ({
          ...current,
          uploadStatus: "waitingSession",
        }));
        continue;
      }
      activeUploadsRef.current += 1;
      void runUpload(entry.scopeKey, entry.attachmentId, entry.operationId, target);
    }
  }, [runUpload, updateItem]);
  pumpQueueRef.current = pumpQueue;

  useEffect(() => {
    const current = readComposerAttachmentScope(scopeKey);
    const remoteTargetReady =
      !isRemoteAttachmentTarget({ remoteSessionId, workspaceIdentity }) || Boolean(remoteSessionId);
    if (attachmentSessionId && remoteTargetReady) {
      for (const item of current) {
        if (
          item.uploadStatus === "waitingSession" ||
          (item.uploadStatus === "queued" && !item.uploadError)
        ) {
          if (item.uploadStatus === "waitingSession")
            updateItem(scopeKey, item.id, (candidate) => ({
              ...candidate,
              uploadStatus: "queued",
            }));
          enqueueUpload(scopeKey, item.id);
        }
      }
    }
  }, [
    attachmentSessionId,
    attachments.length,
    enqueueUpload,
    remoteSessionId,
    restartEpoch,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);

  /**
   * 换代作废：撤掉 in-flight 上传与远端暂存，把附件降回 waitingSession 等新会话。
   * silent=true 时不写错误文案——那是一次全自动恢复（作废 → 预热重建 → 重传，1-2s 内完成），
   * 报错只会让用户以为出了问题；waitingSession 本身已渲染成「正在等待会话」。
   */
  const invalidateAttachmentsForRuntimeChange = useCallback(
    ({ silent }: { silent: boolean }) => {
      for (const [targetScopeKey, items] of Object.entries(
        useComposerAttachmentUploadStore.getState().scopes,
      )) {
        const target = targetsRef.current.get(targetScopeKey);
        if (!target) continue;
        for (const item of items) {
          if (
            item.referenceOwnership === "session" ||
            item.localZeroCopy ||
            item.uploadStatus === "failed"
          ) {
            continue;
          }
          const key = item.id;
          controllersRef.current.get(key)?.abort();
          controllersRef.current.delete(key);
          if (item.staged) void target?.transferService.cleanup(item.operationId).catch(() => {});
          if (item.runtimeRebuildRetryCount >= COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT) {
            // 重传配额用尽是真失败，无论静默与否都必须让用户看见。
            updateItem(targetScopeKey, item.id, (current) => ({
              ...current,
              uploadStatus: "failed",
              uploadProgress: 0,
              uploadError: intl.formatMessage({
                id: "chat.attachments.upload.runtimeRestarted",
              }),
              uploadErrorKind: "runtimeRestarted",
              attachmentRef: undefined,
              staged: false,
              adopted: false,
              showComplete: false,
            }));
            continue;
          }
          // 换代后 targetsRef 里的 sessionId 必然陈旧（它在渲染期写入，而换代事件先于
          // 下一次渲染到达），拿它入队会直撞 sessionNotFound。一律降到 waitingSession，
          // 由 restartEpoch / 新 attachmentSessionId 驱动的唤醒 effect 在会话可用后统一入队。
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            ...(silent
              ? { uploadError: undefined, uploadErrorKind: undefined }
              : {
                  uploadError: intl.formatMessage({
                    id: "chat.attachments.upload.runtimeRestarted",
                  }),
                  uploadErrorKind: "runtimeRestarted" as const,
                }),
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            runtimeRebuildRetryCount: current.runtimeRebuildRetryCount + 1,
          }));
        }
      }
    },
    [intl, updateItem],
  );

  useEffect(() => {
    // 二选一订阅：两条通道都订会让同一次换代作废两次，白烧一次重传配额。
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        if (state === "unavailable") {
          // 作废与唤醒到此才真正解耦：此刻旧 CLI 已死、新的还没起来，递增 restartEpoch 会让
          // 唤醒 effect 立即入队并直撞死进程（正式会话态 sessionId 原地不变时尤其明显）。
          invalidateAttachmentsForRuntimeChange({ silent: true });
          return;
        }
        // 草稿态实际由重建后的新 attachmentSessionId 唤醒；这一路是正式会话态的兜底。
        setRestartEpoch((current) => current + 1);
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(() => {
      invalidateAttachmentsForRuntimeChange({ silent: false });
      // 作废与唤醒解耦：这里只负责作废，入队交给依赖 restartEpoch 的唤醒 effect。
      setRestartEpoch((current) => current + 1);
    });
  }, [invalidateAttachmentsForRuntimeChange, onRuntimeLifecycle, onRuntimeRestart]);

  const showAttachmentLimitWarning = useCallback(() => {
    // 只更新输入框底部文字时，重复超限缺少明显反馈；每次添加都弹提示，同一输入框不堆叠。
    toast(
      intl.formatMessage(
        { id: "chat.attachments.maxFiles" },
        { count: String(MAX_CHAT_ATTACHMENTS) },
      ),
      {
        variant: "warning",
        position: "bottom-center",
        dedupeKey: `attachment-limit:${scopeKey}`,
      },
    );
  }, [intl, scopeKey]);

  const addPreparedAttachments = useCallback(
    (selectedAttachments: ChatComposerAttachment[]) => {
      if (selectedAttachments.length === 0) return;
      const current = readComposerAttachmentScope(scopeKey);
      const remainingSlots = MAX_CHAT_ATTACHMENTS - current.length;
      if (remainingSlots <= 0) {
        selectedAttachments.forEach(revokeChatComposerAttachment);
        showAttachmentLimitWarning();
        return;
      }
      const accepted = selectedAttachments.slice(0, remainingSlots);
      selectedAttachments.slice(remainingSlots).forEach(revokeChatComposerAttachment);
      const target = targetsRef.current.get(scopeKey);
      const items: ComposerAttachmentUploadItem[] = accepted.map((attachment) => {
        // 远端 identity 往往早于 remoteSessionId 注入；这段窗口不能退化为本地路径直读。
        const localZeroCopy = Boolean(
          attachment.localPath && target && !isRemoteAttachmentTarget(target),
        );
        return {
          ...attachment,
          referenceOwnership: "composer",
          operationId: `prompt-attachment-${attachment.id}`,
          uploadStatus: localZeroCopy ? "ready" : target?.sessionId ? "queued" : "waitingSession",
          uploadProgress: localZeroCopy ? 100 : 0,
          ...(localZeroCopy && attachment.localPath
            ? {
                attachmentRef: {
                  ref: attachment.localPath,
                  fileName: attachment.filename,
                  mime: attachment.mimeType,
                  bytes: attachment.sizeBytes,
                },
              }
            : {}),
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: false,
          showComplete: false,
          localZeroCopy,
        };
      });
      for (const item of items) {
        attachmentScopesRef.current.set(item.id, scopeKey);
        attachmentOperationsRef.current.set(item.id, item.operationId);
      }
      commitScope(scopeKey, (existing) => [...existing, ...items]);
      setAttachmentError(null);
      if (selectedAttachments.length > remainingSlots) showAttachmentLimitWarning();
      for (const item of items) {
        if (item.uploadStatus === "queued") enqueueUpload(scopeKey, item.id);
      }
    },
    [commitScope, enqueueUpload, scopeKey, showAttachmentLimitWarning],
  );

  const addAttachmentFiles = useCallback(
    (selectedFiles: File[]) => {
      addPreparedAttachments(
        selectedFiles.map((file) => {
          let localPath: string | undefined;
          try {
            const resolvedPath = platform.getPathForFile?.(file);
            localPath = resolvedPath?.trim() ? resolvedPath : undefined;
          } catch (error) {
            // Electron 32+ 的 File 需要经 preload webUtils 解析；失败时仍可走 Web bytes。
            logger.warn("[v4-composer-attachments] 解析附件本地路径失败", error);
          }
          return createChatComposerAttachment(file, localPath);
        }),
      );
    },
    [addPreparedAttachments, platform],
  );

  const addAttachmentLocalPaths = useCallback(
    (selectedPaths: string[]) => {
      addPreparedAttachments(selectedPaths.map(createChatComposerPathAttachment));
    },
    [addPreparedAttachments],
  );

  const openAttachmentPicker = useCallback(() => {
    if (readComposerAttachmentScope(scopeKey).length >= MAX_CHAT_ATTACHMENTS) {
      showAttachmentLimitWarning();
      return;
    }
    if (!platform.canSelectFilePath) {
      attachmentInputRef.current?.click();
      return;
    }
    void selectAttachmentLocalPaths(platform)
      .then((paths) => {
        if (pickerScope.active && currentPickerScopeRef.current === pickerScope)
          addAttachmentLocalPaths(paths);
      })
      .catch((error) => {
        if (!pickerScope.active || currentPickerScopeRef.current !== pickerScope) return;
        logger.warn("[v4-composer-attachments] 选择附件路径失败", error);
        setAttachmentError(
          intl.formatMessage(
            { id: "chat.attachments.readFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
  }, [addAttachmentLocalPaths, intl, pickerScope, platform, scopeKey, showAttachmentLimitWarning]);

  const handleAttachmentInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      addAttachmentFiles(files);
    },
    [addAttachmentFiles],
  );

  const handlePaste = useCallback(
    (event: ChatComposerPasteEvent) => {
      if (disabled || !event.clipboardData) return;
      const files = Array.from(event.clipboardData.files);
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      const prefersSpreadsheetText =
        files.length > 0 && shouldPreferSpreadsheetClipboardText(text, html);
      if (files.length > 0) {
        logger.debug("[v4-composer-attachments] 识别剪贴板多表示 payload", {
          clipboardTypes: Array.from(event.clipboardData.types),
          fileTypes: files.map((file) => file.type),
          prefersSpreadsheetText,
          textLength: text.length,
        });
      }
      if (files.length > 0 && !prefersSpreadsheetText) {
        event.preventDefault();
        event.stopPropagation?.();
        addAttachmentFiles(files);
        return;
      }
      if (!shouldCreateClipboardTextAttachment(text)) return;
      event.preventDefault();
      event.stopPropagation?.();
      void (async () => {
        try {
          const attachment = await platform.createTempTextAttachment?.({
            text,
            filename: createClipboardTextAttachmentFilenameForDate(),
          });
          if (!attachment) throw new Error("当前平台不支持临时文本附件");
          addPreparedAttachments([createClipboardTextPathComposerAttachment(text, attachment)]);
        } catch (error) {
          logger.warn("[v4-composer-attachments] 创建粘贴文本临时附件失败", error);
          setAttachmentError(
            intl.formatMessage(
              { id: "chat.attachments.readFailed" },
              { message: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      })();
    },
    [addAttachmentFiles, addPreparedAttachments, disabled, intl, platform],
  );

  const clearDragFeedbackTimer = useCallback(() => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
      dragFeedbackTimerRef.current = null;
    }
  }, []);
  const resetComposerDragFeedback = useCallback(() => {
    clearDragFeedbackTimer();
    setComposerDragKind(null);
  }, [clearDragFeedbackTimer]);
  const scheduleComposerDragFeedbackReset = useCallback(() => {
    clearDragFeedbackTimer();
    dragFeedbackTimerRef.current = window.setTimeout(resetComposerDragFeedback, 300);
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  useEffect(() => {
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) resetComposerDragFeedback();
    };
    window.addEventListener("dragend", resetComposerDragFeedback);
    window.addEventListener("drop", resetComposerDragFeedback);
    window.addEventListener("blur", resetComposerDragFeedback);
    document.addEventListener("dragleave", handleDocumentDragLeave);
    return () => {
      clearDragFeedbackTimer();
      window.removeEventListener("dragend", resetComposerDragFeedback);
      window.removeEventListener("drop", resetComposerDragFeedback);
      window.removeEventListener("blur", resetComposerDragFeedback);
      document.removeEventListener("dragleave", handleDocumentDragLeave);
    };
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  const handleDragOverComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (!hasFiles && !types.includes("Files") && !types.includes(WORKSPACE_FILE_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setComposerDragKind(types.includes(WORKSPACE_FILE_DRAG_MIME) ? "workspace" : "attachment");
      scheduleComposerDragFeedbackReset();
    },
    [scheduleComposerDragFeedbackReset],
  );
  const handleDragLeaveComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
        resetComposerDragFeedback();
      }
    },
    [resetComposerDragFeedback],
  );
  const handleDropComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (Array.from(event.dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME)) {
        event.preventDefault();
        resetComposerDragFeedback();
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        event.preventDefault();
        addAttachmentFiles(files);
      }
      resetComposerDragFeedback();
    },
    [addAttachmentFiles, resetComposerDragFeedback],
  );

  const addWhiteboardToChat = useCallback(
    async (boardId: string) => {
      const board = useWhiteboardStore.getState().getBoard({
        boardId,
        workspaceIdentity,
        workspacePath,
      });
      if (!board) {
        setAttachmentError(intl.formatMessage({ id: "whiteboard.exportMissing" }));
        return;
      }
      try {
        addAttachmentFiles([createWhiteboardPngFile(board)]);
      } catch (error) {
        setAttachmentError(
          intl.formatMessage(
            { id: "whiteboard.exportFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      }
    },
    [addAttachmentFiles, intl, workspaceIdentity, workspacePath],
  );
  const handleWhiteboardMentionSelected = useCallback(
    async (boardId: string) => addWhiteboardToChat(boardId),
    [addWhiteboardToChat],
  );
  useEffect(() => {
    // 与 useWebElementContexts 等同款早退。SidePane forceMount 使非聚焦
    // 会话的 SessionPane 常驻，只有聚焦 composer（listenAddToChatEvents）才允许消费
    // add-to-chat 事件，否则同 workspace 的多个 composer 会同时注入附件。
    if (!listenAddToChatEvents || typeof window === "undefined") return;
    const handle = (event: Event) => {
      if (!isWhiteboardAddToChatEvent(event)) return;
      if (
        buildWhiteboardWorkspaceKey(event.detail) !==
        buildWhiteboardWorkspaceKey({ workspacePath, workspaceIdentity })
      ) {
        return;
      }
      event.preventDefault();
      void addWhiteboardToChat(event.detail.boardId);
    };
    window.addEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
    return () => window.removeEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
  }, [addWhiteboardToChat, listenAddToChatEvents, workspaceIdentity, workspacePath]);

  const removeAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey);
      const item = current.find((candidate) => candidate.id === id);
      if (!item) return;
      const key = id;
      controllersRef.current.get(key)?.abort();
      controllersRef.current.delete(key);
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => !(entry.scopeKey === scopeKey && entry.attachmentId === id),
      );
      const completeTimer = completeTimersRef.current.get(key);
      if (completeTimer !== undefined) window.clearTimeout(completeTimer);
      const retryTimer = retryTimersRef.current.get(key);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      completeTimersRef.current.delete(key);
      retryTimersRef.current.delete(key);
      revokeChatComposerAttachment(item);
      const target = targetsRef.current.get(scopeKey);
      if (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing") {
        void target?.transferService.cancel(item.operationId).catch((error) => {
          logger.warn("[v4-composer-attachments] 取消远程附件失败", error);
        });
      }
      commitScope(scopeKey, (items) => items.filter((candidate) => candidate.id !== id));
      attachmentScopesRef.current.delete(id);
      setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey).find(
        (candidate) => candidate.id === id,
      );
      if (!current || current.uploadStatus !== "failed") return;
      const target = targetsRef.current.get(scopeKey);
      void target?.transferService.cleanup(current.operationId).catch(() => {});
      updateItem(scopeKey, id, (item) => ({
        ...item,
        uploadStatus: target?.sessionId ? "queued" : "waitingSession",
        uploadProgress: 0,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: undefined,
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: false,
        showComplete: false,
      }));
      if (target?.sessionId) enqueueUpload(scopeKey, id);
    },
    [enqueueUpload, scopeKey, updateItem],
  );

  const clearAttachments = useCallback(
    (attachmentIds?: readonly string[], options?: { preserveError?: boolean }) => {
      const ids = attachmentIds ? new Set(attachmentIds) : null;
      const current = readComposerAttachmentScope(scopeKey).filter(
        (item) => !ids || ids.has(item.id),
      );
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        const key = item.id;
        controllersRef.current.get(key)?.abort();
        controllersRef.current.delete(key);
        const completeTimer = completeTimersRef.current.get(key);
        if (completeTimer !== undefined) window.clearTimeout(completeTimer);
        const retryTimer = retryTimersRef.current.get(key);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        completeTimersRef.current.delete(key);
        retryTimersRef.current.delete(key);
        revokeChatComposerAttachment(item);
        attachmentScopesRef.current.delete(item.id);
        if (
          !item.adopted &&
          (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing")
        ) {
          void target?.transferService.cleanup(item.operationId).catch((error) => {
            logger.warn("[v4-composer-attachments] 清理未发送附件失败", error);
          });
        }
      }
      // ACK 到达后清空整个 scope，会顺手删除等待期间新加入的附件。
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => entry.scopeKey !== scopeKey || (ids !== null && !ids.has(entry.attachmentId)),
      );
      commitScope(scopeKey, (items) => (ids ? items.filter((item) => !ids.has(item.id)) : []));
      // 旧 scope 的 accepted 仍须消费已发送 ID，但复用的 Composer 错误面属于
      // 当前 scope；跨 scope quiet 消费不能清掉新会话的附件错误。
      if (!options?.preserveError) setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  const restoreSessionOwnedAttachments = useCallback(
    (attachmentRefs: readonly AttachmentRef[]): boolean => {
      if (attachmentRefs.length === 0) return true;
      if (readComposerAttachmentScope(scopeKey).length > 0) return false;
      const restored: ComposerAttachmentUploadItem[] = attachmentRefs.map((attachmentRef) => {
        const id = nanoid();
        return {
          id,
          filename: attachmentRef.fileName,
          mimeType: attachmentRef.mime,
          sizeBytes: attachmentRef.bytes,
          referenceOwnership: "session",
          uploadStatus: "ready",
          uploadProgress: 100,
          attachmentRef: { ...attachmentRef },
          operationId: `session-owned-${id}`,
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: true,
          showComplete: false,
          localZeroCopy: false,
        };
      });
      // queue 中的 AttachmentRef 已在首次发送时由 session 接管；若按普通
      // composer 文件重建，会在撤回后重复 upload/adopt，并在 runtime restart 时误清引用。
      commitScope(scopeKey, () => restored);
      setAttachmentError(null);
      return true;
    },
    [commitScope, scopeKey],
  );

  const promoteUnsubmittedAttachments = useCallback(
    (sessionId: string) => {
      const canonicalSessionId = resolveSharedComposerDraftScope({
        workspacePath,
        workspaceIdentity,
        scopeId: sessionId,
      });
      const targetScopeKey = buildScopeKey(workspacePath, workspaceIdentity, canonicalSessionId);
      const sourceTarget = targetsRef.current.get(scopeKey);
      if (!sourceTarget) return;
      const target = { ...sourceTarget, sessionId: canonicalSessionId };
      targetsRef.current.set(targetScopeKey, target);
      const { moved, displaced } = promoteComposerAttachmentScope(scopeKey, targetScopeKey);
      const targetItems = readComposerAttachmentScope(targetScopeKey);
      for (const item of displaced) {
        // 目标较新内容不能被旧 controller 覆盖；同 operation 不可 cleanup/revoke，
        // 否则会删除目标仍在使用的真实暂存文件或 object URL。
        const retained = targetItems.find((candidate) => candidate.id === item.id);
        if (retained?.operationId === item.operationId) {
          attachmentScopesRef.current.set(item.id, targetScopeKey);
          if (retained.uploadStatus === "queued" || retained.uploadStatus === "waitingSession")
            enqueueUpload(targetScopeKey, retained.id);
          continue;
        }
        controllersRef.current.get(item.id)?.abort();
        controllersRef.current.delete(item.id);
        const completeTimer = completeTimersRef.current.get(item.id);
        if (completeTimer !== undefined) window.clearTimeout(completeTimer);
        completeTimersRef.current.delete(item.id);
        const retryTimer = retryTimersRef.current.get(item.id);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        retryTimersRef.current.delete(item.id);
        uploadQueueRef.current = uploadQueueRef.current.filter(
          (entry) => entry.attachmentId !== item.id,
        );
        if (!targetItems.some((candidate) => candidate.operationId === item.operationId)) {
          if (
            !item.objectUrl ||
            !targetItems.some((candidate) => candidate.objectUrl === item.objectUrl)
          )
            revokeChatComposerAttachment(item);
          if (item.referenceOwnership === "composer" && !item.adopted)
            void sourceTarget.transferService.cleanup(item.operationId).catch((error) => {
              logger.warn("[v4-composer-attachments] 清理 promotion 冲突附件失败", error);
            });
        }
        if (retained) {
          attachmentScopesRef.current.set(retained.id, targetScopeKey);
          if (retained.uploadStatus === "queued" || retained.uploadStatus === "waitingSession")
            enqueueUpload(targetScopeKey, retained.id);
        }
      }
      for (const item of moved) {
        attachmentScopesRef.current.set(item.id, targetScopeKey);
        attachmentOperationsRef.current.set(item.id, item.operationId);
        if (
          resolveSharedComposerDraftScope({
            workspacePath,
            workspaceIdentity,
            scopeId: sourceTarget.sessionId ?? "",
          }) !== canonicalSessionId &&
          item.referenceOwnership === "composer" &&
          item.uploadStatus !== "failed" &&
          !item.localZeroCopy
        ) {
          // 非预热复用时 ref 属于旧 session，绝不能只改显示 scope 后继续发送旧引用。
          // 先撤销 controller 再换 operation，迟到 stage/progress 不得污染新 session。
          controllersRef.current.get(item.id)?.abort();
          controllersRef.current.delete(item.id);
          const retryTimer = retryTimersRef.current.get(item.id);
          if (retryTimer !== undefined) window.clearTimeout(retryTimer);
          retryTimersRef.current.delete(item.id);
          const completeTimer = completeTimersRef.current.get(item.id);
          if (completeTimer !== undefined) window.clearTimeout(completeTimer);
          completeTimersRef.current.delete(item.id);
          if (!item.adopted)
            void sourceTarget.transferService.cleanup(item.operationId).catch((error) => {
              logger.warn("[v4-composer-attachments] 清理旧会话附件失败", error);
            });
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            operationId: `prompt-attachment-${nanoid()}`,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            uploadError: undefined,
            uploadErrorKind: undefined,
          }));
        }
        const current = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === item.id,
        );
        if (current?.uploadStatus === "queued" || current?.uploadStatus === "waitingSession")
          enqueueUpload(targetScopeKey, item.id);
      }
    },
    [enqueueUpload, scopeKey, updateItem, workspaceIdentity, workspacePath],
  );

  const prepareForSend = useCallback(async (): Promise<AttachmentRef[] | null> => {
    const current = readComposerAttachmentScope(scopeKey);
    if (current.some((item) => item.uploadStatus !== "ready" || !item.attachmentRef)) {
      return null;
    }
    return current.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
  }, [scopeKey]);

  const adoptSentAttachments = useCallback(
    async (attachmentIds: readonly string[]): Promise<void> => {
      const ids = new Set(attachmentIds);
      // 移交边界必须与本次 Submission 一致，不把下一条消息的附件提前交给 Session。
      const current = readComposerAttachmentScope(scopeKey).filter((item) => ids.has(item.id));
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        if (item.staged && !item.adopted) {
          try {
            await target?.transferService.adopt(item.operationId);
          } catch (error) {
            // sendText 已成功，不能因 adopt 回执失败把同一条消息重新留在 composer。
            logger.warn("[v4-composer-attachments] 附件发送后 adopt 失败", error);
          }
          updateItem(
            scopeKey,
            item.id,
            (candidate) => ({
              ...candidate,
              adopted: true,
            }),
            item.operationId,
          );
        }
      }
    },
    [scopeKey, updateItem],
  );

  return useMemo(
    () => ({
      attachments,
      attachmentError,
      composerDragKind,
      hasAttachments: attachments.length > 0,
      hasUnreadyAttachments: attachments.some((item) => item.uploadStatus !== "ready"),
      isDraggingOverComposer,
      attachmentInputRef,
      openAttachmentPicker,
      handleAttachmentInputChange,
      handlePaste,
      handleDragOverComposer,
      handleDragLeaveComposer,
      handleDropComposer,
      handleWhiteboardMentionSelected,
      removeAttachment,
      retryAttachment,
      clearAttachments,
      restoreSessionOwnedAttachments,
      prepareForSend,
      adoptSentAttachments,
      setAttachmentError,
      promoteUnsubmittedAttachments,
    }),
    [
      attachmentError,
      adoptSentAttachments,
      attachments,
      composerDragKind,
      clearAttachments,
      restoreSessionOwnedAttachments,
      handleAttachmentInputChange,
      handleDragLeaveComposer,
      handleDragOverComposer,
      handleDropComposer,
      handlePaste,
      handleWhiteboardMentionSelected,
      isDraggingOverComposer,
      openAttachmentPicker,
      prepareForSend,
      promoteUnsubmittedAttachments,
      removeAttachment,
      retryAttachment,
    ],
  );
}
