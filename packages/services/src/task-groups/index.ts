import { z } from "zod";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import type {
  GroupTaskFact,
  GroupTaskRef,
  ITaskGroupService,
  TaskGroupWorkspaceTarget,
} from "#src/task-groups/contract.js";
import { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  TaskGroupDomainStructure,
  TaskGroupWorkspaceTarget,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  GroupTaskFact,
} from "#src/task-groups/contract.js";

const targetFields = {
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().trim().min(1).optional(),
  remoteSessionId: z.string().trim().min(1).optional(),
};
const targetSchema = z.object(targetFields).strict();
const taskSchema = z
  .object({
    ...targetFields,
    hostId: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict()
  .refine(
    (task) =>
      (remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity ?? "") ?? "local") === task.hostId,
    "task-group.host-identity-mismatch",
  );
const nodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group"), groupId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("task"), task: taskSchema }).strict(),
]);
type Domain = { database: DatabaseSync; storageScope: string };
function matchesFact(task: GroupTaskFact, ref: GroupTaskRef) {
  return (
    groupTaskKey(task) === groupTaskKey(ref) &&
    task.hostId === ref.hostId &&
    task.workspacePath === ref.workspacePath &&
    task.remoteSessionId === ref.remoteSessionId
  );
}
export function createTaskGroupService(options: {
  database(target: TaskGroupWorkspaceTarget): Promise<Domain>;
  resolveTasks(tasks: GroupTaskRef[]): Promise<GroupTaskFact[]>;
  afterChange(): Promise<void>;
}): ITaskGroupService {
  const domain = async (target: TaskGroupWorkspaceTarget) => {
    const resolved = await options.database(target);
    if (!resolved.storageScope.trim()) throw new Error("task-group.scope-unavailable");
    return resolved;
  };
  return {
    async read(targets) {
      const parsed = z.array(targetSchema).max(10000).parse(targets);
      const domains = new Map<
        DatabaseSync,
        { domain: Domain; targets: TaskGroupWorkspaceTarget[] }
      >();
      for (const target of parsed) {
        const resolved = await domain(target);
        const entry = domains.get(resolved.database);
        if (entry) entry.targets.push(target);
        else domains.set(resolved.database, { domain: resolved, targets: [target] });
      }
      return [...domains.values()].map(({ domain: resolved, targets: domainTargets }) => ({
        ...new TaskGroupRepository(resolved.database).read(),
        storageScope: resolved.storageScope,
        target: domainTargets[0]!,
        targets: domainTargets,
      }));
    },
    async save(input) {
      const { target, ...parsed } = z
        .object({
          target: targetSchema,
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple"]).optional(),
        })
        .strict()
        .parse(input);
      const resolved = await domain(target);
      const result = new TaskGroupRepository(resolved.database).save(parsed);
      await options.afterChange();
      return result;
    },
    async ungroup(input) {
      const { target, id } = z
        .object({ target: targetSchema, id: z.string().min(1) })
        .strict()
        .parse(input);
      new TaskGroupRepository((await domain(target)).database).ungroup(id);
      await options.afterChange();
    },
    async move(input) {
      const { target, ...parsed } = z
        .object({
          target: targetSchema,
          node: nodeSchema,
          sourceGroupId: z.string().min(1).nullable(),
          groupId: z.string().min(1).nullable(),
          anchor: z
            .object({ node: nodeSchema, side: z.enum(["before", "after"]) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const resolved = await domain(target);
      const refs = [parsed.node, parsed.anchor?.node].flatMap((node) =>
        node?.type === "task" ? [node.task] : [],
      );
      // 任务与锚点必须落在目标真实执行域，不能把另一 profile 的引用写入当前 SQLite。
      for (const ref of refs)
        if ((await domain(ref)).database !== resolved.database)
          throw new Error("task-group.cross-scope");
      const facts = await options.resolveTasks(refs);
      if (
        facts.length !== refs.length ||
        refs.some(
          (ref) => !facts.some((task) => matchesFact(task, ref) && !task.deleted && !task.archived),
        )
      )
        throw new Error("task-group.task-unavailable");
      new TaskGroupRepository(resolved.database).move(parsed);
      await options.afterChange();
    },
    async admit(input) {
      const parsed = z
        .object({
          tasks: z.array(taskSchema).max(10000),
          placement: z
            .object({
              task: taskSchema,
              groupId: z.string().min(1).nullable(),
              creationId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const facts = await options.resolveTasks(parsed.tasks);
      if (facts.some((fact) => !parsed.tasks.some((ref) => matchesFact(fact, ref))))
        throw new Error("task-group.task-unavailable");
      if (
        parsed.placement &&
        !facts.some((task) => matchesFact(task, parsed.placement!.task) && !task.deleted)
      )
        throw new Error("task-group.created-task-unavailable");
      const domains = new Map<DatabaseSync, GroupTaskFact[]>();
      for (const task of facts) {
        const { database } = await domain(task);
        const batch = domains.get(database) ?? [];
        batch.push(task);
        domains.set(database, batch);
      }
      const placementDatabase = parsed.placement
        ? (await domain(parsed.placement.task)).database
        : null;
      let changed = false;
      for (const [db, tasks] of domains) {
        const before = db.prepare("SELECT total_changes() AS n").get()?.n;
        new TaskGroupRepository(db).admit(
          tasks,
          db === placementDatabase ? parsed.placement : undefined,
        );
        changed ||= db.prepare("SELECT total_changes() AS n").get()?.n !== before;
      }
      if (changed) await options.afterChange();
    },
  };
}
