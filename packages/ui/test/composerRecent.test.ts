import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/logger.js";
import {
  captureComposerRecentSubmission as captureScopedRecent,
  readComposerRecent as readScopedRecent,
  resolveDraftInitialModelSelection,
  prepareComposerRecentReceipt,
  acceptComposerRecentReceipt,
} from "@/lib/composerRecent.js";
import { resolveComposerScope } from "@/v4/composer/composerDraftStore.js";

const storageScope = "opaque-native-root-profile-a";
function fixtureScope(identity?: string) {
  return resolveComposerScope(null, identity, "desktop", storageScope);
}
function captureComposerRecentSubmission(...args: Parameters<typeof captureScopedRecent>) {
  return captureScopedRecent(args[0], args[1], args[2], args[3], args[4] ?? fixtureScope(args[2]));
}
function readComposerRecent(...args: Parameters<typeof readScopedRecent>) {
  return readScopedRecent(args[0], args[1], args[2], args[3] ?? fixtureScope(args[1]));
}
function currentStorageKey(target: {
  getItem(key: string): string | null;
  setItem: { (key: string, value: string): void; mockClear(): unknown };
  values: Map<string, string>;
}) {
  captureComposerRecentSubmission(
    "/repo",
    { modelSelection: selection, mode: "build" },
    undefined,
    target,
  )();
  const key = [...target.values.keys()][0]!;
  target.values.clear();
  target.setItem.mockClear();
  return key;
}

vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
}

const selection = { providerId: "provider", modelId: "model", options: { reasoningLevel: "high" } };
const legacyKey = "zcode-model-selection-recent-v1:/repo";

