import { describe, expect, it } from "vitest";
import type { ZCodeSlashCommand } from "@zcode/shared";
import {
  buildAppSlashCommandSuggestions,
  buildSkillSuggestions,
  buildSubagentSuggestions,
  buildSlashSuggestions,
  isAppSlashCommandSuggestion,
  replaceActiveSlashToken,
  shouldOfferSideSlashCommand,
} from "../src/slashCommandHelpers.js";

describe("slashCommandHelpers", () => {
  it("旧 Agent 的 Plan 仍由本地计划模式操作提供，OMP 则展示原生命令", () => {
    const [action] = buildAppSlashCommandSuggestions([
      { value: "plan", label: "计划模式", description: "开启计划模式", run: () => {} },
    ]);
    const catalog: ZCodeSlashCommand[] = [
      {
        name: "/PLAN",
        description: "Toggle native planning",
        inputHint: "/plan [on|off]",
        source: "builtin",
      },
    ];
    expect(action).toMatchObject({ value: "plan", label: "计划模式" });
    expect(isAppSlashCommandSuggestion(action!)).toBe(true);
    expect(buildSlashSuggestions(catalog)).toEqual([]);
    const [native] = buildSlashSuggestions(catalog, true);
    expect(native).toMatchObject({
      value: "PLAN",
      label: "/plan [on|off]",
      description: catalog[0]!.description,
    });
    expect(isAppSlashCommandSuggestion(native!)).toBe(false);
  });

  it("buildSlashSuggestions 逐项展示 CLI catalog，不在 UI 维护内建白名单", () => {
    const commands: ZCodeSlashCommand[] = [
      {
        name: "review",
        description: "run review",
        inputHint: "/review [scope]",
        source: "custom",
      },
      {
        name: "goal",
        description: "set goal",
        source: "builtin",
      },
      {
        name: "compact",
        description: "compact context",
        source: "builtin",
      },
      {
        name: "init",
        description: "create AGENTS.md",
        inputHint: "/init [notes]",
        source: "builtin",
      },
      {
        name: "model",
        description: "switch model",
        source: "builtin",
      },
    ];
    const result = buildSlashSuggestions(commands);
    expect(result.map(({ value, label, description }) => ({ value, label, description }))).toEqual([
      { value: "review", label: "/review [scope]", description: "run review" },
      { value: "goal", label: "/goal", description: "set goal" },
      { value: "compact", label: "/compact", description: "compact context" },
      { value: "init", label: "/init [notes]", description: "create AGENTS.md" },
      { value: "model", label: "/model", description: "switch model" },
    ]);
  });

  it("buildSlashSuggestions 不按旧协议 source 字段过滤 CLI catalog", () => {
    const result = buildSlashSuggestions([
      {
        name: "review",
        description: "legacy custom without source",
      },
      {
        name: "compact",
        description: "Compact context",
      },
    ]);

    expect(result.map((item) => item.value)).toEqual(["review", "compact"]);
  });

  it("buildSlashSuggestions 会规范化已带 / 的 ZCode Agent 命令名", () => {
    const result = buildSlashSuggestions([
      {
        name: "/compact",
        description: "Compact context",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ value: "compact", label: "/compact" });
    expect(replaceActiveSlashToken("/comp", "", `/${result[0]!.value}`)?.text).toBe("/compact ");
  });

  it("buildSlashSuggestions 不为缺失的 CLI catalog 补任何命令", () => {
    expect(buildSlashSuggestions([])).toEqual([]);
  });

  it("原生 canonical 和 alias 展示目录描述与 hint，但选择只插入命令名", () => {
    const catalog: ZCodeSlashCommand[] = [
      {
        name: "compact",
        description: "Summarize the current session",
        inputHint: "/compact [instructions]",
        source: "builtin",
      },
      {
        name: "compress",
        description: "Alias for /compact",
        inputHint: "/compress [instructions]",
        source: "builtin",
      },
      {
        name: "goal",
        description: "Manage session goals",
        inputHint: "/goal <set|show|pause|resume>",
        source: "builtin",
      },
      {
        name: "move",
        description: "Move this session",
        inputHint: "/move <directory>",
        source: "builtin",
      },
      { name: "wt", description: "Manage worktrees", inputHint: "/wt <action>", source: "builtin" },
    ];
    const suggestions = buildSlashSuggestions(catalog, true);
    expect(suggestions).toHaveLength(catalog.length);
    for (const [index, suggestion] of suggestions.entries()) {
      const command = catalog[index]!;
      expect(suggestion).toMatchObject({
        value: command.name,
        label: command.inputHint,
        description: command.description,
      });
      expect(isAppSlashCommandSuggestion(suggestion)).toBe(false);
      expect(replaceActiveSlashToken("/", "", `/${suggestion.value}`)?.text).toBe(
        `/${command.name} `,
      );
    }
  });

  it("buildSubagentSuggestions 只包含 enabled subagents", () => {
    const result = buildSubagentSuggestions([
      {
        id: "a1",
        name: "reviewer",
        description: "review code",
        path: "./agents/reviewer.md",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
      {
        id: "a2",
        name: "disabled",
        description: "hidden",
        path: "./agents/disabled.md",
        scope: "user",
        source: "user",
        enabled: false,
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: "subagent:a1",
        trigger: "/",
        value: "reviewer",
      }),
    ]);
  });

  it("buildSubagentSuggestions 复用 mention provider 的同名折叠优先级", () => {
    const result = buildSubagentSuggestions([
      {
        id: "agent-plugin",
        name: "reviewer",
        description: "plugin reviewer",
        path: "/plugins/reviewer/agent.md",
        scope: "user",
        source: "plugin",
        enabled: true,
      },
      {
        id: "agent-workspace",
        name: "reviewer",
        description: "workspace reviewer",
        path: "/repo/.claude/agents/reviewer.md",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "subagent:agent-workspace",
      value: "reviewer",
      description: "Workspace · workspace reviewer",
      data: {
        path: "/repo/.claude/agents/reviewer.md",
        scope: "workspace",
      },
    });
  });

  it("buildSkillSuggestions 让 / 面板复用 $ 技能展示语义", () => {
    const result = buildSkillSuggestions(
      [
        {
          id: "glm:workspace:code-review",
          name: "code-review",
          description: "review code",
          path: "/repo/.zcode/skills/code-review/SKILL.md",
          scope: "workspace",
          pluginName: undefined,
        },
      ],
      "en-US",
    );

    expect(result).toEqual([
      {
        id: "skill:glm:workspace:code-review",
        trigger: "/",
        value: "code-review",
        label: "$code-review",
        description: "Workspace · review code",
        keywords: ["code-review", "review code", "workspace", "skill", "skills"],
        data: {
          path: "/repo/.zcode/skills/code-review/SKILL.md",
          scope: "workspace",
        },
      },
    ]);
  });

  it("replaceActiveSlashToken 支持把 /token 替换成 $skill", () => {
    expect(replaceActiveSlashToken("请执行 /cod", "e-review 这里", "$code-review")).toEqual({
      cursorOffset: 17,
      text: "请执行 $code-review  这里",
    });
  });

  it("replaceActiveSlashToken 不把完整 token 后面的正文当 tail 删除", () => {
    expect(replaceActiveSlashToken("请执行 /goal", "修复这个问题", "/goal")).toEqual({
      cursorOffset: 10,
      text: "请执行 /goal 修复这个问题",
    });
  });

  // SSC28：App 层 `/side` 命令由渲染层注入，不写入 CLI catalog。
  it("buildAppSlashCommandSuggestions 生成 App 层命令建议，关键词含中英文别名", () => {
    const noop = () => {};
    const result = buildAppSlashCommandSuggestions([
      {
        value: "side",
        description: "新建并打开一个辅助对话",
        keywords: ["side", "辅助对话", "辅助"],
        run: noop,
      },
    ]);

    expect(result).toEqual([
      {
        id: "app-slash:side",
        trigger: "/",
        value: "side",
        label: "/side",
        description: "新建并打开一个辅助对话",
        keywords: ["side", "新建并打开一个辅助对话", "辅助对话", "辅助"],
      },
    ]);
    expect(isAppSlashCommandSuggestion(result[0]!)).toBe(true);
  });

  it("App 层命令与 CLI 命令的建议 id 前缀互不冲突", () => {
    const cli = buildSlashSuggestions([{ name: "side", description: "cli side" }]);
    expect(isAppSlashCommandSuggestion(cli[0]!)).toBe(false);
  });

  // 多个 App 命令逐项保留，避免建议列表被截断。
  it("buildAppSlashCommandSuggestions 逐项保留多个 App 命令建议", () => {
    const run = () => {};
    const shared = { description: "新建并打开一个辅助对话", keywords: ["side", "btw"], run };
    const result = buildAppSlashCommandSuggestions([
      { value: "side", ...shared },
      { value: "btw", ...shared },
    ]);

    expect(result.map((item) => ({ id: item.id, label: item.label }))).toEqual([
      { id: "app-slash:side", label: "/side" },
      { id: "app-slash:btw", label: "/btw" },
    ]);
    expect(result.every((item) => isAppSlashCommandSuggestion(item))).toBe(true);
  });

  // SSC29：草稿态、辅助对话自身、只读与手机 viewport 不提供 `/side`。
  it("shouldOfferSideSlashCommand 门禁只在主会话可用", () => {
    const base = {
      isDraft: false,
      selectionSideChat: false,
      readOnly: false,
      isMobileViewport: false,
    };
    expect(shouldOfferSideSlashCommand(base)).toBe(true);
    expect(shouldOfferSideSlashCommand({ ...base, isDraft: true })).toBe(false);
    expect(shouldOfferSideSlashCommand({ ...base, selectionSideChat: true })).toBe(false);
    expect(shouldOfferSideSlashCommand({ ...base, readOnly: true })).toBe(false);
    expect(shouldOfferSideSlashCommand({ ...base, isMobileViewport: true })).toBe(false);
  });
});
