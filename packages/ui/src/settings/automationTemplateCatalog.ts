import type { AutomationScheduledTemplateIconName } from "@/settings/AutomationScheduledTemplateIcon.js";
import type { OffPeakTemplateIconName } from "@/settings/OffPeakTemplateIcon.js";

export interface AutomationTemplateLocalizedText {
  cn?: string;
  en?: string;
}

interface AutomationTemplateBase {
  id: string;
  iconName?: string;
  title: AutomationTemplateLocalizedText;
  description: AutomationTemplateLocalizedText;
  prompt: AutomationTemplateLocalizedText;
}

export interface ScheduledAutomationTemplate extends AutomationTemplateBase {
  cronExpr: string;
  icon: AutomationScheduledTemplateIconName;
}

export interface OffPeakAutomationTemplate extends AutomationTemplateBase {
  homepageDescription?: AutomationTemplateLocalizedText;
  customize: boolean;
  icon: OffPeakTemplateIconName;
}

type FormatAutomationMessage = (descriptor: { id: string }) => string;

const CUSTOMIZE_TEMPLATE_MESSAGE_IDS = {
  title: "offPeak.newTask.template.customize.title",
  description: "offPeak.newTask.template.customize.description",
} as const;

export interface AutomationTemplateCatalog {
  scheduled: ScheduledAutomationTemplate[];
  offPeak: OffPeakAutomationTemplate[];
  rejectedScheduledTemplateIds: string[];
}

export function resolveAutomationTemplateText(
  text: AutomationTemplateLocalizedText,
  locale?: string,
): string {
  const isChinese = locale?.startsWith("zh") ?? false;
  const primary = isChinese ? text.cn : text.en;
  const fallback = isChinese ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}

export function resolveOffPeakTemplateText(
  template: OffPeakAutomationTemplate,
  field: "title" | "description" | "homepageDescription",
  locale: string,
  formatMessage: FormatAutomationMessage,
): string {
  if (template.customize) {
    const messageField = field === "homepageDescription" ? "description" : field;
    return formatMessage({ id: CUSTOMIZE_TEMPLATE_MESSAGE_IDS[messageField] });
  }
  const text =
    field === "homepageDescription"
      ? (template.homepageDescription ?? template.description)
      : template[field];
  return resolveAutomationTemplateText(text, locale);
}

export function materializeScheduledTemplateDraft(
  template: ScheduledAutomationTemplate,
  locale: string,
): { templateId: string; title: string; cronExpr: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    cronExpr: template.cronExpr,
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}

export function materializeOffPeakTemplateDraft(
  template: OffPeakAutomationTemplate,
  locale: string,
): { templateId: string; title: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}
