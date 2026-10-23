import { mkdtemp, rm, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectService } from "#src/project/index.js";
import { resolveProjectWorkspaceSource } from "#src/project-storage/index.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { getZCodeDataRootDir, setDataBaseDir } from "#src/paths.js";
import { createZCodeAgentService } from "#src/zcode-agent/zcodeAgentService.js";

async function projectDomainFixture(sameRoot = false) {
  const root = await mkdtemp(join(tmpdir(), "project-owning-domain-"));
  const previousDataRoot = getZCodeDataRootDir();
  setDataBaseDir(root);
  const a = { workspacePath: join(root, "source-a") };
  const b = { workspacePath: join(root, "source-b") };
  await Promise.all([mkdir(a.workspacePath), mkdir(b.workspacePath)]);
  const nativeRootA = join(root, "native-a");
  const nativeRootB = sameRoot ? nativeRootA : join(root, "native-b");
  const profiles = new Map<string, string | null>([
    [a.workspacePath, "work"],
    [b.workspacePath, null],
  ]);
  const roots = new Map([
    [a.workspacePath, nativeRootA],
    [b.workspacePath, nativeRootB],
  ]);
  // 与原生 profile fixture 相同：子进程只报告启动 env/argv 的不可变事实，不回显调用参数冒充 owner。
  const scriptPath = join(root, "native-profile-facts.cjs");
  await writeFile(
    scriptPath,
    `
    const readline = require("node:readline");
    const profileIndex = process.argv.indexOf("--profile");
    const value = profileIndex < 0 ? "default" : process.argv[profileIndex + 1];
    const activeProfile = value === "default" ? null : value;
    const configRoot = process.env.OMP_CONFIG_ROOT;
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      const result = request.method === "runtime/capabilities" ? { ompProfiles: true } :
        request.method === "omp/profiles/list" ? {
          activeProfile, configRoot,
          storageScope: JSON.stringify([configRoot, activeProfile]),
          profiles: [{ name: activeProfile, active: true }, { name: "pending-do-not-inherit", active: false }],
          candidate: "pending-do-not-inherit"
        } : {};
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    });
  `,
  );
  const agent = createZCodeAgentService({
    commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    resolveSpawnEnv: () => ({ OMP_CONFIG_ROOT: "ambient-must-not-own-project" }),
    resolveOmpProfile: async (target) => profiles.get(target.workspacePath),
    resolveOmpConfigRoot: async (target) => roots.get(target.workspacePath),
    saveOmpProfile: async (target, profile) => {
      profiles.set(target.workspacePath, profile);
    },
    prepareNewWorkspaceOmpProfilePreference: async (target, inherited) => {
      if (profiles.has(target.workspacePath) || roots.has(target.workspacePath)) return;
      profiles.set(target.workspacePath, inherited.profile);
      roots.set(target.workspacePath, inherited.configRoot);
    },
  });
  const index = new TaskIndexRepo();
  index.configureNativeOmpScope((target) => agent.getOmpProfiles(target));
  const repoA = await index.getProjectRepository(a);
  const repoB = await index.getProjectRepository(b);
  const project = repoA.saveProject({ roots: [], name: "A empty project" });
  const service = createProjectService({
    workspaceDirectory: join(root, "generated"),
    repository: (target) => index.getProjectRepository(target ?? b),
    repositories: async () =>
      Promise.all(index.getActiveRepositories().map((owner) => owner.getProjectRepository())),
    projectWorkspaceSource: (repository, preferred) =>
      resolveProjectWorkspaceSource(index, repository, preferred),
    prepareWorkspaceScope: async (source, destination) => {
      if (!source) throw new Error("project.workspace-source-unavailable");
      await agent.prepareNewWorkspaceOmpProfile(source, destination);
    },
  });
  return {
    root,
    a,
    b,
    agent,
    index,
    repoA,
    repoB,
    project,
    service,
    profiles,
    roots,
    async close() {
      await agent.disposeAllAndWait();
      index.close();
      setDataBaseDir(previousDataRoot);
      await rm(root, { recursive: true, force: true });
    },
  };
}

