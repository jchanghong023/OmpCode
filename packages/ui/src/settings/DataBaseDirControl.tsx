import { FolderOpen } from "lucide-react";
import { TID_SETTINGS_DATA_BASE_DIR_INPUT } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DataBaseDirControl({
  dataBaseDir,
  isWindowsDesktop,
}: {
  dataBaseDir: string;
  isWindowsDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          value={dataBaseDir}
          readOnly
          title={dataBaseDir}
          aria-label={intl.formatMessage({ id: "settings.dataBaseDir" })}
          className="flex-1 font-mono"
        />
      </div>
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
