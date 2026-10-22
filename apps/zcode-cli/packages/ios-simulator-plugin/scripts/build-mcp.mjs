import { chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const desktopManifest = JSON.parse(await readFile(resolve(packageRoot, "../../../../packages/desktop/package.json"), "utf8"));
const runtimeTarget = desktopManifest.devDependencies?.electron === "28.3.3" ? "node18" : "node24";
const serverOutputPath = resolve(packageRoot, "dist", "mcp", "server.js");

await build({
  bundle: true,
  entryPoints: [resolve(packageRoot, "src", "mcp", "server.ts")],
  format: "esm",
  legalComments: "none",
  outfile: serverOutputPath,
  platform: "node",
  target: runtimeTarget,
});

await chmod(serverOutputPath, 0o755);