it.each([false, true])(
  "空项目使用其实际 SQLite owner 的活源而非当前 B，sameRoot=%s",
  async (sameRoot) => {
    const fixture = await projectDomainFixture(sameRoot);
    const { agent, index, repoA, repoB, project, service, a, b } = fixture;
    try {
      const sourceFacts = await agent.getOmpProfiles(a);
      await agent.selectOmpProfile({
        ...a,
        profile: "pending-do-not-inherit",
        expectedRuntimeIdentity: sourceFacts.runtimeIdentity,
        apply: "next-start",
      });
      const result = await service.prepareSession({ projectId: project.id, sourceWorkspace: b });
      expect(result.projectId).toBe(project.id);
      const actual = await agent.getOmpProfiles(result);
      expect(actual).toMatchObject({
        configRoot: sourceFacts.configRoot,
        activeProfile: "work",
        storageScope: sourceFacts.storageScope,
      });
      expect(await index.getProjectRepository(result)).toBe(repoA);
      const task = {
        workspacePath: result.workspacePath,
        taskId: "ba14e66d-b01d-4a79-a7ee-b2aa141f5627",
      };
      repoA.reserveCreatedTask({ task, projectId: project.id });
      await index.applyCliFacts({
        meta: {
          ...task,
          traceId: task.taskId,
          title: "Created in A",
          provider: "glm",
          mode: "default",
          createdAt: 1,
          updatedAt: 2,
        },
        lastOutcome: "completed",
      });
      expect((await service.readTree()).projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: project.id,
            roots: [expect.objectContaining({ rootPath: result.workspacePath })],
          }),
        ]),
      );
      expect((await service.readTree()).tasks).toEqual(
        expect.arrayContaining([expect.objectContaining({ ...task, projectId: project.id })]),
      );
      await expect(service.resolveSessionDirectories(task)).resolves.toMatchObject({
        projectId: project.id,
        workspacePath: result.workspacePath,
      });
      expect(repoB.readTree().projects).toEqual([]);
      expect(repoB.readTree().tasks).toEqual([]);
      expect(await agent.getOmpProfiles(a)).toMatchObject({
        activeProfile: "work",
        selectedProfile: "pending-do-not-inherit",
        pending: true,
        runtimeIdentity: sourceFacts.runtimeIdentity,
      });
      // 已初始化项目的同域重试不再复制偏好，也不改变既有会话归属。
      await expect(
        service.prepareSession({ projectId: project.id, sourceWorkspace: a }),
      ).resolves.toEqual(result);
    } finally {
      await fixture.close();
    }
  },
);

it("生成路径已有 B 域偏好时拒绝跨域 root 写入，保全原项目、偏好与旧 UUID", async () => {
  const fixture = await projectDomainFixture();
  const { agent, index, repoA, repoB, project, service, profiles, roots, b } = fixture;
  try {
    const generated = join(fixture.root, "generated", project.id);
    const bFacts = await agent.getOmpProfiles(b);
    profiles.set(generated, null);
    roots.set(generated, bFacts.configRoot!);
    const oldTask = { ...b, taskId: "2519e64d-ec7c-4307-87cb-5c6b90a2cad8" };
    await index.applyCliFacts({
      meta: {
        ...oldTask,
        traceId: oldTask.taskId,
        title: "Old B",
        provider: "glm",
        mode: "default",
        createdAt: 1,
        updatedAt: 2,
      },
      lastOutcome: "completed",
    });
    const beforeB = repoB.readTree();
    await expect(
      service.prepareSession({ projectId: project.id, sourceWorkspace: b }),
    ).rejects.toThrow("project.workspace-domain-mismatch");
    expect(repoA.readTree().projects.find((item) => item.id === project.id)?.roots).toEqual([]);
    expect(repoB.readTree()).toEqual(beforeB);
    expect(profiles.get(generated)).toBe(null);
    expect(roots.get(generated)).toBe(bFacts.configRoot);
    expect(await agent.getOmpProfiles(b)).toMatchObject({
      runtimeIdentity: bFacts.runtimeIdentity,
      activeProfile: null,
      pending: false,
    });
  } finally {
    await fixture.close();
  }
});

it("没有可信 A 域 source 时拒绝创建，未知域不污染空项目或生成路径偏好", async () => {
  const fixture = await projectDomainFixture();
  const { index, repoA, project, service, b, profiles, roots } = fixture;
  try {
    // 真实 owner resolver 明确失去 A 的运行事实；B 仍可服务，不能借 B 兜底。
    index.setOmpScopeResolver(async (target) => {
      if (target.workspacePath !== b.workspacePath)
        throw new Error("Native OMP organization scope is unavailable");
      const facts = await fixture.agent.getOmpProfiles(b);
      return { configRoot: facts.configRoot!, profileId: facts.activeProfile };
    });
    const beforeProfiles = new Map(profiles);
    const beforeRoots = new Map(roots);
    await expect(
      service.prepareSession({ projectId: project.id, sourceWorkspace: b }),
    ).rejects.toThrow("project.workspace-source-unavailable");
    expect(repoA.readTree().projects.find((item) => item.id === project.id)?.roots).toEqual([]);
    expect(profiles).toEqual(beforeProfiles);
    expect(roots).toEqual(beforeRoots);
    expect(await readdir(fixture.root)).not.toContain("generated");
  } finally {
    await fixture.close();
  }
});

it("同域 source 初始化空项目仍成功，根与会话预留使用同一个 owner", async () => {
  const fixture = await projectDomainFixture();
  try {
    const result = await fixture.service.prepareSession({
      projectId: fixture.project.id,
      sourceWorkspace: fixture.a,
    });
    expect(await fixture.index.getProjectRepository(result)).toBe(fixture.repoA);
    const task = {
      workspacePath: result.workspacePath,
      taskId: "57f31bd2-1cf4-4ef0-aac5-55c0fa95b506",
    };
    expect(fixture.repoA.reserveCreatedTask({ task, projectId: fixture.project.id })).toMatchObject(
      { projectId: fixture.project.id, workspacePath: result.workspacePath },
    );
    await expect(fixture.service.resolveSessionDirectories(task)).resolves.toMatchObject({
      projectId: fixture.project.id,
      workspacePath: result.workspacePath,
    });
  } finally {
    await fixture.close();
  }
});
