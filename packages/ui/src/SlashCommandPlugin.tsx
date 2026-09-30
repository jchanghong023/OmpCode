/* eslint-disable max-lines -- Lexical slash 插件的 trigger/面板/键盘导航同属一个协议状态机，oxfmt 换行后略超 400 行。 */
/**
 * SlashCommandPlugin — Lexical trigger 面板插件
 *
 * 处理 `/` 面板里的 slash commands 和 subagents：
 * 1. `/` 直接展示 ZCode Agent 广播的真实 slash commands，并补充可用 subagents
 * 2. 面板通过 portal 渲染到输入区上方的独立挂载层，展开时直接覆盖消息区
 * 3. 支持 Esc 关闭、上下键切换、Enter / Tab 选中，以及跟随输入做模糊搜索
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useSubagents } from "@/hooks/useSubagents.js";
import { useSkills } from "@/hooks/useSkills.js";
import {
  ompCompletionDedupeKey,
  useOmpCommandCompletion,
} from "./hooks/useOmpCommandCompletion.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { $createPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getActivePromptInputTokenTailLength,
  getBestPromptInputSuggestionIndex,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
  type PromptInputSuggestionItem,
} from "./lib/promptInputTriggers.js";
import { MentionPanel } from "./mentions/components/MentionPanel.js";
import {
  buildAppSlashCommandSuggestions,
  buildSubagentSuggestions,
  buildSlashSuggestions,
  buildSkillSuggestions,
  getTextAroundCursor,
  isAppSlashCommandSuggestion,
  normalizeSlashCommandValue,
  slashComposingQueryOf,
  type SlashCommandPluginProps,
} from "./slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "./slashCommandPanelSections.js";
import { getCurrentTextNodeSelection } from "./mentions/mentionHelpers.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./mentions/activePromptInputToken.js";
import { shouldSlashPanelProcessUpdate } from "./lib/slashPanelUpdateFilter.js";

export function SlashCommandPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  excludedCommandNames,
  appCommands,
}: SlashCommandPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl, locale } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  // 远程 workspace 的 slashCommands 写在 workspaceIdentity 桶。
  // 这里只按 workspacePath 读取会落到 path 桶，表现为 ZCode Agent 已收到 available_commands_update 但 / 面板为空。
  const commands = useSlashCommands(workspacePath, workspaceIdentity);
  const {
    agents,
    loading: subagentsLoading,
    error: subagentsError,
  } = useSubagents(workspacePath, provider, workspaceIdentity);
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    enabled: !disabled && activeTrigger?.trigger === "/",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Fork（omp-project-mode.md）：正在编辑的完整 "/" 命令行（含参数空格）；驱动
  // complete_command 动态候选。null 表示当前不在命令编辑态。
  const [slashText, setSlashText] = useState<string | null>(null);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const commandSuggestions = useMemo(() => {
    const excluded = new Set((excludedCommandNames ?? []).map(normalizeSlashCommandValue));
    const cliSuggestions = buildSlashSuggestions(commands).filter(
      (item) => !excluded.has(item.value),
    );
    // App 层命令追加在 CLI catalog 之后展示；CLI 已提供同名命令时以 CLI 为准，避免遮蔽。
    const cliValues = new Set(cliSuggestions.map((item) => item.value));
    const appSuggestions = buildAppSlashCommandSuggestions(appCommands ?? []).filter(
      (item) => !cliValues.has(item.value) && !excluded.has(item.value),
    );
    return [...cliSuggestions, ...appSuggestions];
  }, [appCommands, commands, excludedCommandNames]);
  // Fork（omp-project-mode.md）：OMP complete_command 动态候选；名称级与静态目录合并
  // （去重），参数级（argument/subcommand）在命令编辑模式单独成组。
  const { items: ompCompletionItems } = useOmpCommandCompletion({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    text: slashText,
    enabled: !disabled && activeTrigger?.trigger === "/",
  });
  const dynamicCommandSuggestions = useMemo(() => {
    const seen = new Set(commandSuggestions.map((item) => normalizeSlashCommandValue(item.value)));
    return ompCompletionItems.flatMap((item, index) => {
      // skill 命令已由技能分组（skillsReferenceCatalog）提供，这里再放入命令组会
      // 同名显示两行——与静态投影（ompCommands.ts）排除 skill 源的规则一致。
      if (item.kind === "argument" || item.kind === "subcommand" || item.kind === "skill") {
        return [];
      }
      const value = item.insertText.replace(/^\//, "").trim();
      if (!value || seen.has(normalizeSlashCommandValue(value))) return [];
      return [
        {
          // id 带序号：omp 可能返回同 insertText 的多条候选（不同替换区间/描述）。
          id: `omp-cmd:${index}:${ompCompletionDedupeKey(item)}`,
          trigger: "/" as const,
          value,
          label: item.label || item.insertText,
          description: item.description ?? item.hint ?? "",
          keywords: [item.description, item.hint].filter((k): k is string => typeof k === "string"),
        },
      ];
    });
  }, [commandSuggestions, ompCompletionItems]);
  const dynamicArgumentSuggestions = useMemo(
    () =>
      ompCompletionItems.flatMap((item, index) => {
        if (item.kind !== "argument" && item.kind !== "subcommand") return [];
        if (!item.insertText.trim()) return [];
        return [
          {
            id: `omp-arg:${index}:${ompCompletionDedupeKey(item)}`,
            trigger: "/" as const,
            value: item.insertText.trim(),
            label: item.label || item.insertText,
            description: item.description ?? item.hint ?? "",
          },
        ];
      }),
    [ompCompletionItems],
  );
  const subagentSuggestions = useMemo(
    () => buildSubagentSuggestions(agents, locale),
    [agents, locale],
  );
  const skillSuggestions = useMemo(
    () =>
      buildSkillSuggestions(
        filterSkillsForProvider(skills, provider).filter((skill) => skill.enabled),
        locale,
      ),
    [locale, provider, skills],
  );
  // Fork：命令编辑模式（query 含空格 = 已输入命令名，正在补参数）只显示动态参数候选，
  // 过滤键取最后一个词；名称模式合并动态名称候选。
  const argumentMode = (activeTrigger?.query ?? "").includes(" ");
  const filterQuery = useMemo(() => {
    const query = activeTrigger?.query ?? null;
    if (query === null) return null;
    return argumentMode ? query.slice(query.lastIndexOf(" ") + 1) : query;
  }, [activeTrigger?.query, argumentMode]);
  const filteredCommandSuggestions = useMemo(
    () =>
      argumentMode
        ? filterPromptInputSuggestions(dynamicArgumentSuggestions, filterQuery)
        : [
            ...filterPromptInputSuggestions(commandSuggestions, filterQuery),
            ...filterPromptInputSuggestions(dynamicCommandSuggestions, filterQuery),
          ],
    [
      argumentMode,
      commandSuggestions,
      dynamicArgumentSuggestions,
      dynamicCommandSuggestions,
      filterQuery,
    ],
  );
  const filteredSubagentSuggestions = useMemo(
    () =>
      argumentMode
        ? []
        : filterPromptInputSuggestions(subagentSuggestions, activeTrigger?.query ?? null),
    [argumentMode, subagentSuggestions, activeTrigger?.query],
  );
  const filteredSkillSuggestions = useMemo(
    () =>
      argumentMode
        ? []
        : filterPromptInputSuggestions(skillSuggestions, activeTrigger?.query ?? null),
    [argumentMode, skillSuggestions, activeTrigger?.query],
  );
  const filteredSuggestions = useMemo(
    () => [
      ...filteredCommandSuggestions,
      ...filteredSkillSuggestions,
      ...filteredSubagentSuggestions,
    ],
    [filteredCommandSuggestions, filteredSkillSuggestions, filteredSubagentSuggestions],
  );
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  // 参数模式（query 含空格）只有 complete_command 动态候选：候选到达才开面板。
  // 能力缺失由 useOmpCommandCompletion 记忆（不再发请求、loading 不置真），避免
  // 旧核每键空面板闪烁；能力可用时 loading 期的短暂等待好过空面板闪烁。
  const isOpen =
    !disabled && activeTrigger !== null && (!argumentMode || dynamicArgumentSuggestions.length > 0);

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    // 面板展示需要保留 commands/subagents 分组顺序，但键盘默认选中不能固定落在第一个分组。
    // 例如 `/rev` 时 command 描述里的弱匹配可能排在 subagent 分组前面，导致无法默认选中最佳 subagent。
    // 这里按统一的模糊评分选择全局最佳项，同时不改变面板的分组展示顺序。
    setSelectedIndex(
      getBestPromptInputSuggestionIndex(filteredSuggestions, activeTrigger?.query ?? null),
    );
  }, [activeSignature, activeTrigger?.query, filteredSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filteredSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      editorState.read(() => {
        // 历史导航回填含 / 的历史条目时，不应重新打开 slash 面板，
        // 否则面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器，吞掉后续历史翻阅按键。
        if (!shouldSlashPanelProcessUpdate(tags)) {
          activeTokenRef.current = null;
          setSlashText(null);
          setActiveTrigger(null);
          return;
        }

        if (disabled) {
          activeTokenRef.current = null;
          setSlashText(null);
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        const cursorText = selectionState ?? getTextAroundCursor();
        if (!cursorText) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setSlashText(null);
          setActiveTrigger(null);
          return;
        }

        const nextActiveToken = selectionState
          ? reconcileActivePromptInputTokenSnapshot(
              activeTokenRef.current,
              selectionState,
              dirtyElements.size === 0 && dirtyLeaves.size === 0,
            )
          : null;
        const textBeforeCursor = selectionState
          ? selectionState.textBeforeCursor
          : cursorText.textBeforeCursor;
        const baseActiveTrigger = selectionState
          ? nextActiveToken
          : extractActivePromptInputTrigger(cursorText.textBeforeCursor);
        // Fork（omp-project-mode.md）：整行以 "/" 开头且已带空格（正在补参数）时，基础
        // token 正则不再命中；保持面板开启由 complete_command 提供参数级候选。
        const composingQuery = slashComposingQueryOf(textBeforeCursor);
        const nextActiveTrigger =
          baseActiveTrigger?.trigger === "/"
            ? baseActiveTrigger
            : composingQuery !== null
              ? ({ trigger: "/", query: composingQuery } as ActivePromptInputTrigger)
              : null;
        if (!nextActiveTrigger || nextActiveTrigger.trigger !== "/") {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setSlashText(null);
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = selectionState ? nextActiveToken : null;
        setSlashText(
          textBeforeCursor.startsWith("/") && !textBeforeCursor.includes("\n")
            ? textBeforeCursor
            : null,
        );

        const nextSignature = getPromptInputTriggerSignature(nextActiveTrigger);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveTrigger.trigger &&
            current.query === nextActiveTrigger.query
          ) {
            return current;
          }

          return nextActiveTrigger;
        });
      });
    });
  }, [disabled, editor]);

  const applySuggestion = useCallback(
    (suggestion: PromptInputSuggestionItem) => {
      const isAppCommand = isAppSlashCommandSuggestion(suggestion);
      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeSlashTrigger = snapshotRange
          ? activeTokenRef.current
          : (extractActivePromptInputTrigger(selectionState.textBeforeCursor) ??
            (slashComposingQueryOf(selectionState.textBeforeCursor) !== null
              ? ({
                  trigger: "/",
                  query: slashComposingQueryOf(selectionState.textBeforeCursor)!,
                } as ActivePromptInputTrigger)
              : null));
        if (!activeSlashTrigger || activeSlashTrigger.trigger !== "/") {
          return;
        }

        // Fork：命令编辑模式（已带空格）选中的是参数候选；替换最后一个词并按纯文本插入，
        // 不生成命令 mention。
        if (activeSlashTrigger.query.includes(" ")) {
          const before = selectionState.textBeforeCursor;
          const lastSpace = before.lastIndexOf(" ");
          const argumentStart = lastSpace + 1;
          // 光标停在参数词中间时（方向键/点击移动后接受候选），把光标后的词尾一并纳入
          // 替换区间，否则残留半个词（如 `/security ver|se` 接受 `--verbose` 得
          // `--verbose se`）；语义与名称分支消费 token tail 一致。
          const tailLength = /^\S+/.exec(selectionState.textAfterCursor)?.[0].length ?? 0;
          selectionState.selection.setTextNodeRange(
            selectionState.node,
            argumentStart,
            selectionState.node,
            selectionState.cursorOffset + tailLength,
          );
          const replacement = $createTextNode(`${suggestion.value} `);
          selectionState.selection.insertNodes([replacement]);
          replacement.selectEnd();
          dismissedSignatureRef.current = null;
          activeTokenRef.current = null;
          setSelectedIndex(0);
          return;
        }

        const tokenStart =
          snapshotRange?.start ?? selectionState.cursorOffset - activeSlashTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeSlashTrigger,
              selectionState.textAfterCursor,
              suggestion.value,
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );

        if (isAppCommand) {
          // App 层命令"选中即执行"：只移除输入中的 `/xxx` token，不插入 mention、不发送。
          selectionState.selection.removeText();
          return;
        }

        const mentionNode = $createPromptMentionNode(buildSlashApplyMentionPayload(suggestion));
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([mentionNode, trailingWhitespace]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setSlashText(null);
      setActiveTrigger(null);
      setSelectedIndex(0);
      if (isAppCommand) {
        appCommands
          ?.find((command) => normalizeSlashCommandValue(command.value) === suggestion.value)
          ?.run();
        return;
      }
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [appCommands, editor],
  );

  const selectSuggestion = useCallback(
    (index: number) => {
      const suggestion = filteredSuggestions[index];
      if (!suggestion) {
        return false;
      }

      applySuggestion(suggestion);
      return true;
    },
    [applySuggestion, filteredSuggestions],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        // 如果 Esc 关闭后只记 query，不区分 `/` 和 `@`，两个触发器同名查询会互相把面板压住。
        // 这里保存 trigger + query 组合签名，只有当前 token 真正变化后才重新打开，避免一关闭就立刻弹回。
        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, filteredSuggestions.length, isOpen, selectSuggestion, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.slash.title" });
  const hasActiveQuery = (activeTrigger?.query ?? "").trim().length > 0;
  const panelDescription = hasActiveQuery
    ? ""
    : intl.formatMessage({ id: "chat.slash.searchHint" });

  const panelSections = useSlashCommandMentionPanelSections(
    intl,
    commands.length,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    skillsLoading,
    skillsError,
    filteredSubagentSuggestions,
    subagentsLoading,
    subagentsError,
  );

  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger="/"
      sections={panelSections}
      emptyText=""
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectSuggestion}
    />,
    container,
  );
}
