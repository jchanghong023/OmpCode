import { useEffect, useMemo, useState } from "react";
import { DesktopCommandIds } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { OmpModelRolesDialog } from "@/v4/composer/OmpModelRolesDialog.js";
import { readOmpModelCatalog } from "@/v4/composer/ompModelCatalog.js";

/** 设置侧栏的模型页只编辑 omp modelRoles，候选只读已有 omp 目录。 */
export function OmpModelRolesSection({
  workspacePath,
  workspaceIdentity,
  configuredProfile,
  onProfileChange,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  configuredProfile?: string;
  onProfileChange: (profile: string) => Promise<void>;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [profileInfo, setProfileInfo] = useState<{
    profiles: string[];
    activeProfile: string;
  } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!platform.listOmpProfiles) {
      logger.warn("[omp-settings] Profile listing unavailable", {
        event: "omp.settings.profiles.list.unsupported",
      });
      setProfileError("unsupported");
      return;
    }
    logger.debug("[omp-settings] Profile listing started", {
      event: "omp.settings.profiles.list.started",
    });
    void platform
      .listOmpProfiles()
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setProfileInfo(result);
          setProfileError(null);
          logger.debug("[omp-settings] Profile listing completed", {
            event: "omp.settings.profiles.list.completed",
            profileCount: result.profiles.length,
          });
        } else {
          logger.warn("[omp-settings] Profile listing failed", {
            event: "omp.settings.profiles.list.failed",
            phase: "response",
          });
          setProfileError(result.error);
        }
      })
      .catch(() => {
        logger.warn("[omp-settings] Profile listing failed", {
          event: "omp.settings.profiles.list.failed",
          phase: "request",
          cancelled,
        });
        if (!cancelled) setProfileError("load_failed");
      });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const { configOptions } = useToolbarConfigOptions(workspacePath, null, workspaceIdentity);
  const catalog = useMemo(() => readOmpModelCatalog(configOptions), [configOptions]);
  const selectedProfile = configuredProfile ?? profileInfo?.activeProfile ?? "default";
  const restartRequired = Boolean(profileInfo && selectedProfile !== profileInfo.activeProfile);

  async function changeProfile(profile: string) {
    setSavingProfile(true);
    setProfileError(null);
    logger.info("[omp-settings] Profile selection update started", {
      event: "omp.settings.profile.update.started",
    });
    try {
      await onProfileChange(profile);
      logger.info("[omp-settings] Profile selection update completed", {
        event: "omp.settings.profile.update.completed",
      });
    } catch {
      logger.error("[omp-settings] Profile selection update failed", {
        event: "omp.settings.profile.update.failed",
      });
      setProfileError("save_failed");
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label htmlFor="omp-profile-select" className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.ompProfile.label" })}
        </label>
        <Select
          value={selectedProfile}
          disabled={!profileInfo || savingProfile}
          onValueChange={(profile) => void changeProfile(profile)}
        >
          <SelectTrigger
            id="omp-profile-select"
            aria-label={intl.formatMessage({ id: "settings.ompProfile.label" })}
            size="lg"
            className="w-full max-w-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {(profileInfo?.profiles ?? [selectedProfile]).map((profile) => (
              <SelectItem key={profile} value={profile}>
                {profile === "default"
                  ? intl.formatMessage({ id: "settings.ompProfile.default" })
                  : profile}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {profileError ? (
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "settings.ompProfile.error" })}
          </p>
        ) : null}
        {restartRequired ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
            <span className="flex-1 text-ui-base text-foreground">
              {intl.formatMessage({ id: "settings.ompProfile.restartRequired" })}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => void platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp)}
            >
              {intl.formatMessage({ id: "settings.ompProfile.restart" })}
            </Button>
          </div>
        ) : null}
      </div>
      {!restartRequired ? (
        <OmpModelRolesDialog
          inline
          catalogEntries={catalog?.entries ?? []}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
        />
      ) : null}
    </div>
  );
}
