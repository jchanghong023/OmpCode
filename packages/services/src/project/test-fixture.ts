import type { VirtualProject } from "#src/project-storage/contract.js";

export function primaryDirectoryProject(primary: string, extra: string): VirtualProject {
  return {
    id: "project",
    hostId: "local",
    name: "Project",
    nameOverridden: true,
    roots: [
      { rootPath: extra, position: 0, isPrimary: false },
      { rootPath: primary, position: 1, isPrimary: true },
    ],
    pinned: false,
    deleted: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
