import { FolderOpen } from "lucide-react";
import { TID_SETTINGS_DATA_BASE_DIR_INPUT } from "@zcode/shared";
import type { DataDirectoryInfo } from "@zcode/services";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DataBaseDirControl({
  directoryInfo,
  isWindowsDesktop,
}: {
  directoryInfo: DataDirectoryInfo | null;
  isWindowsDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      {directoryInfo?.offline ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.dataDirectory.runtimeRoot" })}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          value={directoryInfo?.runtimeRoot ?? ""}
          readOnly
          title={directoryInfo?.runtimeRoot ?? ""}
          aria-label={intl.formatMessage({
            id: directoryInfo?.offline
              ? "settings.dataDirectory.runtimeRoot"
              : "settings.dataBaseDir",
          })}
          className="flex-1 font-mono"
        />
      </div>
      {directoryInfo?.offline ? (
        <>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.dataDirectory.persistentRoot" })}
          </p>
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
            <Input
              size="lg"
              value={directoryInfo.persistentRoot}
              readOnly
              title={directoryInfo.persistentRoot}
              aria-label={intl.formatMessage({ id: "settings.dataDirectory.persistentRoot" })}
              className="flex-1 font-mono"
            />
          </div>
          <p className="text-ui-base text-warning">
            {intl.formatMessage({ id: "settings.dataDirectory.offlineWarning" })}
          </p>
        </>
      ) : null}
      <p className="whitespace-pre-line text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: isWindowsDesktop
            ? "settings.dataBaseDirEnvironmentWindows"
            : "settings.dataBaseDirEnvironmentLinux",
        })}
      </p>
    </div>
  );
}
