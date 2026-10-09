import { useEffect, useMemo } from "react";
import { zcodeTaskMetaSchema, zcodeWorkspaceTaskListChangedSchema } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { subscribeTaskQueryMetaMigrations } from "@/store/taskQueryMetaMigrationEvents.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { migrateSharedComposerDraft } from "@/v4/composer/composerDraftRegistry.js";

interface WorkspaceDraftMigrationScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

function workspaceKey(
  scope: Pick<WorkspaceDraftMigrationScope, "workspacePath" | "workspaceIdentity">,
) {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

/** 公开事件与冷列表使用相同校验、身份边界和唯一草稿迁移入口。 */
function consumeComposerDraftMigration(
  scope: WorkspaceDraftMigrationScope,
  value: unknown,
  kind: "event" | "meta",
  migrate = migrateSharedComposerDraft,
): boolean {
  const parsed =
    kind === "event"
      ? zcodeWorkspaceTaskListChangedSchema.safeParse(value)
      : zcodeTaskMetaSchema.safeParse(value);
  if (!parsed.success || workspaceKey(parsed.data) !== workspaceKey(scope)) return false;
  const migration = parsed.data.taskIdMigration;
  if (!migration) return false;
  return migrate({ ...scope, ...migration });
}

function WorkspaceDraftMigrationEvents({ scope }: { scope: WorkspaceDraftMigrationScope }) {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId,
    scope.workspaceIdentity,
    scope.remoteTarget,
  );
  useEffect(() => {
    const consumeMeta = (meta: unknown) => consumeComposerDraftMigration(scope, meta, "meta");
    const unsubscribeMeta = subscribeTaskQueryMetaMigrations(consumeMeta);
    // Bug 根因：pane 离开或 live 迁移事件丢失时，没有入口兑现持久的 Host 关联。
    // 这里只在绑定时读取一次缓存；以后由既有元信息接纳路径发布事实，不逐帧全量扫描。
    for (const meta of Object.values(useTaskQueryCacheStore.getState().taskMetaByEntityKey))
      consumeMeta(meta);
    const disposable = rpcReady
      ? services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) =>
          consumeComposerDraftMigration(scope, event, "event"),
        )
      : undefined;
    return () => {
      unsubscribeMeta();
      disposable?.dispose();
    };
  }, [scope, services, rpcReady]);
  return null;
}

export function ComposerDraftMigrationEvents({
  scopes,
}: {
  scopes: readonly WorkspaceDraftMigrationScope[];
}) {
  const uniqueScopes = useMemo(() => {
    const unique = new Map<string, WorkspaceDraftMigrationScope>();
    for (const scope of scopes) unique.set(workspaceKey(scope), scope);
    return [...unique.entries()];
  }, [scopes]);
  return uniqueScopes.map(([key, scope]) => (
    <WorkspaceDraftMigrationEvents key={key} scope={scope} />
  ));
}
