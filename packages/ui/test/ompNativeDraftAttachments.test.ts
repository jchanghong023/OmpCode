import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  useComposerAttachments,
  type ComposerAttachmentsApi,
} from "../src/v4/composer/useComposerAttachments.js";
import {
  promoteComposerAttachmentScope,
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
  type ComposerAttachmentUploadItem,
} from "../src/store/composerAttachmentUploadStore.js";
import { bindComposerDraftMigrationEvents } from "../src/hooks/useComposerDraftMigrationEvents.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
} from "../src/v4/composer/composerDraftStore.js";
import { migrateSharedComposerDraft } from "../src/v4/composer/composerDraftRegistry.js";
import type { AttachmentPutFn } from "../src/v4/composer/attachmentUpload.js";

const source = "C:/chips/project\u0000__draft__";
const target = "C:/chips/project\u0000accepted-session";

function attachment(
  id: string,
  overrides: Partial<ComposerAttachmentUploadItem> = {},
): ComposerAttachmentUploadItem {
  return {
    id,
    filename: `${id}.md`,
    mimeType: "text/markdown",
    sizeBytes: 7,
    referenceOwnership: "composer",
    operationId: `prompt-attachment-${id}`,
    uploadStatus: "ready",
    uploadProgress: 100,
    attachmentRef: {
      ref: `attachments/${id}`,
      fileName: `${id}.md`,
      mime: "text/markdown",
      bytes: 7,
    },
    autoRetryCount: 0,
    runtimeRebuildRetryCount: 0,
    staged: false,
    adopted: false,
    showComplete: false,
    localZeroCopy: false,
    ...overrides,
  };
}

afterEach(() => {
  useComposerAttachmentUploadStore.setState({ scopes: {}, operationScopes: new Map() });
  useTaskQueryCacheStore.getState().clearAll();
});

test("原生 accepted promotion 原子移动真实附件及引用所有权，而非复制或 adopt", () => {
  const local = attachment("local", {
    localZeroCopy: true,
    localPath: "C:/chips/project/docs/mbist.md",
  });
  const staged = attachment("remote", { staged: true, objectUrl: "blob:remote-preview" });
  const sessionOwned = attachment("queue", { referenceOwnership: "session", adopted: true });
  const items = [local, staged, sessionOwned];
  updateComposerAttachmentScope(source, () => items);
  const notifications: string[][] = [];
  const unsubscribe = useComposerAttachmentUploadStore.subscribe((state) => {
    notifications.push(Object.keys(state.scopes));
  });
  try {
    const result = promoteComposerAttachmentScope(source, target);
    assert.deepEqual(result.moved, items);
    assert.deepEqual(result.displaced, []);
    assert.equal(readComposerAttachmentScope(source).length, 0);
    const promoted = readComposerAttachmentScope(target);
    items.forEach((item, index) => {
      assert.equal(promoted[index], item);
      assert.equal(promoted[index]?.attachmentRef, item.attachmentRef);
      assert.equal(promoted[index]?.adopted, item.adopted);
      assert.equal(promoted[index]?.referenceOwnership, item.referenceOwnership);
    });
    assert.deepEqual(notifications, [[target]]);
  } finally {
    unsubscribe();
  }
});

test("waiting、queued、uploading、committing 均保留 operation 身份和上传事实", () => {
  const items = (["waitingSession", "queued", "uploading", "committing"] as const).map(
    (uploadStatus) =>
      attachment(uploadStatus, { uploadStatus, attachmentRef: undefined, uploadProgress: 37 }),
  );
  updateComposerAttachmentScope(source, () => items);
  promoteComposerAttachmentScope(source, target);
  items.forEach((item, index) => assert.equal(readComposerAttachmentScope(target)[index], item));
  assert.equal(readComposerAttachmentScope(source).length, 0);
});

