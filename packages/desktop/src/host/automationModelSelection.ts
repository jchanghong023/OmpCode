import type { ModelSelection } from "@zcode/shared";
import type { WorkspaceConfigOption } from "@zcode/shared/zcode-protocol-v4";

/** omp 工作区模型目录是自动化提交的事实源；已固定的 run 保持原执行选择。 */
export async function resolveOmpAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  readConfigOptions: () => Promise<readonly WorkspaceConfigOption[]>;
}): Promise<ModelSelection> {
  if (params.fixedSelection) return params.fixedSelection;
  const options = await params.readConfigOptions();
  const modelOption = options.find((option) => option.id === "model" && option.type === "select");
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  const modelValue = selection
    ? `${selection.providerId}/${selection.modelId}`
    : modelOption?.currentValue;
  const entry = modelOption?.options?.find((option) => option.value === modelValue);
  if (!entry) throw new Error("Automation omp 模型不在当前工作区目录中");
  const available = entry.modelThoughtLevels ?? [];
  const reasoningLevel =
    selection?.options?.reasoningLevel ??
    available.filter((level) => level !== "off").at(-1) ??
    available.at(-1);
  if (!reasoningLevel || !available.includes(reasoningLevel)) {
    throw new Error("Automation omp 模型思考档位不可用");
  }
  const slash = entry.value.indexOf("/");
  if (slash <= 0) throw new Error("Automation omp 模型目录值无效");
  return {
    providerId: entry.modelProviderId || entry.value.slice(0, slash),
    modelId: entry.value.slice(slash + 1),
    options: { reasoningLevel },
  };
}
