import type { ModelSelection } from "@zcode/shared";
import type { IModelSelectionService } from "@zcode/services";
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

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}