test("目标较新附件优先，保留其他目标与来源附件，重复 promotion 不重复引用", () => {
  const older = attachment("same", { staged: true });
  const newer = attachment("same", { operationId: "newer-operation", staged: true });
  const existing = attachment("existing");
  const pending = attachment("pending", {
    uploadStatus: "waitingSession",
    attachmentRef: undefined,
  });
  updateComposerAttachmentScope(source, () => [older, pending]);
  updateComposerAttachmentScope(target, () => [newer, existing]);
  const first = promoteComposerAttachmentScope(source, target);
  assert.deepEqual(first, { moved: [pending], displaced: [older] });
  assert.deepEqual(readComposerAttachmentScope(target), [newer, existing, pending]);
  const accepted = readComposerAttachmentScope(target);
  assert.deepEqual(promoteComposerAttachmentScope(source, target), { moved: [], displaced: [] });
  assert.equal(readComposerAttachmentScope(target), accepted);
});

test("同一远端 operation 不因重复 chip 身份而重复持有或 adopt", () => {
  const existing = attachment("target-id", { operationId: "shared-stage", staged: true });
  const duplicate = attachment("source-id", { operationId: "shared-stage", staged: true });
  updateComposerAttachmentScope(source, () => [duplicate]);
  updateComposerAttachmentScope(target, () => [existing]);
  assert.deepEqual(promoteComposerAttachmentScope(source, target), {
    moved: [],
    displaced: [duplicate],
  });
  assert.deepEqual(readComposerAttachmentScope(target), [existing]);
  assert.equal(readComposerAttachmentScope(target)[0]?.adopted, false);
});

test("workspace identity 隔离，不允许跨工作区、正式会话反迁移或空 session", () => {
  const item = attachment("kept");
  updateComposerAttachmentScope(source, () => [item]);
  for (const invalid of [
    "remote:workspace\u0000accepted-session",
    "C:/chips/project\u0000",
    source,
  ]) {
    assert.deepEqual(promoteComposerAttachmentScope(source, invalid), { moved: [], displaced: [] });
    assert.deepEqual(readComposerAttachmentScope(source), [item]);
  }
  assert.deepEqual(promoteComposerAttachmentScope(target, source), { moved: [], displaced: [] });
  assert.deepEqual(promoteComposerAttachmentScope("__draft__", target), {
    moved: [],
    displaced: [],
  });
  const remoteSource = "remote:host/project\u0000__draft__";
  const remoteTarget = "remote:host/project\u0000accepted-session";
  updateComposerAttachmentScope(remoteSource, () => [item]);
  promoteComposerAttachmentScope(remoteSource, remoteTarget);
  assert.equal(readComposerAttachmentScope(remoteTarget)[0], item);
  assert.equal(readComposerAttachmentScope(source)[0], item);
});

type TransferProgress = {
  phase: "uploading" | "committing";
  uploadedBytes: number;
  totalBytes: number;
};

