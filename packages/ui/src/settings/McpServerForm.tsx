import { useEffect, useRef, useState } from "react";
import type { McpSource, ZCodeMcpServer } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { ChevronDown, ChevronUpIcon as ChevronUp, Trash2 } from "lucide-react";
import {
  EMPTY_FORM,
  formToJsonDraft,
  jsonDraftToForm,
  scopeToStorageLevel,
  serverToForm,
  type FormState,
  type McpEditorMode,
} from "./mcpSettingsShared.js";

function McpFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

function McpScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

export function McpServerForm({
  initial,
  editingId,
  editorMode,
  onEditorModeChange,
  onSave,
  onCancel,
  onDelete,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: ZCodeMcpServer;
  editingId?: string;
  editorMode: McpEditorMode;
  source?: McpSource;
  scopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
  onEditorModeChange: (mode: McpEditorMode) => void;
  onSave: (form: FormState, prevServer?: ZCodeMcpServer) => void;
  onCancel: () => void;
  onDelete?: (server: ZCodeMcpServer) => void;
}) {
  const { intl } = useZCodeIntl();
  const initialForm: FormState = initial
    ? serverToForm(initial)
    : {
        ...EMPTY_FORM,
        storageLevel: scopeToStorageLevel(scopeKey),
      };
  const [form, setForm] = useState<FormState>(initialForm);
  const [jsonDraft, setJsonDraft] = useState<string>(() => formToJsonDraft(initialForm));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [showEnv, setShowEnv] = useState(false);
  const formRef = useRef(form);
  const jsonDraftRef = useRef(jsonDraft);
  const previousEditorModeRef = useRef(editorMode);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    jsonDraftRef.current = jsonDraft;
  }, [jsonDraft]);

  useEffect(() => {
    const previousMode = previousEditorModeRef.current;
    if (previousMode === editorMode) {
      return;
    }

    if (editorMode === "json") {
      setJsonDraft(formToJsonDraft(formRef.current));
      setJsonError(null);
      previousEditorModeRef.current = editorMode;
      return;
    }

    try {
      const parsedForm = jsonDraftToForm(jsonDraftRef.current, formRef.current);
      setForm(parsedForm);
      setJsonError(null);
      previousEditorModeRef.current = editorMode;
    } catch (error) {
      setJsonError(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ id: "settings.mcp.form.jsonParseError" }),
      );
      onEditorModeChange(previousMode);
    }
  }, [editorMode, intl, onEditorModeChange]);

  function update(patch: Partial<FormState>) {
    // F28/F29/F16 修复：setForm 的 updater 必须是纯函数，不得内嵌 setJsonDraft。
    // 旧行为在 JSON 模式下用「过期 form 快照 + 新 patch」重序列化覆盖 jsonDraft：
    // JSON 模式下用户直接编辑 jsonDraft，form 只是过期影子，此时点 Scope 菜单会
    // 把手编 JSON 全文抹掉且不可恢复。修复后 update 只维护表单态——基于 formRef
    // 镜像在事件处理器层先算 next 再提交；jsonDraft 的唯一派生点是「表单 → JSON」
    // 模式切换 effect（上方 useEffect），update 不再维护第二条写入路径。
    // JSON 模式下 Scope 变更只需更新影子 form.storageLevel：保存目标由父组件
    // formScopeKey 决定，表单保存合成 jsonDraftToForm(jsonDraft, form) 也以影子
    // form 为 fallback，重序列化 jsonDraft 从来都是多余且有害的。
    const next = { ...formRef.current, ...patch };
    setForm(next);
  }

  function handleSaveClick() {
    if (editorMode === "json") {
      try {
        const parsedForm = jsonDraftToForm(jsonDraft, form);
        setForm(parsedForm);
        setJsonError(null);

        onSave(parsedForm, initial);
      } catch (error) {
        setJsonError(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ id: "settings.mcp.form.jsonParseError" }),
        );
      }
      return;
    }

    onSave(form, initial);
  }

  const canSave = (() => {
    if (editorMode !== "json") {
      return Boolean(
        form.name.trim() && (form.type === "stdio" ? form.command.trim() : form.url.trim()),
      );
    }
    if (!jsonDraft.trim()) return false;
    try {
      const parsedForm = jsonDraftToForm(jsonDraft, form);
      return Boolean(
        parsedForm.name.trim() &&
        (parsedForm.type === "stdio" ? parsedForm.command.trim() : parsedForm.url.trim()),
      );
    } catch {
      return false;
    }
  })();

  const envToggleLabel =
    form.type === "stdio"
      ? intl.formatMessage({ id: "settings.mcp.form.envOptional" })
      : intl.formatMessage({ id: "settings.mcp.form.headersOptional" });
  const envValue = form.type === "stdio" ? form.env : form.headers;
  const envPlaceholder =
    form.type === "stdio"
      ? '{\n  "MY_API_KEY": "your-key"\n}'
      : '{\n  "Authorization": "Bearer your-token"\n}';
  const updateEnvValue = (value: string) =>
    update(form.type === "stdio" ? { env: value } : { headers: value });
  // Radix Select 不接受空串 value；用 "auto" 作为哨兵值：表单里空串 = 未设置 = auto
  // （配置文件不落多余字段），用户显式选 auto 时同样写回空串。
  const updateProtocolVersion = (value: string) =>
    update({ protocolVersion: value === "auto" ? "" : value });
  const scopeSelect = (
    <McpScopeMenu
      disabled={!!initial}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={(nextScopeKey) => {
        // F28/F29：JSON 模式下该菜单仍渲染可点，Scope 变更只把存储级写进表单态
        // 影子（form.storageLevel），供切换回表单模式及保存合成使用；手编 jsonDraft
        // 是权威文本，绝不重序列化覆盖。不禁用菜单：保存目标由父组件 formScopeKey
        // 决定（McpSettingsSection.handleSave 按 formScopeKey 选 projectPath），
        // JSON 模式下切 Scope 是真实功能，禁用反而丢功能。
        update({ storageLevel: scopeToStorageLevel(nextScopeKey) });
        onScopeKeyChange(nextScopeKey);
      }}
    />
  );

  return (
    <div className="space-y-4 rounded-xl border border-border p-4">
      {editorMode === "json" ? (
        <div className="space-y-3">
          <div className="flex justify-end">{scopeSelect}</div>
          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.fullConfig" })}
            </McpFormFieldLabel>
            <SettingsFormTextarea
              rows={16}
              className="font-mono text-ui-base"
              placeholder={
                '{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}'
              }
              value={jsonDraft}
              onChange={(e) => {
                setJsonDraft(e.target.value);
                if (jsonError) {
                  setJsonError(null);
                }
              }}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintPrefix" })}{" "}
              <code>{`{"server-name": {...}}`}</code>{" "}
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintMiddle" })}{" "}
              <code>{`{"mcpServers": {"server-name": {...}}}`}</code>
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintSuffix" })}
            </p>
            {jsonError && <p className="text-ui-base text-destructive">{jsonError}</p>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="w-full min-w-0 space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.name" })}
              </McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="my-mcp-server"
                value={form.name}
                disabled={!!editingId}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div>{scopeSelect}</div>
          </div>

          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.type" })}
            </McpFormFieldLabel>
            <Select
              value={form.type}
              onValueChange={(v) => update({ type: v as FormState["type"] })}
            >
              <SelectTrigger size="lg" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">
                  {intl.formatMessage({ id: "settings.mcp.form.type.stdio" })}
                </SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
                {/*
                  Streamable HTTP 传输类型未启用。
                  <SelectItem value="streamableHttp">Streamable HTTP</SelectItem>
                */}
                <SelectItem value="sse">
                  {intl.formatMessage({ id: "settings.mcp.form.type.sse" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-full space-y-1.5 md:w-48">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.timeoutMs" })}
            </McpFormFieldLabel>
            <Input
              size="lg"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="30000"
              value={form.timeoutMs}
              onChange={(e) => update({ timeoutMs: e.target.value })}
            />
          </div>

          {/*
            sse 形态不渲染该字段：deprecated SSE transport 固定走 legacy 协商，
            该配置对其无效。
          */}
          {form.type !== "sse" && (
            <div className="w-full space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.protocolVersion" })}
              </McpFormFieldLabel>
              <Select value={form.protocolVersion || "auto"} onValueChange={updateProtocolVersion}>
                <SelectTrigger size="lg" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.auto" })}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.legacy" })}
                  </SelectItem>
                  {/* 显示名用「v2」，但 value 必须保持协议正式版本号 " "（config/wire 值，不可随文案变）*/}
                  <SelectItem value="2026-07-28">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.modern" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {form.type === "stdio" ? (
            <>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.command" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="npx"
                  value={form.command}
                  onChange={(e) => update({ command: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.args" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="-y @modelcontextprotocol/server-memory"
                  value={form.args}
                  onChange={(e) => update({ args: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <McpFormFieldLabel>URL</McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
              />
            </div>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-ui-base text-foreground-subtle hover:text-foreground"
              onClick={() => setShowEnv((v) => !v)}
            >
              {showEnv ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {envToggleLabel}
            </button>
            {showEnv && (
              <div className="mt-2 space-y-1.5">
                <SettingsFormTextarea
                  rows={4}
                  className="font-mono text-ui-base"
                  placeholder={envPlaceholder}
                  value={envValue}
                  onChange={(e) => updateEnvValue(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button size="lg" disabled={!canSave} onClick={handleSaveClick}>
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </div>
  );
}
