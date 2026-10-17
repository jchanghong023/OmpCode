import { useEffect, useMemo } from "react";
import { zcodeTaskMetaSchema, zcodeWorkspaceTaskListChangedSchema } from "@zcode/shared";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { revokeChatComposerAttachment } from "@/lib/chatAttachments.js";
import { logger } from "@/logger.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { subscribeTaskQueryMetaMigrations } from "@/store/taskQueryMetaMigrationEvents.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { migrateComposerAttachmentTaskScope } from "@/store/composerAttachmentUploadStore.js";
import {
  migrateSharedComposerDraft,
  resolveSharedComposerDraftScope,
} from "@/v4/composer/composerDraftRegistry.js";

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
  transferService: Pick<IPromptAttachmentTransferService, "cleanup">,
): boolean {
  const parsed =
    kind === "event"
      ? zcodeWorkspaceTaskListChangedSchema.safeParse(value)
      : zcodeTaskMetaSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.workspacePath !== scope.workspacePath ||
    workspaceKey(parsed.data) !== workspaceKey(scope)
  )
    return false;
  const migration = parsed.data.taskIdMigration;
  if (!migration) return false;
  if (!migrateSharedComposerDraft({ ...scope, ...migration })) return false;
  const { displaced, retained } = migrateComposerAttachmentTaskScope({
    ...scope,
    ...migration,
    toTaskId: resolveSharedComposerDraftScope({ ...scope, scopeId: migration.toTaskId }),
  });
  for (const item of displaced) {
    // 只释放真正被目标取代且不再被任何迁移参与方持有的资源。
    if (item.objectUrl && !retained.some((candidate) => candidate.objectUrl === item.objectUrl))
      revokeChatComposerAttachment(item);
    if (!retained.some((candidate) => candidate.operationId === item.operationId))
      void transferService.cleanup(item.operationId).catch((error) => {
        logger.warn("[composer-draft-migration] 清理被目标取代的附件失败", error);
      });
  }
  return true;
}

/** 一次 workspace 绑定的 lease；已释放的旧代际回调不能再兑现迁移。 */
export function bindComposerDraftMigrationEvents(
  scope: WorkspaceDraftMigrationScope,
  transferService: Pick<IPromptAttachmentTransferService, "cleanup">,
  subscribeWorkspaceEvents?: (consume: (event: unknown) => void) => { dispose(): void },
) {
  let active = true;
  const consumeMeta = (meta: unknown) =>
    active && consumeComposerDraftMigration(scope, meta, "meta", transferService);
  const unsubscribeMeta = subscribeTaskQueryMetaMigrations(consumeMeta);
  // 只在绑定时兑现一次已接纳缓存；其后沿既有接纳事件，不扫描或另存 alias。
  for (const meta of Object.values(useTaskQueryCacheStore.getState().taskMetaByEntityKey))
    consumeMeta(meta);
  const disposable = subscribeWorkspaceEvents?.((event) => {
    if (active) consumeComposerDraftMigration(scope, event, "event", transferService);
  });
  return () => {
    active = false;
    unsubscribeMeta();
    disposable?.dispose();
  };
}

function WorkspaceDraftMigrationEvents({ scope }: { scope: WorkspaceDraftMigrationScope }) {
  const { promptAttachmentTransferService } = useServices();
  const { services, rpcReady } = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId,
    scope.workspaceIdentity,
    scope.remoteTarget,
  );
  useEffect(
    () =>
      bindComposerDraftMigrationEvents(
        scope,
        promptAttachmentTransferService,
        rpcReady
          ? (consume) => services.zcodeTaskService.onDynamicWorkspaceEvent(scope)(consume)
          : undefined,
      ),
    [scope, services, rpcReady, promptAttachmentTransferService],
  );
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