function captureAttachmentOwner(options: {
  scopeId: string;
  attachmentSessionId: string | null;
  remote?: boolean;
  transfer: object;
  attachmentPut?: AttachmentPutFn;
}): ComposerAttachmentsApi {
  let api: ComposerAttachmentsApi | undefined;
  function Probe() {
    api = useComposerAttachments({
      workspacePath: "C:/chips/project",
      workspaceIdentity: options.remote ? "remote:host/project" : undefined,
      remoteSessionId: options.remote ? "remote-connection" : undefined,
      scopeId: options.scopeId,
      attachmentSessionId: options.attachmentSessionId,
      attachmentPut:
        options.attachmentPut ??
        (async () => {
          throw new Error("本用例不允许 inline upload");
        }),
    });
    return null;
  }
  // SSR 只用于实例化真实 hook 的闭包/refs，不执行 UI effects；上传/迁移/发送均调用真实 API。
  renderToStaticMarkup(
    createElement(PlatformProvider, {
      platform: {} as ComponentProps<typeof PlatformProvider>["platform"],
      children: createElement(ServiceProvider, {
        services: { promptAttachmentTransferService: options.transfer } as ComponentProps<
          typeof ServiceProvider
        >["services"],
        children: createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN",
          children: createElement(Probe),
        }),
      }),
    }),
  );
  assert.ok(api);
  return api;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("真实 hook 的 in-flight stage 随 accepted promotion 延续，旧草稿不复活且只 adopt 一次", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  const sourceKey = "remote:host/project\u0000__draft__";
  const targetKey = "remote:host/project\u0000accepted-session";
  const started = deferred<void>();
  const staged = deferred<{ ref: string; bytes: number; staged: boolean }>();
  const calls: string[] = [];
  let progress: ((value: TransferProgress) => void) | undefined;
  const transfer = {
    onDynamicProgress: () => (listener: (value: TransferProgress) => void) => {
      progress = listener;
      return { dispose() {} };
    },
    stage: async (request: { operationId: string; sessionId: string }) => {
      calls.push(`stage:${request.sessionId}:${request.operationId}`);
      started.resolve();
      return staged.promise;
    },
    adopt: async (operationId: string) => {
      calls.push(`adopt:${operationId}`);
    },
    cleanup: async (operationId: string) => {
      calls.push(`cleanup:${operationId}`);
    },
  };
  const item = attachment("remote-file", {
    localPath: "C:/chips/project/docs/mbist.md",
    uploadStatus: "failed",
    attachmentRef: undefined,
    uploadProgress: 0,
  });
  updateComposerAttachmentScope(sourceKey, () => [item]);
  try {
    const draftApi = captureAttachmentOwner({
      scopeId: "__draft__",
      attachmentSessionId: "accepted-session",
      remote: true,
      transfer,
    });
    draftApi.retryAttachment(item.id);
    await started.promise;
    draftApi.promoteUnsubmittedAttachments("accepted-session");
    progress?.({ phase: "committing", uploadedBytes: 7, totalBytes: 7 });
    assert.equal(readComposerAttachmentScope(sourceKey).length, 0);
    assert.equal(readComposerAttachmentScope(targetKey)[0]?.uploadStatus, "committing");
    assert.equal(readComposerAttachmentScope(targetKey)[0]?.referenceOwnership, "composer");
    staged.resolve({ ref: "staged/real-operation-result", bytes: 7, staged: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readComposerAttachmentScope(sourceKey).length, 0);
    assert.equal(
      readComposerAttachmentScope(targetKey)[0]?.attachmentRef?.ref,
      "staged/real-operation-result",
    );
    assert.equal(readComposerAttachmentScope(targetKey)[0]?.adopted, false);
    draftApi.promoteUnsubmittedAttachments("accepted-session");
    const sessionApi = captureAttachmentOwner({
      scopeId: "accepted-session",
      attachmentSessionId: "accepted-session",
      remote: true,
      transfer,
    });
    assert.deepEqual(await sessionApi.prepareForSend(), [
      readComposerAttachmentScope(targetKey)[0]?.attachmentRef,
    ]);
    await sessionApi.adoptSentAttachments([item.id]);
    await sessionApi.adoptSentAttachments([item.id]);
    sessionApi.clearAttachments([item.id]);
    assert.deepEqual(calls, [
      "cleanup:prompt-attachment-remote-file",
      "stage:accepted-session:prompt-attachment-remote-file",
      "adopt:prompt-attachment-remote-file",
    ]);
    assert.deepEqual(readComposerAttachmentScope(targetKey), []);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("真实 hook 正常发送只清冻结附件，新增附件不残留为已发送或被提前 adopt", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  const calls: string[] = [];
  const sent = attachment("submitted", { staged: true });
  const next = attachment("newer");
  updateComposerAttachmentScope(source, () => [sent]);
  try {
    const api = captureAttachmentOwner({
      scopeId: "__draft__",
      attachmentSessionId: "accepted-session",
      transfer: {
        adopt: async (id: string) => {
          calls.push(id);
        },
      },
    });
    const refs = await api.prepareForSend();
    assert.deepEqual(refs, [sent.attachmentRef]);
    updateComposerAttachmentScope(source, (items) => [...items, next]);
    await api.adoptSentAttachments([sent.id]);
    api.clearAttachments([sent.id]);
    assert.deepEqual(calls, [sent.operationId]);
    assert.deepEqual(readComposerAttachmentScope(source), [next]);
    assert.deepEqual(readComposerAttachmentScope(target), []);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("跨实际 session 时撤销旧 operation，迟到 stage/progress 不能覆盖新 scope 或提前 adopt", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  const sourceKey = "remote:host/project\u0000__draft__";
  const targetKey = "remote:host/project\u0000accepted-session";
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const oldStage = deferred<{ ref: string; bytes: number; staged: boolean }>();
  const newStage = deferred<{ ref: string; bytes: number; staged: boolean }>();
  const requests: { operationId: string; sessionId: string }[] = [];
  const progress = new Map<string, (value: TransferProgress) => void>();
  const adoptions: string[] = [];
  const transfer = {
    onDynamicProgress: (operationId: string) => (listener: (value: TransferProgress) => void) => {
      progress.set(operationId, listener);
      return { dispose() {} };
    },
    stage: async (request: { operationId: string; sessionId: string }) => {
      requests.push(request);
      if (requests.length === 1) {
        firstStarted.resolve();
        return oldStage.promise;
      }
      secondStarted.resolve();
      return newStage.promise;
    },
    cleanup: async () => {},
    adopt: async (operationId: string) => {
      adoptions.push(operationId);
    },
  };
  const item = attachment("cross-session", {
    localPath: "C:/chips/project/docs/mbist.md",
    uploadStatus: "failed",
    attachmentRef: undefined,
    uploadProgress: 0,
  });
  updateComposerAttachmentScope(sourceKey, () => [item]);
  try {
    const api = captureAttachmentOwner({
      scopeId: "__draft__",
      attachmentSessionId: "old-prewarm",
      remote: true,
      transfer,
    });
    api.retryAttachment(item.id);
    await firstStarted.promise;
    api.promoteUnsubmittedAttachments("accepted-session");
    await secondStarted.promise;
    assert.equal(requests[0]?.sessionId, "old-prewarm");
    assert.equal(requests[1]?.sessionId, "accepted-session");
    assert.notEqual(requests[1]?.operationId, requests[0]?.operationId);
    progress.get(item.operationId)?.({ phase: "committing", uploadedBytes: 7, totalBytes: 7 });
    oldStage.resolve({ ref: "old-session/late-ref", bytes: 7, staged: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readComposerAttachmentScope(sourceKey).length, 0);
    assert.equal(readComposerAttachmentScope(targetKey)[0]?.attachmentRef, undefined);
    assert.equal(readComposerAttachmentScope(targetKey)[0]?.uploadStatus, "uploading");
    assert.deepEqual(adoptions, []);
    newStage.resolve({ ref: "accepted-session/new-ref", bytes: 7, staged: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ready = readComposerAttachmentScope(targetKey)[0];
    assert.equal(ready?.attachmentRef?.ref, "accepted-session/new-ref");
    assert.equal(ready?.operationId, requests[1]?.operationId);
    const sessionApi = captureAttachmentOwner({
      scopeId: "accepted-session",
      attachmentSessionId: "accepted-session",
      remote: true,
      transfer,
    });
    await sessionApi.adoptSentAttachments([item.id]);
    sessionApi.clearAttachments([item.id]);
    assert.deepEqual(adoptions, [requests[1]?.operationId]);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

for (const metadataFirst of [false, true]) {
  test(`已接纳 metadata ${metadataFirst ? "早于" : "晚于"} accepted：File/ref/queued/controller 连续到 UUID 并可正常发送`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      },
    });
    const tempId = `temp-${metadataFirst ? "early" : "late"}`;
    const uuid = `uuid-${metadataFirst ? "early" : "late"}`;
    const scope = { workspacePath: "C:/chips/project", workspaceIdentity: "remote:host/project" };
    const draftKey = `${scope.workspaceIdentity}\u0000__draft__`;
    const tempKey = `${scope.workspaceIdentity}\u0000${tempId}`;
    const uuidKey = `${scope.workspaceIdentity}\u0000${uuid}`;
    const readyFile = new File(["mbist\n"], "mbist.md", { type: "text/markdown" });
    const ready = attachment(`ready-${tempId}`, { file: readyFile, staged: true });
    const pending = ["upload-one", "upload-two", "queued"].map((id) =>
      attachment(`${id}-${tempId}`, {
        file: new File([id], `${id}.md`, { type: "text/markdown" }),
        localPath: `C:/chips/project/${id}.md`,
        uploadStatus: "failed",
        attachmentRef: undefined,
        uploadProgress: 0,
      }),
    );
    const stages = new Map(
      pending.map((item) => [
        item.operationId,
        deferred<{ ref: string; bytes: number; staged: boolean }>(),
      ]),
    );
    const progress = new Map<string, (value: TransferProgress) => void>();
    const requests: { operationId: string; sessionId: string }[] = [];
    const calls: string[] = [];
    const started = deferred<void>();
    const queuedStarted = deferred<void>();
    const transfer = {
      onDynamicProgress: (operationId: string) => (listener: (value: TransferProgress) => void) => {
        progress.set(operationId, listener);
        return { dispose() {} };
      },
      stage: async (request: { operationId: string; sessionId: string }) => {
        requests.push(request);
        if (requests.length === 2) started.resolve();
        if (requests.length === 3) queuedStarted.resolve();
        const stage = stages.get(request.operationId);
        assert.ok(stage);
        return stage.promise;
      },
      cleanup: async (operationId: string) => {
        calls.push(`cleanup:${operationId}`);
      },
      adopt: async (operationId: string) => {
        calls.push(`adopt:${operationId}`);
      },
    };
    let release: (() => void) | undefined;
    try {
      updateComposerAttachmentScope(draftKey, () => [ready, ...pending]);
      persistV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, "__draft__", {
        text: "原生 goal 不消费正文和附件",
      });
      release = bindComposerDraftMigrationEvents(scope, transfer);
      const api = captureAttachmentOwner({
        scopeId: "__draft__",
        attachmentSessionId: tempId,
        remote: true,
        transfer,
      });
      for (const item of pending) api.retryAttachment(item.id);
      await started.promise;
      assert.equal(readComposerAttachmentScope(draftKey)[3]?.uploadStatus, "queued");
      const migrationMeta = {
        taskId: uuid,
        traceId: uuid,
        title: "native task",
        mode: "build" as const,
        createdAt: 1,
        updatedAt: 2,
        ...scope,
        taskIdMigration: { fromTaskId: tempId, toTaskId: uuid },
      };
      if (metadataFirst) useTaskQueryCacheStore.getState().upsertTaskMeta(migrationMeta);
      assert.equal(
        migrateSharedComposerDraft({
          ...scope,
          fromTaskId: "__draft__",
          toTaskId: tempId,
          redirectSourceLookup: false,
        }),
        true,
      );
      api.promoteUnsubmittedAttachments(tempId);
      if (!metadataFirst) useTaskQueryCacheStore.getState().upsertTaskMeta(migrationMeta);
      assert.equal(readComposerAttachmentScope(draftKey).length, 0);
      assert.equal(readComposerAttachmentScope(tempKey).length, 0);
      assert.equal(
        readV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, uuid)?.text,
        "原生 goal 不消费正文和附件",
      );
      const canonical = readComposerAttachmentScope(uuidKey);
      assert.equal(canonical[0], ready);
      assert.equal(canonical[0]?.file, readyFile);
      assert.equal(canonical[0]?.attachmentRef, ready.attachmentRef);
      assert.deepEqual(
        canonical.map((item) => item.operationId),
        [ready, ...pending].map((item) => item.operationId),
      );
      const cleanupBeforeMigration = pending.map((item) => `cleanup:${item.operationId}`);
      assert.deepEqual(calls, cleanupBeforeMigration);
      // A→B→A：迟到进度不得写入新建的旧 draft 桶，即使 UI 已切走。
      const nextDraft = attachment(pending[0]!.id, { operationId: `next-draft-${tempId}` });
      updateComposerAttachmentScope(draftKey, () => [nextDraft]);
      const first = pending[0]!;
      progress.get(first.operationId)?.({ phase: "committing", uploadedBytes: 7, totalBytes: 7 });
      assert.equal(readComposerAttachmentScope(uuidKey)[1]?.uploadStatus, "committing");
      assert.deepEqual(readComposerAttachmentScope(draftKey), [nextDraft]);
      const selected = captureAttachmentOwner({
        scopeId: uuid,
        attachmentSessionId: uuid,
        remote: true,
        transfer,
      });
      assert.equal(await selected.prepareForSend(), null);
      stages.get(first.operationId)!.resolve({ ref: `staged/${first.id}`, bytes: 7, staged: true });
      await queuedStarted.promise;
      assert.equal(requests[2]?.sessionId, uuid);
      for (const item of pending.slice(1))
        stages.get(item.operationId)!.resolve({ ref: `staged/${item.id}`, bytes: 7, staged: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      // 重复 metadata 不能回填 temp 或丢失目标较新的状态。
      const completed = readComposerAttachmentScope(uuidKey);
      useTaskQueryCacheStore.getState().upsertTaskMeta(migrationMeta);
      assert.equal(readComposerAttachmentScope(uuidKey), completed);
      assert.equal(readComposerAttachmentScope(tempKey).length, 0);
      const refs = await selected.prepareForSend();
      assert.deepEqual(
        refs,
        completed.map((item) => item.attachmentRef),
      );
      assert.equal(refs?.[0], ready.attachmentRef);
      completed.forEach((item, index) => {
        assert.equal(item.file, [ready, ...pending][index]?.file);
        assert.equal(item.operationId, [ready, ...pending][index]?.operationId);
        assert.equal(item.adopted, false);
      });
      await selected.adoptSentAttachments(completed.map((item) => item.id));
      selected.clearAttachments(completed.map((item) => item.id));
      assert.deepEqual(calls, [
        ...cleanupBeforeMigration,
        ...completed.map((item) => `adopt:${item.operationId}`),
      ]);
      assert.deepEqual(readComposerAttachmentScope(uuidKey), []);
      assert.deepEqual(readComposerAttachmentScope(draftKey), [nextDraft]);
    } finally {
      release?.();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}

test("全局 metadata 迁移覆盖 closed owner，隔离身份与释放代际，目标冲突释放且 session-owned ref 不变", () => {
  const scope = { workspacePath: "C:/chips/project", workspaceIdentity: "remote:isolated/project" };
  const fromTaskId = "closed-temp";
  const toTaskId = "closed-uuid";
  const fromKey = `${scope.workspaceIdentity}\u0000${fromTaskId}`;
  const toKey = `${scope.workspaceIdentity}\u0000${toTaskId}`;
  const older = attachment("conflict", { staged: true });
  const newer = attachment("conflict", {
    operationId: "target-new-operation",
    staged: true,
    objectUrl: "blob:retained",
  });
  const sameOperation = attachment("duplicate-operation", {
    operationId: newer.operationId,
    staged: true,
    objectUrl: newer.objectUrl,
  });
  const ready = attachment("closed-ready");
  const queued = attachment("closed-queued", { uploadStatus: "queued", attachmentRef: undefined });
  const sessionOwned = attachment("already-submitted", {
    referenceOwnership: "session",
    adopted: true,
  });
  const adopted = attachment("already-adopted", { adopted: true, staged: true });
  const otherWorkspaceKey = `C:/unrelated\u0000${fromTaskId}`;
  const otherRemoteKey = `remote:other/project\u0000${fromTaskId}`;
  updateComposerAttachmentScope(fromKey, () => [
    older,
    sameOperation,
    ready,
    queued,
    sessionOwned,
    adopted,
  ]);
  updateComposerAttachmentScope(toKey, () => [newer]);
  updateComposerAttachmentScope(otherWorkspaceKey, () => [attachment("other-workspace")]);
  updateComposerAttachmentScope(otherRemoteKey, () => [attachment("other-remote")]);
  const meta = {
    taskId: toTaskId,
    traceId: toTaskId,
    title: "closed task",
    mode: "build" as const,
    createdAt: 1,
    updatedAt: 2,
    ...scope,
    taskIdMigration: { fromTaskId, toTaskId },
  };
  let oldEvent: ((event: unknown) => void) | undefined;
  const releaseOld = bindComposerDraftMigrationEvents(
    scope,
    {
      cleanup: async () => {
        assert.fail("已释放的旧绑定不得清理附件");
      },
    },
    (consume) => {
      oldEvent = consume;
      return { dispose() {} };
    },
  );
  releaseOld();
  oldEvent?.({
    type: "workspace_task_list_changed",
    reason: "realtime_sync",
    ...scope,
    taskId: toTaskId,
    taskIdMigration: meta.taskIdMigration,
  });
  assert.deepEqual(readComposerAttachmentScope(toKey), [newer]);
  const cleanupCalls: string[] = [];
  const release = bindComposerDraftMigrationEvents(scope, {
    cleanup: async (operationId: string) => {
      cleanupCalls.push(operationId);
    },
  });
  try {
    useTaskQueryCacheStore
      .getState()
      .upsertTaskMeta({ ...meta, workspaceIdentity: "remote:wrong/project" });
    useTaskQueryCacheStore.getState().upsertTaskMeta({ ...meta, workspacePath: "C:/wrong-path" });
    assert.deepEqual(readComposerAttachmentScope(toKey), [newer]);
    useTaskQueryCacheStore.getState().upsertTaskMeta(meta);
    assert.deepEqual(readComposerAttachmentScope(toKey), [newer, ready, queued]);
    assert.deepEqual(readComposerAttachmentScope(fromKey), [sessionOwned, adopted]);
    const canonical = readComposerAttachmentScope(toKey);
    useTaskQueryCacheStore.getState().upsertTaskMeta(meta);
    assert.equal(readComposerAttachmentScope(toKey), canonical);
    assert.equal(readComposerAttachmentScope(toKey)[0], newer);
    assert.equal(
      readComposerAttachmentScope(fromKey)[0]?.attachmentRef,
      sessionOwned.attachmentRef,
    );
    assert.deepEqual(cleanupCalls, [older.operationId]);
    assert.equal(readComposerAttachmentScope(otherWorkspaceKey)[0]?.id, "other-workspace");
    assert.equal(readComposerAttachmentScope(otherRemoteKey)[0]?.id, "other-remote");
  } finally {
    release();
  }
});

test("已接纳冷缓存先于全局绑定时，closed 附件仍从临时 session 原子归入 UUID", () => {
  const scope = { workspacePath: "C:/chips/cold-project" };
  const fromTaskId = "cold-temp";
  const toTaskId = "cold-uuid";
  const fromKey = `${scope.workspacePath}\u0000${fromTaskId}`;
  const toKey = `${scope.workspacePath}\u0000${toTaskId}`;
  const item = attachment("cold-ready", {
    localZeroCopy: true,
    localPath: "C:/chips/cold-project/mbist.md",
  });
  updateComposerAttachmentScope(fromKey, () => [item]);
  useTaskQueryCacheStore.getState().upsertTaskMeta({
    ...scope,
    taskId: toTaskId,
    traceId: toTaskId,
    title: "cold native task",
    mode: "build",
    createdAt: 1,
    updatedAt: 2,
    taskIdMigration: { fromTaskId, toTaskId },
  });
  assert.deepEqual(readComposerAttachmentScope(fromKey), [item]);
  const cleanupCalls: string[] = [];
  const release = bindComposerDraftMigrationEvents(scope, {
    cleanup: async (operationId: string) => {
      cleanupCalls.push(operationId);
    },
  });
  try {
    assert.deepEqual(readComposerAttachmentScope(fromKey), []);
    assert.equal(readComposerAttachmentScope(toKey)[0], item);
    assert.equal(readComposerAttachmentScope(toKey)[0]?.attachmentRef, item.attachmentRef);
    assert.equal(readComposerAttachmentScope(toKey)[0]?.operationId, item.operationId);
    assert.equal(readComposerAttachmentScope(toKey)[0]?.adopted, false);
    assert.deepEqual(cleanupCalls, []);
  } finally {
    release();
  }
});

for (const replacedByNewer of [false, true]) {
  test(`真实 File 上传 controller 在全局迁移中${replacedByNewer ? "只撤销被取代operation，保护目标File/URL" : "保留同一operation，旧owner不能abort规范scope"}`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout },
    });
    const tempId = `inline-temp-${replacedByNewer}`;
    const uuid = `inline-uuid-${replacedByNewer}`;
    const fromKey = `C:/chips/project\u0000${tempId}`;
    const toKey = `C:/chips/project\u0000${uuid}`;
    const file = new File(["real mbist bytes\n"], "mbist.md", { type: "text/markdown" });
    const pending = attachment(`inline-${replacedByNewer}`, {
      file,
      objectUrl: "blob:shared-file",
      uploadStatus: "failed",
      uploadProgress: 0,
      attachmentRef: undefined,
    });
    const newer = attachment(pending.id, {
      file,
      objectUrl: pending.objectUrl,
      operationId: `newer-${pending.operationId}`,
    });
    const put = deferred<{ ref: string }>();
    const started = deferred<{ dataBase64: string }>();
    let signal: AbortSignal | undefined;
    const cleanupCalls: string[] = [];
    const transfer = {
      cleanup: async (operationId: string) => {
        cleanupCalls.push(operationId);
      },
    };
    let release: (() => void) | undefined;
    try {
      updateComposerAttachmentScope(fromKey, () => [pending]);
      if (replacedByNewer) updateComposerAttachmentScope(toKey, () => [newer]);
      const sourceApi = captureAttachmentOwner({
        scopeId: tempId,
        attachmentSessionId: tempId,
        transfer,
        attachmentPut: async (request, options) => {
          signal = options?.signal;
          started.resolve(request);
          return put.promise;
        },
      });
      sourceApi.retryAttachment(pending.id);
      const uploadRequest = await started.promise;
      assert.equal(
        Buffer.from(uploadRequest.dataBase64, "base64").toString(),
        "real mbist bytes\n",
      );
      assert.equal(signal?.aborted, false);
      const cleanupBeforeMigration = cleanupCalls.length;
      release = bindComposerDraftMigrationEvents({ workspacePath: "C:/chips/project" }, transfer);
      useTaskQueryCacheStore.getState().upsertTaskMeta({
        taskId: uuid,
        traceId: uuid,
        title: "inline native task",
        mode: "build",
        workspacePath: "C:/chips/project",
        createdAt: 1,
        updatedAt: 2,
        taskIdMigration: { fromTaskId: tempId, toTaskId: uuid },
      });
      assert.equal(signal?.aborted, replacedByNewer);
      assert.deepEqual(readComposerAttachmentScope(fromKey), []);
      // 模拟旧 owner 的迟到清理；不能碰已经归规范 scope 的 operation。
      sourceApi.clearAttachments([pending.id]);
      assert.equal(signal?.aborted, replacedByNewer);
      put.resolve({ ref: "uploaded/real-file" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const selected = captureAttachmentOwner({
        scopeId: uuid,
        attachmentSessionId: uuid,
        transfer,
      });
      const canonical = readComposerAttachmentScope(toKey)[0];
      assert.equal(canonical?.file, file);
      assert.equal(canonical?.objectUrl, pending.objectUrl);
      assert.equal(
        canonical?.operationId,
        replacedByNewer ? newer.operationId : pending.operationId,
      );
      assert.equal(
        canonical?.attachmentRef?.ref,
        replacedByNewer ? newer.attachmentRef?.ref : "uploaded/real-file",
      );
      assert.deepEqual(await selected.prepareForSend(), [canonical?.attachmentRef]);
      assert.deepEqual(revoked, []);
      assert.deepEqual(
        cleanupCalls.slice(cleanupBeforeMigration),
        replacedByNewer ? [pending.operationId] : [],
      );
    } finally {
      release?.();
      URL.revokeObjectURL = originalRevoke;
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}
