import type { AgentSummary, Locale } from "@zcode/shared";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";

type SubagentMentionInput = Pick<
  AgentSummary,
  "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
>;

function getSubagentSourcePriority(agent: SubagentMentionInput): number {
  if (agent.scope === "workspace") {
    return 0;
  }
  if (agent.source === "user") {
    return 1;
  }
  return 2;
}

// 来源标签的 message key：与 skillsMentionProvider（resolveSkillSourceLabel 的 locale 感知
// source label）行为对齐，避免同一 mention 体系里 skills 已本地化而 subagents 恒为英文。
// 文案落在全部 locale 文件（zh-CN / en-US），与 chat.mention.* 既有 key 风格一致。
const SUBAGENT_SOURCE_LABEL_KEYS = {
  workspace: "chat.mention.subagents.source.workspace",
  plugin: "chat.mention.subagents.source.plugin",
  builtIn: "chat.mention.subagents.source.builtIn",
  user: "chat.mention.subagents.source.user",
} as const;

function resolveSubagentSourceLabel(agent: SubagentMentionInput, locale?: Locale): string {
  let labelKey: keyof typeof SUBAGENT_SOURCE_LABEL_KEYS;
  if (agent.scope === "workspace") {
    labelKey = "workspace";
  } else if (agent.source === "plugin") {
    labelKey = "plugin";
  } else if (agent.source === "built-in") {
    labelKey = "builtIn";
  } else {
    labelKey = "user";
  }
  // 与 IntlProvider.createIntl 相同的回退策略：查不到 key 时回退 key 本身。
  // 非组件上下文按 locale 直查 message 表（ErrorBoundary.tsx 同款先例）。
  const messages = locale === "zh-CN" ? zhCN : enUS;
  return messages[SUBAGENT_SOURCE_LABEL_KEYS[labelKey]] ?? SUBAGENT_SOURCE_LABEL_KEYS[labelKey];
}

export function mapSubagentsToMentionItemsForTest(
  agents: SubagentMentionInput[],
  locale?: Locale,
): MentionItem[] {
  const uniqueAgentsByName = new Map<string, SubagentMentionInput>();
  for (const agent of agents) {
    if (!agent.enabled) {
      continue;
    }
    const key = agent.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = uniqueAgentsByName.get(key);
    if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {
      uniqueAgentsByName.set(key, agent);
    }
  }

  return [...uniqueAgentsByName.values()].map((agent) => {
    const sourceLabel = resolveSubagentSourceLabel(agent, locale);
    const model = agent.modelSelection
      ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
      : undefined;
    return {
      id: `subagent:${agent.id}`,
      category: "subagents",
      label: agent.name,
      description: agent.description ? `${sourceLabel} · ${agent.description}` : sourceLabel,
      value: agent.name,
      markdown: buildSubagentMentionMarkdown(agent.name),
      keywords: [
        agent.name,
        agent.description,
        agent.scope,
        agent.source,
        sourceLabel,
        model ?? "",
        agent.path,
      ],
      data: {
        path: agent.path,
        scope: agent.scope,
        source: agent.source,
        model,
      },
    } satisfies MentionItem;
  });
}
