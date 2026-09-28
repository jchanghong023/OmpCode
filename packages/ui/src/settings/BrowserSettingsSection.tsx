/* oxlint-disable eslint(max-lines) -- Chrome 数据导入与清理共享同一平台状态机，拆分会扩大 pending/失败回收边界。 */
import { useCallback, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { ChromeBrowserDataImportResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { formatImportSummary } from "./browserImportSummary.js";

interface BrowserSettingsSectionProps {
  isDesktop: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  embeddedBrowserAllowInsecureCertificates?: boolean;
  onEmbeddedBrowserAllowInsecureCertificatesChange?: (enabled: boolean) => Promise<void>;
}

type BrowserDataOperation = "import" | "clear-cache" | "clear-all" | null;

function BrowserOperationButton({
  children,
  disabled,
  operation,
  pendingOperation,
  variant = "outline",
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  operation: Exclude<BrowserDataOperation, null>;
  pendingOperation: BrowserDataOperation;
  variant?: "outline" | "destructive";
  onClick: () => void;
}) {
  const pending = pendingOperation === operation;
  return (
    <Button
      type="button"
      size="lg"
      variant={variant}
      disabled={disabled || pendingOperation !== null}
      onClick={onClick}
      className="min-w-24"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

export function BrowserSettingsSection({
  isDesktop,
  isWindowsDesktop = false,
  embeddedBrowserAllowInsecureCertificates = false,
  onEmbeddedBrowserAllowInsecureCertificatesChange = async () => {},
}: BrowserSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [pendingOperation, setPendingOperation] = useState<BrowserDataOperation>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [lastImportResult, setLastImportResult] = useState<ChromeBrowserDataImportResult | null>(
    null,
  );
  const nativeActionsAvailable =
    isDesktop &&
    typeof platform.importChromeBrowserData === "function" &&
    typeof platform.clearEmbeddedBrowserData === "function";

  const handleImport = useCallback(async () => {
    if (!platform.importChromeBrowserData) return;
    setPendingOperation("import");
    const trace = startUserAction({
      featureId: "settings.browser",
      action: "import_browser_data",
      trigger: "button",
    });
    try {
      const result = await platform.importChromeBrowserData();
      trace.complete({ resultSource: "platform_result" });
      setLastImportResult(result);
      toast(formatImportSummary(result, intl.formatMessage), {
        durationMs: 5000,
      });
    } catch (error) {
      trace.fail({ failureStage: "browser_data_import" });
      logger.error("[browser-settings] 导入 Chrome 数据失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.browser.import.failed" }));
    } finally {
      setPendingOperation(null);
    }
  }, [intl, platform]);

  const handleClear = useCallback(
    async (mode: "cache" | "all") => {
      if (!platform.clearEmbeddedBrowserData) return;
      setPendingOperation(mode === "cache" ? "clear-cache" : "clear-all");
      const trace = startUserAction({
        featureId: "settings.browser",
        action: mode === "cache" ? "clear_cache" : "clear_all_data",
        trigger: "button",
      });
      try {
        const result = await platform.clearEmbeddedBrowserData(mode);
        trace.complete({ resultSource: "platform_result" });
        toast(
          intl.formatMessage({
            id: result.success
              ? mode === "cache"
                ? "settings.browser.clearCache.success"
                : "settings.browser.clearAll.success"
              : "settings.browser.clear.failed",
          }),
        );
      } catch (error) {
        trace.fail({ failureStage: "browser_data_clear" });
        logger.error("[browser-settings] 清理内置浏览器数据失败", {
          error: error instanceof Error ? error.message : String(error),
          mode,
        });
        toast(intl.formatMessage({ id: "settings.browser.clear.failed" }));
      } finally {
        setPendingOperation(null);
        setConfirmClearAll(false);
      }
    },
    [intl, platform],
  );

  const operationDisabled = !nativeActionsAvailable;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.browser.control.title" })}
            description={intl.formatMessage({
              id: "settings.browser.control.description",
            })}
            control={
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.browser.control.defaultEnabled" })}
              </span>
            }
          />
          {/* 导入登录状态沿用浏览器设置卡片；清除类破坏性操作仍留在“浏览器数据”分组。
              Windows App-Bound 导入链路暂未开放，先隐藏入口但保留底层实现和清理能力。*/}
          {!isWindowsDesktop ? (
            <SettingsRow
              label={intl.formatMessage({ id: "settings.browser.import.title" })}
              description={intl.formatMessage({
                id: "settings.browser.import.description",
              })}
              control={
                <BrowserOperationButton
                  operation="import"
                  pendingOperation={pendingOperation}
                  disabled={operationDisabled}
                  onClick={() => void handleImport()}
                >
                  {intl.formatMessage({ id: "settings.browser.import.action" })}
                </BrowserOperationButton>
              }
              detail={
                lastImportResult ? (
                  <div className="text-ui-base text-foreground-subtle">
                    {formatImportSummary(lastImportResult, intl.formatMessage)}
                  </div>
                ) : undefined
              }
            />
          ) : null}
        </SettingsGroupCard>
      </section>

      {/* 证书策略只在桌面端有内置浏览器时可配；改动由 main 在启动时装到 Session，需重启生效。 */}
      {isDesktop ? (
        <section className="space-y-3">
          <div className="text-ui-base font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.security.section" })}
          </div>
          <SettingsGroupCard>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificates",
              })}
              description={intl.formatMessage({
                id: "settings.embeddedBrowserAllowInsecureCertificatesDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.embeddedBrowserAllowInsecureCertificates",
                  })}
                  checked={embeddedBrowserAllowInsecureCertificates}
                  onCheckedChange={(checked) => {
                    void onEmbeddedBrowserAllowInsecureCertificatesChange(checked);
                  }}
                />
              }
            />
          </SettingsGroupCard>
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.data.section" })}
        </div>
        {!nativeActionsAvailable ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.browser.desktopOnly" })}
          </div>
        ) : null}
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.browser.clearCache.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearCache.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-cache"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                onClick={() => void handleClear("cache")}
              >
                {intl.formatMessage({
                  id: "settings.browser.clearCache.action",
                })}
              </BrowserOperationButton>
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.browser.clearAll.title",
            })}
            description={intl.formatMessage({
              id: "settings.browser.clearAll.description",
            })}
            control={
              <BrowserOperationButton
                operation="clear-all"
                pendingOperation={pendingOperation}
                disabled={operationDisabled}
                variant="destructive"
                onClick={() => setConfirmClearAll(true)}
              >
                {intl.formatMessage({ id: "settings.browser.clearAll.action" })}
              </BrowserOperationButton>
            }
          />
        </SettingsGroupCard>
      </section>

      <AlertDialog open={confirmClearAll} onOpenChange={setConfirmClearAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmTitle",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingOperation !== null}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pendingOperation !== null}
              onClick={(event) => {
                event.preventDefault();
                void handleClear("all");
              }}
            >
              {pendingOperation === "clear-all" ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id: "settings.browser.clearAll.confirmAction",
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
