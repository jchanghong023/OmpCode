import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

type FeatureRecommendedPrompt = DraftSuggestedPromptItem & {
  mode: "office" | "coding";
};

// CentOS 7 推荐内容只使用本地任务和内置图标，不引用在线插件或公网素材。
const featureSuggestedPrompts: FeatureRecommendedPrompt[] = [
  {
    id: "local-disk-usage",
    mode: "office",
    iconName: "hard-drive",
    label: { cn: "分析磁盘空间", en: "Review disk usage" },
    prompt: {
      cn: "查看本机磁盘和工作目录的空间占用，列出最大的文件和目录，并说明可以安全检查的清理方向。先不要删除文件。",
      en: "Inspect local disk and workspace usage. List the largest files and directories and suggest safe cleanup candidates. Do not delete anything yet.",
    },
  },
  {
    id: "local-document-summary",
    mode: "office",
    iconName: "file-text",
    label: { cn: "整理本地文档", en: "Summarize local documents" },
    prompt: {
      cn: "阅读我指定的本地文档，提炼结论、待办事项和需要核实的问题，并注明对应的文件位置。",
      en: "Read the local documents I choose. Summarize conclusions, action items and open questions, citing their locations in the files.",
    },
  },
  {
    id: "local-workspace-organize",
    mode: "office",
    iconName: "folder-open",
    label: { cn: "整理工作目录", en: "Organize my workspace" },
    prompt: {
      cn: "检查当前工作目录的文件结构和重复文件，提出整理建议。先列出计划，不要移动或删除文件。",
      en: "Inspect the current workspace structure and duplicate files. Suggest an organization plan without moving or deleting files.",
    },
  },
  {
    id: "local-code-review",
    mode: "coding",
    iconName: "scan-search",
    label: { cn: "检查代码改动", en: "Review code changes" },
    prompt: {
      cn: "检查当前 Git 工作区的未提交改动，找出可能的错误、兼容性问题和缺失的测试，并按影响程度排序。",
      en: "Review uncommitted Git changes for bugs, compatibility issues and missing tests. Sort findings by impact.",
    },
  },
  {
    id: "local-test-failures",
    mode: "coding",
    iconName: "test-tube",
    label: { cn: "排查测试失败", en: "Investigate failing tests" },
    prompt: {
      cn: "运行当前项目已有的相关测试，定位失败原因，提出最小修复并说明如何验证。",
      en: "Run the relevant existing project tests, find the cause of failures and propose the smallest fix with a verification step.",
    },
  },
  {
    id: "local-code-map",
    mode: "coding",
    iconName: "git-branch",
    label: { cn: "梳理项目结构", en: "Map the codebase" },
    prompt: {
      cn: "从当前仓库的源码和文档梳理主要模块、入口和依赖关系，标出我准备修改的功能所在位置。",
      en: "Map the main modules, entry points and dependencies from local source and documentation. Locate the feature I plan to change.",
    },
  },
];

export function getRecommendedPromptPool(isOfficeMode: boolean): DraftSuggestedPromptItem[] {
  const mode = isOfficeMode ? "office" : "coding";
  return featureSuggestedPrompts.filter((item) => item.mode === mode);
}
