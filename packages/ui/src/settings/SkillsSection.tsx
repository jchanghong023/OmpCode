import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { RemoteTarget, ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useSkills } from "@/hooks/useSkills.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";

interface CatalogLabels {
  title: string;
  description: string;
  loading: string;
  empty: string;
  searchEmpty: string;
  refresh: string;
}

interface OmpSkillsCatalogViewProps {
  skills: ZCodeSkillReferenceCatalogEntry[];
  searchQuery: string;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  labels: CatalogLabels;
}

function filterCatalogSkills(
  skills: ZCodeSkillReferenceCatalogEntry[],
  searchQuery: string,
): ZCodeSkillReferenceCatalogEntry[] {
  const query = searchQuery.trim().toLowerCase();
  const ompSkills = skills.filter((skill) => skill.scope === "omp" && skill.enabled);
  return query
    ? ompSkills.filter((skill) =>
        `${skill.name} ${skill.description}`.toLowerCase().includes(query),
      )
    : ompSkills;
}

/** 设置页只投影 omp 可执行目录；本地 SKILL.md 扫描不能代表 omp 的启用事实。 */
export function OmpSkillsCatalogView({
  skills,
  searchQuery,
  loading,
  error,
  onRefresh,
  labels,
}: OmpSkillsCatalogViewProps) {
  const visibleSkills = filterCatalogSkills(skills, searchQuery);
  return (
    <section className="space-y-4" data-testid="omp-skills-settings">
      <SettingsResourceGroupHeader
        title={labels.title}
        count={visibleSkills.length}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={labels.refresh}
            title={labels.refresh}
            onClick={onRefresh}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
        }
      />
      <p className="text-ui-sm text-foreground-subtle">{labels.description}</p>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : loading ? (
        <PluginLoadingState label={labels.loading} />
      ) : visibleSkills.length === 0 ? (
        <PluginSearchEmptyState label={searchQuery.trim() ? labels.searchEmpty : labels.empty} />
      ) : (
        <SettingsResourceList
          items={visibleSkills}
          getKey={(skill) => skill.id}
          renderItem={(skill) => (
            <div className="px-4 py-3" data-testid="omp-skill-row">
              <div className="text-ui-base font-medium text-foreground">{skill.name}</div>
              {skill.description ? (
                <div className="mt-0.5 text-ui-sm text-foreground-subtle">{skill.description}</div>
              ) : null}
            </div>
          )}
        />
      )}
    </section>
  );
}

interface SkillsSectionProps {
  workspacePath?: string | null;
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
  const activeWorkspacePath = workspacePath ?? "";
  const resolution = useWorkspaceServicesResolution(
    activeWorkspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const catalog = useSkills({
    workspacePath: activeWorkspacePath,
    workspaceIdentity,
    sessionId: null,
    enabled: Boolean(activeWorkspacePath),
    preferredRemoteSessionId: remoteSessionId,
    remoteTarget,
    revision,
  });
  const visibleCount = useMemo(
    () => filterCatalogSkills(catalog.skills, searchQuery).length,
    [catalog.skills, searchQuery],
  );
  useEffect(() => {
    onVisibleCountChange?.(visibleCount);
  }, [onVisibleCountChange, visibleCount]);

  return (
    <OmpSkillsCatalogView
      skills={catalog.skills}
      searchQuery={searchQuery}
      loading={!resolution.rpcReady || catalog.loading}
      error={catalog.error}
      onRefresh={() => setRevision((current) => current + 1)}
      labels={{
        title: intl.formatMessage({ id: "settings.skills.ompAvailable" }),
        description: intl.formatMessage({ id: "settings.skills.ompAvailableDescription" }),
        loading: intl.formatMessage({ id: "common.loading" }),
        empty: intl.formatMessage({ id: "settings.skills.empty" }),
        searchEmpty: intl.formatMessage({ id: "settings.plugin.skills.searchEmpty" }),
        refresh: intl.formatMessage({ id: "settings.skills.refresh" }),
      }}
    />
  );
}
