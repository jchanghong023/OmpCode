import { FolderOpen } from "lucide-react";
import {
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
} from "@zcode/shared/test-ids";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DataBaseDirControl({ dataBaseDir }: { dataBaseDir: string }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 sm:w-[320px]">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          aria-label={intl.formatMessage({ id: "settings.dataBaseDir" })}
          value={dataBaseDir}
          readOnly
          placeholder={intl.formatMessage({ id: "settings.dataBaseDirPlaceholder" })}
          className="flex-1 font-mono"
        />
      </div>
      <div
        data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
        className="space-y-2 text-ui-base text-foreground-subtle"
      >
        <p>{intl.formatMessage({ id: "settings.dataBaseDirEnvironment" })}</p>
        <p>{intl.formatMessage({ id: "settings.dataBaseDirWindows" })}</p>
        <p>{intl.formatMessage({ id: "settings.dataBaseDirLinux" })}</p>
        <p>{intl.formatMessage({ id: "settings.dataBaseDirEnvironmentRestart" })}</p>
      </div>
    </div>
  );
}
