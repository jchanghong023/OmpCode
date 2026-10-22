import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { resolveWorkspaceServices } from "@/lib/workspaceServiceResolver.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type {
  GroupTaskRef,
  MoveGroupNode,
  ProjectTree,
  TaskGroup,
  TaskGroupStructure,
  TaskGroupDomainStructure,
  TaskGroupWorkspaceTarget,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { logger } from "@/logger.js";
const EMPTY: TaskGroupStructure = { groups: [], members: [], order: [] };
const UNKNOWN_SCOPE = "实际 OMP 根目录/profile 尚未就绪，分组暂不可用";
const CROSS_SCOPE = "不能跨 OMP 根目录或 profile 移动任务或分组";
const targetKey = (target: TaskGroupWorkspaceTarget) =>
  JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.remoteSessionId ?? null,
  ]);
/** 控制端唯一订阅；只聚合真实运行域，不把待应用的 profile 偏好当作组织事实。 */
export function useTaskGroups(tree: ProjectTree) {
  const services = useBaseWorkspaceServices();
  const service = services.taskGroupService;
  const tabs = useOptionalTabStore((state) => state.tabs);
  const remoteState = useRemoteWorkspaceSessionStore(
    useShallow((state) => ({
      sessionsById: state.sessionsById,
      sessionIdByWorkspaceIdentity: state.sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath: state.sessionIdByWorkspacePath,
    })),
  );
  const resolveTarget = useCallback(
    (target: TaskGroupWorkspaceTarget) => ({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId:
        resolveRemoteWorkspaceSessionIdForTarget({
          ...target,
          preferredRemoteSessionId: target.remoteSessionId,
          state: remoteState,
        }) ?? undefined,
    }),
    [remoteState],
  );
  const targetSignature = useMemo(() => {
    const targets = new Map<string, TaskGroupWorkspaceTarget>();
    for (const item of [...tabs.filter(isWorkspaceTab), ...tree.tasks]) {
      const target = resolveTarget(item);
      // 远端 attachment 尚未恢复时不能借用同路径的本机服务或组织库。
      if (!resolveWorkspaceServices({ ...item, ...target }, services, remoteState)) continue;
      targets.set(targetKey(target), target);
    }
    return JSON.stringify(
      [...targets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, target]) => target),
    );
  }, [tabs, tree.tasks, resolveTarget, services, remoteState]);
  const targets = useMemo(
    () => JSON.parse(targetSignature) as TaskGroupWorkspaceTarget[],
    [targetSignature],
  );
  const [accepted, setAccepted] = useState<{
    key: string;
    domains: TaskGroupDomainStructure[];
    scopes: Map<string, string>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    if (!service || !targets.length) {
      setAccepted(null);
      return;
    }
    try {
      const scopes = new Map<string, string>();
      await Promise.all(
        targets.map(async (target) => {
          const route = resolveWorkspaceServices(target, services, remoteState);
          if (!route) throw new Error(UNKNOWN_SCOPE);
          const facts = await route.services.zcodeAgentService.getOmpProfiles(target);
          if (!facts.storageScope) throw new Error(UNKNOWN_SCOPE);
          scopes.set(targetKey(target), facts.storageScope);
        }),
      );
      const domains = await service.read(targets);
      // 原生事实与组织读取之间若发生重启，不能把旧域响应贴到新域目标上。
      if (domains.some((domain) => scopes.get(targetKey(domain.target)) !== domain.storageScope))
        throw new Error(UNKNOWN_SCOPE);
      if (request === serial.current) {
        setAccepted({ key: targetSignature, domains, scopes });
        setError(null);
      }
    } catch (cause) {
      if (request === serial.current) {
        setAccepted(null);
        setError(String(cause));
        logger.error("[task-groups] 读取分组失败", cause);
      }
    }
  }, [service, targets, targetSignature, services, remoteState]);
  useEffect(() => {
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:task-groups") void refresh();
    });
    const agents = new Set(
      targets.map(
        (target) =>
          resolveWorkspaceServices(target, services, remoteState)?.services.zcodeAgentService,
      ),
    );
    const invalidate = () => {
      serial.current++;
      setAccepted(null);
    };
    const lifecycle = [...agents].flatMap((agent) => {
      if (!agent) return [];
      const restarted = agent.onAgentRuntimeRestarted(() => {
        invalidate();
        void refresh();
      });
      const changed = agent.onAgentRuntimeLifecycle?.((event) => {
        invalidate();
        if (event.state === "available") void refresh();
      });
      return changed ? [restarted, changed] : [restarted];
    });
    return () => {
      serial.current++;
      subscription.dispose();
      for (const item of lifecycle) item.dispose();
    };
  }, [services, remoteState, targets, refresh]);
  const snapshot = accepted?.key === targetSignature ? accepted : null;
  const structure = useMemo<TaskGroupStructure>(() => {
    if (!snapshot) return EMPTY;
    // 系统分组有固定 ID，跨域只合并展示；写入仍由任务实际域或唯一分组域决定。
    const groups = new Map<string, TaskGroup>();
    const order = new Map<string, TaskGroupStructure["order"][number]>();
    for (const domain of snapshot.domains) {
      for (const group of domain.groups) if (!groups.has(group.id)) groups.set(group.id, group);
      for (const item of domain.order) {
        const key = JSON.stringify([item.type, item.key]);
        if (!order.has(key)) order.set(key, item);
      }
    }
    return {
      groups: [...groups.values()],
      members: snapshot.domains.flatMap((domain) => domain.members),
      order: [...order.values()],
    };
  }, [snapshot]);
  // 等价刷新必须复用域映射，否则登记 effect 会被自己的 refresh 再次触发。
  const scopeSignature = JSON.stringify([...(snapshot?.scopes ?? [])]);
  const scopes = useMemo(
    () => new Map<string, string>(JSON.parse(scopeSignature)),
    [scopeSignature],
  );
  const scopeForTarget = useCallback(
    (target: TaskGroupWorkspaceTarget) => scopes.get(targetKey(resolveTarget(target))),
    [scopes, resolveTarget],
  );
  const groupDomains = useCallback(
    (id: string) =>
      snapshot?.domains.filter((domain) => domain.groups.some((group) => group.id === id)) ?? [],
    [snapshot],
  );
  const domainForTarget = useCallback(
    (target: TaskGroupWorkspaceTarget) => {
      const key = targetKey(resolveTarget(target));
      return snapshot?.domains.find((domain) =>
        domain.targets.some((item) => targetKey(item) === key),
      );
    },
    [snapshot, resolveTarget],
  );
  const groupTarget = useCallback(
    (id: string): TaskGroupWorkspaceTarget => {
      const domains = groupDomains(id);
      if (domains.length !== 1)
        throw new Error(
          domains.length
            ? "多个 OMP 域的系统分组不能统一修改，请在单一运行域中操作"
            : UNKNOWN_SCOPE,
        );
      return domains[0]!.target;
    },
    [groupDomains],
  );
  const moveUnavailableReason = useCallback(
    (task: TaskGroupWorkspaceTarget, id: string | null) => {
      const domain = domainForTarget(task);
      if (!domain || !scopeForTarget(task)) return UNKNOWN_SCOPE;
      return id !== null && !domain.groups.some((group) => group.id === id) ? CROSS_SCOPE : null;
    },
    [scopeForTarget, domainForTarget],
  );
  const required = useCallback(() => {
    if (!service || !snapshot) throw new Error(error ?? UNKNOWN_SCOPE);
    return service;
  }, [service, snapshot, error]);
  // 活动时间/stream 不触发登记；仅首次身份、系统标记和明确删除有组织语义。
  const signature = useMemo(() => {
    const entries = [
      ...tree.tasks.map((task) => [
        { ...groupTaskRef(task), remoteSessionId: resolveTarget(task).remoteSessionId },
        task.cronAutomationId,
        task.offPeakTaskId,
      ]),
      ...(tree.deletedTasks ?? []).map((task) => [
        { ...task, remoteSessionId: resolveTarget(task).remoteSessionId },
        "deleted",
      ]),
    ].map((entry) => JSON.stringify(entry));
    entries.sort((a, b) => a.localeCompare(b));
    return `[${entries.join(",")}]`;
  }, [tree.tasks, tree.deletedTasks, resolveTarget]);
  const available = Boolean(service && snapshot);
  useEffect(() => {
    if (!service || !available) return;
    const entries = JSON.parse(signature) as Array<[GroupTaskRef]>;
    const byHost = new Map<string, GroupTaskRef[]>();
    for (const [task] of entries) {
      if (!scopeForTarget(task)) continue;
      const key = JSON.stringify([task.hostId, task.remoteSessionId]);
      const refs = byHost.get(key) ?? [];
      refs.push(task);
      byHost.set(key, refs);
    }
    let active = true;
    void Promise.allSettled(
      [...byHost.values()].map(async (tasks) => {
        for (let start = 0; start < tasks.length; start += 5000)
          await service.admit({ tasks: tasks.slice(start, start + 5000) });
      }),
    ).then((results) => {
      for (const result of results)
        if (result.status === "rejected")
          logger.warn("[task-groups] 任务登记未完成，保留原结构", result.reason);
      if (active && entries.length) void refresh();
    });
    return () => {
      active = false;
    };
  }, [service, signature, available, refresh, scopeForTarget]);
  const save = useCallback(
    async (input: {
      target?: TaskGroupWorkspaceTarget;
      id?: string;
      title?: string;
      color?: TaskGroup["color"];
    }) => {
      const target = input.id ? groupTarget(input.id) : input.target && resolveTarget(input.target);
      if (!target || !scopeForTarget(target)) throw new Error(UNKNOWN_SCOPE);
      const result = await required().save({ ...input, target });
      await refresh();
      return result;
    },
    [groupTarget, resolveTarget, scopeForTarget, required, refresh],
  );
  const move = useCallback(
    async (input: MoveGroupNode) => {
      const target =
        input.node.type === "task"
          ? resolveTarget(input.node.task)
          : groupTarget(input.node.groupId);
      const reason = moveUnavailableReason(target, input.groupId);
      if (reason) throw new Error(reason);
      const domain = domainForTarget(target);
      let anchor = input.anchor;
      if (anchor) {
        const anchorNode = anchor.node;
        if (anchorNode.type === "task") {
          const anchorTarget = resolveTarget(anchorNode.task);
          if (domainForTarget(anchorTarget) !== domain) throw new Error(CROSS_SCOPE);
          anchor = {
            ...anchor,
            node: { ...anchorNode, task: { ...anchorNode.task, ...anchorTarget } },
          };
        } else if (!domain?.groups.some((group) => group.id === anchorNode.groupId)) {
          throw new Error(CROSS_SCOPE);
        }
      }
      const node =
        input.node.type === "task"
          ? { ...input.node, task: { ...input.node.task, ...target } }
          : input.node;
      await required().move({ ...input, target, node, anchor });
      await refresh();
    },
    [resolveTarget, groupTarget, moveUnavailableReason, domainForTarget, required, refresh],
  );
  const ungroup = useCallback(
    async (id: string) => {
      await required().ungroup({ target: groupTarget(id), id });
      await refresh();
    },
    [required, groupTarget, refresh],
  );
  const parents = useMemo(
    () =>
      new Map(
        structure.members.map((member) => [
          JSON.stringify([member.workspaceKey, member.taskId]),
          member.groupId,
        ]),
      ),
    [structure],
  );
  return useMemo(
    () => ({
      structure,
      parents,
      error,
      refresh,
      save,
      move,
      ungroup,
      available,
      unavailableReason: available ? null : (error ?? UNKNOWN_SCOPE),
      moveUnavailableReason,
      targetAvailable: (target: TaskGroupWorkspaceTarget) => Boolean(scopeForTarget(target)),
    }),
    [
      structure,
      parents,
      error,
      refresh,
      save,
      move,
      ungroup,
      available,
      moveUnavailableReason,
      scopeForTarget,
    ],
  );
}
