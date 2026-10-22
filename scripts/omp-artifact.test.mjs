import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OMP_PROTOCOL_BASELINE, stageOmpArtifact, verifyOmpArtifact } from "./omp-artifact.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(target = "linux-x64") {
  const root = mkdtempSync(join(tmpdir(), "zcode-omp-artifact-"));
  roots.push(root);
  const source = join(root, target);
  mkdirSync(source);
  writeFileSync(join(source, "omp"), "executable-fixture");
  const manifest = {
    schemaVersion: 1,
    version: "1.2.3",
    commit: "a".repeat(40),
    protocolBaseline: OMP_PROTOCOL_BASELINE,
    target,
    executable: "omp",
    files: { omp: sha("executable-fixture") },
  };
  const pin = () => {
    writeFileSync(join(source, "omp-artifact.json"), JSON.stringify(manifest));
    writeFileSync(
      join(root, "omp-release.json"),
      JSON.stringify({
        version: manifest.version,
        commit: manifest.commit,
        protocolBaseline: manifest.protocolBaseline,
        artifacts: { [target]: sha(readFileSync(join(source, "omp-artifact.json"))) },
      }),
    );
  };
  pin();
  return { root, source, manifest, pin };
}
describe("fixed OMP distribution", () => {
  it("stages the pinned target and resolves only an absolute verified executable", async () => {
    const { root } = fixture();
    const destination = join(root, "staged");
    expect(
      (await stageOmpArtifact({ sourceRoot: root, destination, target: "linux-x64" })).command,
    ).toBe(join(destination, "omp"));
    expect((await verifyOmpArtifact(destination, "linux-x64")).manifest.commit).toBe(
      "a".repeat(40),
    );
  });
  it("rejects missing artifacts and wrong execution platform", async () => {
    const { source } = fixture();
    await expect(verifyOmpArtifact(join(source, "missing"), "linux-x64")).rejects.toThrow(
      /manifest missing/,
    );
    await expect(verifyOmpArtifact(source, "win32-x64")).rejects.toThrow(/target mismatch/);
  });
  it("fails closed on tampering or incompatible protocol", async () => {
    const { source, manifest, pin } = fixture();
    writeFileSync(join(source, "omp"), "tampered");
    await expect(verifyOmpArtifact(source, "linux-x64")).rejects.toThrow(/SHA-256 mismatch/);
    manifest.protocolBaseline = "b".repeat(40);
    pin();
    await expect(verifyOmpArtifact(source, "linux-x64")).rejects.toThrow(/incompatible protocol/);
  });
  it("rejects manifest drift from the fixed multi-platform release", async () => {
    const { root, source, manifest } = fixture();
    manifest.version = "9.9.9";
    writeFileSync(join(source, "omp-artifact.json"), JSON.stringify(manifest));
    await expect(
      stageOmpArtifact({
        sourceRoot: root,
        destination: join(root, "staged"),
        target: "linux-x64",
      }),
    ).rejects.toThrow(/release.*mismatch/);
  });
  it("rejects invalid version or source commit provenance", async () => {
    const { source, manifest, pin } = fixture();
    manifest.version = "floating-main";
    pin();
    await expect(verifyOmpArtifact(source, "linux-x64")).rejects.toThrow(
      /version\/commit provenance/,
    );
    manifest.version = "1.2.3";
    manifest.commit = "main";
    pin();
    await expect(verifyOmpArtifact(source, "linux-x64")).rejects.toThrow(
      /version\/commit provenance/,
    );
  });
  it("rejects traversal paths before copying", async () => {
    const { root, manifest, pin } = fixture();
    manifest.files["../escape"] = sha("escape");
    writeFileSync(join(root, "escape"), "escape");
    pin();
    await expect(
      stageOmpArtifact({
        sourceRoot: root,
        destination: join(root, "staged"),
        target: "linux-x64",
      }),
    ).rejects.toThrow(/escapes root/);
  });
});
