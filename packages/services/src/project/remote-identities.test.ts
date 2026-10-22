import { expect, it, vi } from "vitest";
import type { IProjectService } from "#src/project/contract.js";
import { bindRemoteProjectIdentities } from "#src/project/index.js";

it("returns attachment identity with prepared remote directories", async () => {
  const prepareSession = vi.fn(async () => ({
    projectId: "p",
    workspacePath: "/remote",
    additionalDirectories: ["/extra"],
  }));
  const resolve = vi.fn(async () => "remote:server:s:/remote");
  const service = bindRemoteProjectIdentities(
    { prepareSession } as unknown as IProjectService,
    resolve,
  );
  await expect(service.prepareSession({ projectId: "p" })).resolves.toMatchObject({
    workspacePath: "/remote",
    workspaceIdentity: "remote:server:s:/remote",
    additionalDirectories: ["/extra"],
  });
  expect(resolve).toHaveBeenCalledWith("/remote");
});

it("binds every remote task directory through the existing workspace identity resolver", async () => {
  const readTree = vi.fn(async () => ({
    projects: [],
    tasks: [
      { taskId: "one", workspacePath: "/repo", workspaceIdentity: "remote:ssh:old:22:u:/repo" },
      { taskId: "two", workspacePath: "/repo", workspaceIdentity: "remote:ssh:old:22:u:/repo" },
    ],
  }));
  const resolve = vi.fn(async (path: string) => `stable:${path}`);
  const service = bindRemoteProjectIdentities({ readTree } as unknown as IProjectService, resolve);
  const result = await service.readTree();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(result.tasks.map((task) => task.workspaceIdentity)).toEqual([
    "stable:/repo",
    "stable:/repo",
  ]);
});
