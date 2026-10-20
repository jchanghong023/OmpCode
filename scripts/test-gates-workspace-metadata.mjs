import { readFile, readdir } from "node:fs/promises";

// One entry process owns this read-only discovery. Every new invocation discovers
// manifests again; no mtime shortcuts or persisted metadata participate.
let rootManifest;
let packageManifests;

export function workspaceRootManifest() {
  return (rootManifest ??= readFile(new URL("../package.json", import.meta.url), "utf8").then(
    JSON.parse,
  ));
}

export function workspacePackageManifests() {
  return (packageManifests ??= discoverPackages());
}

async function discoverPackages() {
  const entries = (
    await readdir(new URL("../packages/", import.meta.url), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  const manifests = new Map();
  // Bound independent reads and retain directory order regardless of completion.
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 8).map(async (entry) => {
        try {
          const manifest = JSON.parse(
            await readFile(
              new URL(`../packages/${entry.name}/package.json`, import.meta.url),
              "utf8",
            ),
          );
          return [entry.name, manifest];
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        }
      }),
    );
    for (const entry of batch) if (entry) manifests.set(...entry);
  }
  return manifests;
}
