// ============================================================
// 子代理模型的选择面：「配置」弹层与确认窗共用
// ============================================================
// docs/dynamic-workflow/presentation.md「The settings popover」「The confirmation window」。
//
// 从 WorkflowRunSettingsPopover.tsx 提出来：两处选同一件事（子代理跑在哪个模型上），就该是同一份
// 清单（composer 的模型菜单，会话模型排第一）、同一个触发器文案、同一条「换模型取默认思考档」规则。
// 各写一份的话，总有一天确认窗里能选的模型与弹层里能选的不一样。

import { useCallback, useMemo } from "react";
import type { ZCodeConfigOption } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findOmpCatalogEntry,
  ompThoughtOptionForEntry,
  selectionForOmpEntry,
  useOmpModelCatalog,
} from "@/omp-configuration/module.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import type { ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { describeWorkflowSubagentModel } from "./subagent-model-label.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

/** 菜单里「会话模型」那一项的值：落在 encodeCustomModelValue 的值域之外，不会与真实模型相撞。 */
const SESSION_MODEL_VALUE = "workflow-settings:session-model";

/** 模型清单的作用域与会话模型：宿主给。 */
export interface WorkflowSettingsModelScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 会话当前模型（首项与触发器用它的名字）；缺席时首项只写「会话模型」。 */
  sessionModel?: { providerId: string; modelId: string };
}

/** 一个模型选择在屏幕上的样子。 */
export interface WorkflowSettingsModelFace {
  /** 菜单值（会话模型是占位值）。 */
  value: string;
  /** 触发器上的名字：会话模型的名字，或规范串的人话名。 */
  triggerLabel: string;
  /** 清单读好了却找不到它：被删或停用。 */
  unavailable: boolean;
  /** 它的思考档；没有档位（或不可用）即 null。 */
  thoughtOption: ZCodeConfigOption | null;
}

export function useWorkflowSettingsModelChoices(scope: WorkflowSettingsModelScope) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const modelRead = useOmpModelCatalog(
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  );
  const { catalog, modelGroups: groups } = modelRead;
  const providerName = useCallback(
    (providerId: string) =>
      catalog?.entries.find((entry) => entry.providerId === providerId)?.providerName,
    [catalog],
  );

  const sessionModel = scope.sessionModel;
  const sessionModelName =
    sessionModel === undefined
      ? format("chat.toolCall.workflow.run.settings.model.sessionFallback")
      : (findOmpCatalogEntry(catalog, sessionModel.providerId, sessionModel.modelId)?.modelName ??
        formatProviderModelLabel(
          sessionModel.providerId,
          providerName(sessionModel.providerId),
          sessionModel.modelId,
        ));
  const sessionBadge = format("chat.toolCall.workflow.run.settings.model.session");
  // 两个字段都是字符串，所以这一项只在文案真变了时换引用；下游的模型选择器是 memo 组件。
  const sessionModelItem: ModelSelectGroupItem = useMemo(
    () => ({
      key: "workflow-settings:session-model",
      value: SESSION_MODEL_VALUE,
      name: sessionModelName,
      badgeLabel: sessionBadge,
    }),
    [sessionModelName, sessionBadge],
  );

  const describe = useCallback(
    (model: WorkflowRunSettingsModel): WorkflowSettingsModelFace => {
      const value =
        model.kind === "session"
          ? SESSION_MODEL_VALUE
          : encodeCustomModelValue(model.providerId, model.modelId);
      const entry =
        model.kind === "model"
          ? findOmpCatalogEntry(catalog, model.providerId, model.modelId)
          : undefined;
      // 可用性只取目标 workspace 的原生目录，不再把 Host 账户清单当作模型事实。
      const unavailable = model.kind === "model" && catalog !== null && groups.length > 0 && !entry;
      const canonical = workflowRunSettingsModelCanonical(model);
      const triggerLabel =
        model.kind === "session" || canonical === undefined
          ? sessionModelName
          : (entry?.modelName ??
            describeWorkflowSubagentModel(canonical, {
              formatMessage: intl.formatMessage.bind(intl),
              providerName,
            }).name);
      const nativeThoughtOption = ompThoughtOptionForEntry(entry);
      // 已存配置的缺省/未知档位必须原样保留；原生默认档仅用于用户显式换模型。
      const thoughtOption =
        nativeThoughtOption !== null && model.kind === "model"
          ? { ...nativeThoughtOption, currentValue: model.level ?? "" }
          : null;
      return { value, triggerLabel, unavailable, thoughtOption };
    },
    [catalog, groups, intl, providerName, sessionModelName],
  );

  /** 菜单选中一项 → 新的模型选择。换模型即取它在注册表里的默认思考档；同一个模型保留当前档。 */
  const pick = useCallback(
    (value: string, current: WorkflowRunSettingsModel): WorkflowRunSettingsModel => {
      if (value === SESSION_MODEL_VALUE) return { kind: "session" };
      const picked = parseModelPickerValue(value);
      const same =
        current.kind === "model" &&
        current.providerId === picked.providerId &&
        current.modelId === picked.modelId;
      const entry = findOmpCatalogEntry(catalog, picked.providerId, picked.modelId);
      const level = same
        ? current.level
        : entry
          ? selectionForOmpEntry(entry).options?.reasoningLevel
          : undefined;
      return {
        kind: "model",
        providerId: picked.providerId,
        modelId: picked.modelId,
        ...(level === undefined ? {} : { level }),
      };
    },
    [catalog],
  );

  return {
    /** 清单还没读好（读好之前字段禁用）。 */
    loading: modelRead.loading || modelRead.status === "idle",
    /** 原生配置已到达但无可用目录：不回退 Host 账户模型。 */
    noCatalog: !modelRead.loading && modelRead.status !== "idle" && groups.length === 0,
    groups,
    providerName,
    sessionBadge,
    sessionModelItem,
    sessionModelName,
    describe,
    pick,
  };
}