describe("composerRecent", () => {
  beforeEach(() => vi.clearAllMocks());
  it("同 workspace 的实际 root/profile Recent 独立，迟到 receipt 与 ACK 不越域且切回恢复", () => {
    const target = storage();
    const a = fixtureScope();
    const b = { ...a, storageScope: "opaque-native-other-root-profile" };
    const lateA = prepareComposerRecentReceipt(a, { modelSelection: selection, mode: "yolo" });
    const ackA = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
      a,
    );
    captureComposerRecentSubmission(
      "/repo",
      {
        modelSelection: { ...selection, modelId: "model-b" },
        mode: "plan",
      },
      undefined,
      target,
      b,
    )();
    ackA();
    expect(readComposerRecent("/repo", undefined, target, a)?.mode).toBe("build");
    acceptComposerRecentReceipt(lateA, target);
    expect(readComposerRecent("/repo", undefined, target, a)).toEqual({
      modelSelection: selection,
      mode: "yolo",
    });
    expect(readComposerRecent("/repo", undefined, target, b)).toEqual({
      modelSelection: { ...selection, modelId: "model-b" },
      mode: "plan",
    });
    expect(readComposerRecent("/repo", undefined, target, a)?.modelSelection).toEqual(selection);
  });

  it("断连或换代期间未知 actual scope 不接纳 Recent，也不读取其他域", () => {
    const target = storage();
    const unknown = { ...fixtureScope(), storageScope: null };
    captureScopedRecent(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
      unknown,
    )();
    expect(
      acceptComposerRecentReceipt(
        prepareComposerRecentReceipt(unknown, {
          modelSelection: selection,
          mode: "yolo",
        }),
        target,
      ),
    ).toBe(false);
    expect(readScopedRecent("/repo", undefined, target, unknown)).toBeNull();
    expect(target.setItem).not.toHaveBeenCalled();
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
  });

  it("PD07 持久化的接纳顺序阻止恢复查询中的旧配置回写", () => {
    const target = storage();
    const scope = { ...fixtureScope(), projectId: "p" };
    const old = prepareComposerRecentReceipt(scope, { modelSelection: selection, mode: "build" });
    const latest = prepareComposerRecentReceipt(scope, {
      modelSelection: { ...selection, modelId: "next" },
      mode: "yolo",
    });
    expect(acceptComposerRecentReceipt(latest, target)).toBe(true);
    expect(acceptComposerRecentReceipt(JSON.parse(JSON.stringify(old)), target)).toBe(true);
    expect(readComposerRecent("/any", undefined, target, scope)).toMatchObject({
      mode: "yolo",
      modelSelection: { modelId: "next" },
    });
  });
  it("PD04 Recent 跟随项目而非目录，任务配置跨新目录复用", () => {
    const target = storage();
    const p = { ...fixtureScope(), projectId: "p" };
    const task = { ...p, projectId: null };
    const accept = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      undefined,
      target,
      p,
    );
    expect(readComposerRecent("/repo", undefined, target, p)).toBeNull();
    accept();
    expect(readComposerRecent("/new-root", undefined, target, p)).toEqual({
      modelSelection: selection,
      mode: "yolo",
    });
    expect(readComposerRecent("/repo", undefined, target, { ...p, projectId: "q" })).toBeNull();
    expect(readComposerRecent("/repo", undefined, target, task)).toBeNull();
    captureComposerRecentSubmission(
      "/task-a",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
      task,
    )();
    expect(readComposerRecent("/task-b", undefined, target, task)?.mode).toBe("build");
    expect(
      readComposerRecent("/task-b", undefined, target, { ...task, clientNamespace: "mobile" }),
    ).toBeNull();
  });

  it("旧 Recent 没有可信 root/profile 归属，不导入当前域也不改写旧记录", () => {
    const target = storage();
    target.values.set(legacyKey, JSON.stringify(selection));
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
    expect(readScopedRecent("/repo", undefined, target)).toBeNull();
    expect(target.values.get(legacyKey)).toBe(JSON.stringify(selection));
    expect(target.setItem).not.toHaveBeenCalled();
  });

  it.each([
    [JSON.stringify({ modelSelection: selection, mode: "invalid" }), { modelSelection: selection }],
    [JSON.stringify({ modelSelection: { bad: true }, mode: "yolo" }), { mode: "yolo" }],
    [JSON.stringify({ mode: "plan" }), { mode: "plan" }],
    [
      JSON.stringify({
        providerId: "provider",
        modelId: "model",
        options: { maxOutputTokens: 4096 },
      }),
      null,
    ],
    ["{}", null],
    ["null", null],
    ["broken", null],
  ])("独立校验模型与模式：%s", (raw, expected) => {
    const target = storage();
    target.values.set(currentStorageKey(target), raw);
    expect(readComposerRecent("/repo", undefined, target)).toEqual(expected);
  });

  it("接受后一次写入冻结的模型与模式，未接纳候选不改变 Recent", () => {
    const target = storage();
    const submission = { modelSelection: { ...selection, options: {} }, mode: "yolo" as const };
    const accept = captureComposerRecentSubmission("/repo", submission, undefined, target);
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
    submission.modelSelection.modelId = "edited-after-submit";
    accept();
    accept();
    expect(target.setItem).toHaveBeenCalledTimes(1);
    expect(readComposerRecent("/repo", undefined, target)).toEqual({
      modelSelection: { providerId: "provider", modelId: "model" },
      mode: "yolo",
    });
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    );
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("yolo");
  });

  it("迟到的旧 accepted 不覆盖较新已接纳提交；较新失败不阻断较旧成功", () => {
    const target = storage();
    const older = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      undefined,
      target,
    );
    const newer = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "plan" },
      undefined,
      target,
    );
    newer();
    older();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("plan");
    const accepted = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "edit" },
      undefined,
      target,
    );
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    );
    accepted();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("edit");
  });

  it("指向加速卡 Provider 的提交不写入 Recent，保留上一次合法记录（spec §5.1）", () => {
    const target = storage();
    captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      undefined,
      target,
    )();
    const accelerated = captureComposerRecentSubmission(
      "/repo",
      {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        mode: "build",
      },
      undefined,
      target,
    );
    accelerated();
    expect(readComposerRecent("/repo", undefined, target)).toEqual({
      modelSelection: selection,
      mode: "build",
    });
  });

  it("读取自愈：指向加速卡 Provider 的存量模型叶子被丢弃，mode 保留（spec §5.1）", () => {
    const target = storage();
    const key = currentStorageKey(target);
    target.values.set(
      key,
      JSON.stringify({
        modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
        mode: "yolo",
      }),
    );
    expect(readComposerRecent("/repo", undefined, target)).toEqual({ mode: "yolo" });
    // 旧版纯 ModelSelection 格式同样丢弃，避免新草稿种子指向隐藏加速身份。
    target.values.set(
      key,
      JSON.stringify({ providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" }),
    );
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
  });

  it("本地路径与同路径不同远端分别保存，空 identity 使用本地路径", () => {
    const target = storage();
    const local = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "build" },
      " ",
      target,
    );
    const remoteA = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      " ssh://a/repo ",
      target,
    );
    const remoteB = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "plan" },
      "ssh://b/repo",
      target,
    );
    remoteB();
    remoteA();
    local();
    expect(readComposerRecent("/repo", undefined, target)?.mode).toBe("build");
    expect(readComposerRecent("/repo", "ssh://a/repo", target)?.mode).toBe("yolo");
    expect(readComposerRecent("/repo", "ssh://b/repo", target)?.mode).toBe("plan");
    expect(readComposerRecent("/elsewhere", undefined, target)?.mode).toBe("build");
  });

  it("存储不可用或写入失败不抛给已接纳发送", () => {
    const failure = new Error("quota exceeded");
    const target = {
      getItem: () => {
        throw failure;
      },
      setItem: () => {
        throw failure;
      },
    };
    expect(readComposerRecent("/repo", undefined, target)).toBeNull();
    const accept = captureComposerRecentSubmission(
      "/repo",
      { modelSelection: selection, mode: "yolo" },
      undefined,
      target,
    );
    expect(accept).not.toThrow();
    expect(
      captureComposerRecentSubmission(
        "/repo",
        { modelSelection: selection, mode: "yolo" },
        undefined,
        null,
      ),
    ).not.toThrow();
  });

  it("非法提交配置不阻断发送侧的 Recent 捕获", () => {
    vi.clearAllMocks();
    const target = storage();
    const invalidMode = {
      modelSelection: selection,
      mode: "invalid",
    } as never;
    const invalidModel = {
      modelSelection: null,
      mode: "yolo",
    } as never;

    expect(() =>
      captureComposerRecentSubmission("/repo", invalidMode, undefined, target),
    ).not.toThrow();
    expect(() =>
      captureComposerRecentSubmission("/repo", invalidModel, undefined, target),
    ).not.toThrow();
    expect(target.setItem).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("失效 Model 清空；失效 Reasoning 保留模型并清空档位", () => {
    const view = {
      revision: 1,
      preferredSelection: {
        providerId: "provider",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      },
      providers: [
        {
          providerId: "provider",
          config: {},
          models: [
            {
              modelId: "model-a",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
            {
              modelId: "model-b",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
            },
          ],
        },
      ],
    } as const;
    expect(
      resolveDraftInitialModelSelection(view, {
        providerId: "removed",
        modelId: "removed",
      }),
    ).toEqual({ selection: null, invalidated: true });
    expect(
      resolveDraftInitialModelSelection(view, {
        providerId: "provider",
        modelId: "model-a",
        options: { reasoningLevel: "removed" },
      }),
    ).toEqual({ selection: { providerId: "provider", modelId: "model-a" }, invalidated: true });
    expect(
      resolveDraftInitialModelSelection({ ...view, preferredSelection: undefined }, null),
    ).toEqual({ selection: null, invalidated: false });
  });
});
