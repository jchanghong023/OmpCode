import { useCallback, useEffect, useRef, useState } from "react";
import type { OmpNativeIntegrationSnapshot } from "@zcode/shared/omp-integrations";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Kind = "extension" | "mcp" | "hook";

export interface OmpNativeIntegrationsViewProps {
  kind: Kind;
  title: string;
  description: string;
  snapshot: OmpNativeIntegrationSnapshot | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onOpenDirectory: (path: string) => void;
}

/**
 * omp 原生配置只读视图；目录入口交给系统文件管理器，运行态不伪装成已连接。
 * 与 SkillsSection 的 OmpSkillsCatalogView 同为纯展示测试接缝：数据加载留在 Section。
 */
export function OmpNativeIntegrationsView({
  kind,
  title,
  description,
  snapshot,
  error,
  loading,
  onRefresh,
  onOpenDirectory,
}: OmpNativeIntegrationsViewProps) {
  const { intl } = useZCodeIntl();
  const entries =
    kind === "extension"
      ? snapshot?.extensions
      : kind === "hook"
        ? snapshot?.hooks
        : snapshot?.mcpServers;
  return (
    <section className="flex max-w-3xl flex-col gap-5" data-testid={`omp-native-${kind}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-foreground-subtle">{description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {intl.formatMessage({ id: "settings.ompNative.refresh" })}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {intl.formatMessage({ id: "settings.ompNative.loadFailed" })}: {error}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <p className="rounded-lg border border-border px-3 py-2 text-sm text-foreground-subtle">
            {intl.formatMessage({
              id:
                kind === "hook"
                  ? "settings.ompNative.hooksRuntimeUnavailable"
                  : "settings.ompNative.runtimeUnavailable",
            })}
          </p>
          {(["profile", "project"] as const).map((scope) => {
            const path = scope === "profile" ? snapshot.profileDir : snapshot.projectDir;
            if (!path) return null;
            const scoped = entries?.filter((entry) => entry.scope === scope) ?? [];
            return (
              <div key={scope} className="rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground">
                      {intl.formatMessage({ id: `settings.ompNative.${scope}` })}
                    </h3>
                    <p className="break-all text-xs text-foreground-subtle">{path}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenDirectory(path)}
                  >
                    {intl.formatMessage({ id: "settings.ompNative.openDirectory" })}
                  </Button>
                </div>
                {kind === "hook" && snapshot.hookErrors.includes(scope) ? (
                  <p className="mt-3 text-sm text-destructive">
                    {intl.formatMessage({ id: "settings.ompNative.hooksReadFailed" })}
                  </p>
                ) : snapshot.configErrors.includes(scope) && kind === "mcp" ? (
                  <p className="mt-3 text-sm text-destructive">
                    {intl.formatMessage({ id: "settings.ompNative.configInvalid" })}
                  </p>
                ) : scoped.length === 0 ? (
                  <p className="mt-3 text-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.ompNative.empty" })}
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-border">
                    {scoped.map((entry) => (
                      <li
                        key={`${scope}:${entry.name}`}
                        className="flex items-center justify-between gap-2 py-2 text-sm"
                      >
                        <span className="truncate text-foreground">{entry.name}</span>
                        <span className="shrink-0 text-foreground-subtle">
                          {"phase" in entry
                            ? String(entry.phase)
                            : "transport" in entry
                              ? `${String(entry.transport)} · ${intl.formatMessage({ id: "enabled" in entry && entry.enabled ? "settings.ompNative.enabled" : "settings.ompNative.disabled" })}`
                              : intl.formatMessage({ id: "settings.ompNative.directoryEntry" })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      ) : loading ? (
        <p className="text-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.ompNative.loading" })}
        </p>
      ) : null}
    </section>
  );
}

/** 数据加载容器：只负责请求代次隔离与平台读取，展示交给 OmpNativeIntegrationsView。 */
export function OmpNativeIntegrationsSection({
  kind,
  workspacePath,
}: {
  kind: Kind;
  workspacePath?: string;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<OmpNativeIntegrationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setSnapshot(null);
    if (!platform.readOmpNativeIntegrations) {
      setError("unsupported");
      setLoading(false);
      return;
    }
    try {
      const result = await platform.readOmpNativeIntegrations(workspacePath);
      if (requestId.current !== currentRequest) return;
      if (result.success) {
        setSnapshot(result.snapshot);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      if (requestId.current !== currentRequest) return;
      setError("load_failed");
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [platform, workspacePath]);
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  const title = intl.formatMessage({
    id:
      kind === "extension"
        ? "settings.ompNative.extensions"
        : kind === "hook"
          ? "settings.ompNative.hooks"
          : "settings.ompNative.mcp",
  });
  return (
    <OmpNativeIntegrationsView
      kind={kind}
      title={title}
      description={intl.formatMessage({
        id: kind === "hook" ? "settings.ompNative.hooksDescription" : "settings.ompNative.description",
      })}
      snapshot={snapshot}
      error={error}
      loading={loading}
      onRefresh={() => void load()}
      onOpenDirectory={(path) => void platform.openInFileManager(path)}
    />
  );
}
