import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const OMP_PROTOCOL_BASELINE = "c7c190724f3a00a2de998a0a5511201d5a2ba1a0";
export const OMP_ARTIFACT_MANIFEST = "omp-artifact.json";

async function containedFile(root, name) {
  if (typeof name !== "string" || !name || isAbsolute(name) || name.includes("\\")) {
    throw new Error(`OMP artifact invalid relative file: ${String(name)}`);
  }
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`OMP artifact file escapes root: ${name}`);
  }
  let cursor = path;
  while (cursor !== resolve(root)) {
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error(`OMP artifact symbolic link: ${name}`);
    cursor = dirname(cursor);
  }
  if (!(await lstat(path)).isFile()) throw new Error(`OMP artifact is not a file: ${name}`);
  return path;
}

async function sha256(path) {
  const hash = createHash("sha256");
  // Stream native-embedded executables: hashing must not allocate a whole binary or block Main IO.
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyOmpArtifact(root, target) {
  const manifestPath = resolve(root, OMP_ARTIFACT_MANIFEST);
  let contents;
  try {
    if ((await lstat(manifestPath)).isSymbolicLink())
      throw new Error(`OMP artifact symbolic link: ${manifestPath}`);
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`OMP artifact manifest missing: ${manifestPath}`, { cause: error });
    throw error;
  }
  const manifest = JSON.parse(contents);
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    typeof manifest.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.commit)
  ) {
    throw new Error(`OMP artifact invalid version/commit provenance: ${manifestPath}`);
  }
  if (manifest.protocolBaseline !== OMP_PROTOCOL_BASELINE) {
    throw new Error(`OMP artifact incompatible protocol baseline: ${manifest.protocolBaseline}`);
  }
  if (manifest.target !== target)
    throw new Error(
      `OMP artifact target mismatch: expected ${target}, received ${manifest.target}`,
    );
  if (
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files) ||
    typeof manifest.executable !== "string" ||
    !Object.hasOwn(manifest.files, manifest.executable)
  ) {
    throw new Error(`OMP artifact executable/file manifest missing: ${manifestPath}`);
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      name === OMP_ARTIFACT_MANIFEST ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      throw new Error(`OMP artifact invalid SHA-256: ${name}`);
    }
    const path = await containedFile(root, name);
    if ((await sha256(path)) !== digest) throw new Error(`OMP artifact SHA-256 mismatch: ${name}`);
  }
  return { command: await containedFile(root, manifest.executable), manifest };
}

export async function stageOmpArtifact({ sourceRoot, destination, target }) {
  if (!sourceRoot)
    throw new Error(
      "OMP artifact source missing: set ZCODE_OMP_ARTIFACT_ROOT to the pinned release directory",
    );
  const source = resolve(sourceRoot, target);
  const verified = await verifyOmpArtifact(source, target);
  const releasePath = resolve(sourceRoot, "omp-release.json");
  let release;
  try {
    release = JSON.parse(await readFile(releasePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`OMP release pin missing: ${releasePath}`, { cause: error });
    throw error;
  }
  const manifestDigest = await sha256(resolve(source, OMP_ARTIFACT_MANIFEST));
  if (
    release.artifacts?.[target] !== manifestDigest ||
    release.version !== verified.manifest.version ||
    release.commit !== verified.manifest.commit ||
    release.protocolBaseline !== verified.manifest.protocolBaseline
  ) {
    throw new Error(`OMP release provenance/digest mismatch: ${target}`);
  }
  await mkdir(destination, { recursive: true });
  for (const name of Object.keys(verified.manifest.files)) {
    const output = resolve(destination, name);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(await containedFile(source, name), output);
    if (name === verified.manifest.executable && !target.startsWith("win32-"))
      await chmod(output, 0o755);
  }
  await writeFile(
    resolve(destination, OMP_ARTIFACT_MANIFEST),
    `${JSON.stringify(verified.manifest, null, 2)}\n`,
  );
  return verifyOmpArtifact(destination, target);
}
