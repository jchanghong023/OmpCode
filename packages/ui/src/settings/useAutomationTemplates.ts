import type { AutomationTemplateCatalog } from "@/settings/automationTemplateCatalog.js";

// 内网发行版只提供手动创建的本地自动化，不向云端请求 Client Scenes 模板。
const localTemplates: AutomationTemplateCatalog & { loading: false } = {
  scheduled: [],
  offPeak: [],
  rejectedScheduledTemplateIds: [],
  loading: false,
};

export function useAutomationTemplates() {
  return localTemplates;
}
