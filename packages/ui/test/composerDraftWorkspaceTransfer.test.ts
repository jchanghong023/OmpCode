// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistV4ComposerDraft,
  rememberComposerWorkspaceScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  captureV4ComposerDraftHandoff,
  registerV4ComposerDraftReader,
  stageV4ComposerDraftAttachments,
  consumeV4ComposerDraftAttachments,
  clearV4ComposerDraftWorkspaceTransferRequest,
  consumeV4ComposerDraftWorkspaceTransferRequest,
  requestV4ComposerDraftWorkspaceTransfer,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";

const storageScope = "opaque-native-root-profile-a";
const otherStorageScope = "opaque-native-root-profile-b";
const readerCleanup: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  clearV4ComposerDraftWorkspaceTransferRequest();
});
afterEach(() => {
  for (const unregister of readerCleanup.splice(0)) unregister();
  localStorage.clear();
  clearV4ComposerDraftWorkspaceTransferRequest();
});

describe("composer draft workspace transfer", () => {
  it("编辑器未挂载时按当前客户端及项目读取交接正文", () => {
    localStorage.clear();
    for (const clientNamespace of ["desktop", "mobile:test"]) {
      const scope = { clientNamespace, hostId: "local", projectId: "p", storageScope };
      rememberComposerWorkspaceScope("/same", undefined, scope);
      persistV4ComposerDraft(
        "/same",
        undefined,
        V4_DRAFT_SCOPE_ROOT,
        { text: clientNamespace },
        scope,
      );
    }
    expect(
      captureV4ComposerDraftHandoff("/same", undefined, "mobile:test", storageScope).draft.text,
    ).toBe("mobile:test");
    expect(
      captureV4ComposerDraftHandoff("/same", undefined, "desktop", storageScope).draft.text,
    ).toBe("desktop");
    localStorage.clear();
  });

  it("is consumed only by the matching source and target workspace", () => {
    requestV4ComposerDraftWorkspaceTransfer({
      sourceWorkspacePath: "/project",
      targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
    });

    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/other",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(true);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
  });
});

it("captures live editor content and delivers attachments once to the exact target", () => {
  const attachment = {
    id: "source",
    file: new File(["data"], "draft.txt"),
    filename: "draft.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  const unregister = registerV4ComposerDraftReader(
    "remote:source",
    () => ({
      draft: { text: "not yet persisted", editorStateJson: "rich-state" },
      attachments: [attachment],
    }),
    storageScope,
  );
  readerCleanup.push(unregister);
  const snapshot = captureV4ComposerDraftHandoff(
    "/same-path",
    "remote:source",
    "desktop",
    storageScope,
  );
  expect(snapshot.draft).toEqual({ text: "not yet persisted", editorStateJson: "rich-state" });
  stageV4ComposerDraftAttachments("/same-path", "remote:target", 2, snapshot, storageScope);
  expect(consumeV4ComposerDraftAttachments("/same-path", 2, storageScope)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("remote:target", 2, otherStorageScope)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("remote:target", 2, storageScope)).toEqual([attachment]);
  expect(consumeV4ComposerDraftAttachments("remote:target", 2, storageScope)).toBeNull();
  unregister();
});

it("同目录的新项目也交接附件，由草稿代际消费一次", () => {
  const attachment = {
    id: "same-root",
    file: new File(["data"], "draft.txt"),
    filename: "draft.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  const snapshot = {
    sourceWorkspaceKey: "/same",
    draft: { text: "draft" },
    attachments: [attachment],
  };
  stageV4ComposerDraftAttachments("/same", undefined, 2, snapshot, storageScope);
  expect(consumeV4ComposerDraftAttachments("/same", 2, storageScope)).toEqual([attachment]);
  expect(consumeV4ComposerDraftAttachments("/same", 2, storageScope)).toBeNull();
});

it("discards a handoff after the target draft has been replaced", () => {
  stageV4ComposerDraftAttachments(
    "/target",
    undefined,
    2,
    {
      sourceWorkspaceKey: "/source",
      draft: { text: "old" },
      attachments: [],
    },
    storageScope,
  );
  expect(consumeV4ComposerDraftAttachments("/target", 3, storageScope)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("/target", 2, storageScope)).toBeNull();
});

it("同目录不同实际 root/profile 的实时编辑器与附件交接独立", () => {
  const attachmentA = {
    id: "a",
    file: new File(["a"], "a.txt"),
    filename: "a.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
  };
  const attachmentB = {
    id: "b",
    file: new File(["b"], "b.txt"),
    filename: "b.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
  };
  for (const [scope, text, attachment] of [
    [storageScope, "profile A", attachmentA],
    [otherStorageScope, "profile B", attachmentB],
  ] as const) {
    readerCleanup.push(
      registerV4ComposerDraftReader(
        "/same",
        () => ({
          draft: { text },
          attachments: [attachment],
        }),
        scope,
      ),
    );
  }
  const a = captureV4ComposerDraftHandoff("/same", undefined, "desktop", storageScope);
  const b = captureV4ComposerDraftHandoff("/same", undefined, "desktop", otherStorageScope);
  expect(a.draft.text).toBe("profile A");
  expect(b.draft.text).toBe("profile B");
  stageV4ComposerDraftAttachments("/target", undefined, 4, a, storageScope);
  stageV4ComposerDraftAttachments("/target", undefined, 4, b, otherStorageScope);
  expect(consumeV4ComposerDraftAttachments("/target", 4, otherStorageScope)).toEqual([attachmentB]);
  expect(consumeV4ComposerDraftAttachments("/target", 4, storageScope)).toEqual([attachmentA]);
  expect(
    captureV4ComposerDraftHandoff("/same", undefined, "desktop", storageScope).draft.text,
  ).toBe("profile A");
});

it("未知 actual scope 不捕获已知域编辑器，也不暂存或消费附件", () => {
  const attachment = {
    id: "known",
    file: new File(["data"], "known.txt"),
    filename: "known.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  readerCleanup.push(
    registerV4ComposerDraftReader(
      "/same",
      () => ({
        draft: { text: "known" },
        attachments: [attachment],
      }),
      storageScope,
    ),
  );
  readerCleanup.push(
    registerV4ComposerDraftReader(
      "/same",
      () => ({
        draft: { text: "unknown" },
        attachments: [attachment],
      }),
      null,
    ),
  );
  const unknown = captureV4ComposerDraftHandoff("/same", undefined, "desktop", null);
  expect(unknown.draft.text).toBe("");
  expect(unknown.attachments).toEqual([]);
  const known = captureV4ComposerDraftHandoff("/same", undefined, "desktop", storageScope);
  expect(known.draft.text).toBe("known");
  stageV4ComposerDraftAttachments("/target", undefined, 1, known, null);
  expect(consumeV4ComposerDraftAttachments("/target", 1, storageScope)).toBeNull();
  stageV4ComposerDraftAttachments("/target", undefined, 1, known, storageScope);
  expect(consumeV4ComposerDraftAttachments("/target", 1, null)).toBeNull();
  expect(consumeV4ComposerDraftAttachments("/target", 1, storageScope)).toEqual([attachment]);
});
