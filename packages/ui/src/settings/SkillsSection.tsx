import { useEffect, useMemo, useState } from "react";
import type { RemoteTarget } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useSkills } from "@/hooks/useSkills.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";

interface SkillsSectionProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
}

export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  searchQuery,
  onVisibleCountChange,
}: SkillsSectionProps) {
  const { intl } = useZCodeIntl();
  const [revision, setRevision] = useState(0);
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const catalog = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId: null,
    enabled: Boolean(workspacePath),
    preferredRemoteSessionId: remoteSessionId,
    remoteTarget,
    revision,
  });
  const query = searchQuery.trim().toLowerCase();
  const visibleSkills = useMemo(
    () =>
      catalog.skills.filter((skill) =>
        `${skill.name} ${skill.description}`.toLowerCase().includes(query),
      ),
    [catalog.skills, query],
  );

  useEffect(() => {
    onVisibleCountChange?.(visibleSkills.length);
  }, [onVisibleCountChange, visibleSkills.length]);

  return (
    <section data-testid="omp-available-skills" className="space-y-3">
      <SettingsResourceGroupHeader
        count={visibleSkills.length}
        title={intl.formatMessage({ id: "settings.skills.ompAvailable" })}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!resolution.rpcReady}
            onClick={() => setRevision((current) => current + 1)}
          >
            {intl.formatMessage({ id: "settings.skills.refresh" })}
          </Button>
        }
      />
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.skills.ompAvailableDescription" })}
      </p>
      {!resolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : catalog.loading ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : catalog.error ? (
        <p className="text-ui-sm text-destructive">{catalog.error}</p>
      ) : visibleSkills.length > 0 ? (
        <SettingsResourceList
          items={visibleSkills}
          getKey={(skill) => skill.id}
          renderItem={(skill) => (
            <div data-omp-skill-name={skill.name} className="px-4 py-3">
              <div className="text-ui-base font-medium text-foreground">{skill.name}</div>
              {skill.description ? (
                <div className="mt-0.5 text-ui-sm text-foreground-subtle">{skill.description}</div>
              ) : null}
            </div>
          )}
        />
      ) : query ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({ id: "settings.plugin.skills.searchEmpty" })}
        />
      ) : (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.skills.ompEmpty" })}
        </p>
      )}
    </section>
  );
}
