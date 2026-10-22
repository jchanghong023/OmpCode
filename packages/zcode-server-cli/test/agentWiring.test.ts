import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseAgentWiring, resolveBundledAgentWiring } from "../src/runtime/agentWiring.js";
import { OMP_PROTOCOL_BASELINE } from "../../../scripts/omp-artifact.mjs";

const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-server-agent-wiring-"));
  temporaryDirs.push(dir);
  return dir;
}

async function seedArtifact(runtime: string): Promise<string> {
  const root = join(runtime, "omp");
  await mkdir(root);
  const executable = process.platform === "win32" ? "omp.exe" : "omp";
  await writeFile(join(root, executable), "fixture");
  await writeFile(
    join(root, "omp-artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      commit: "a".repeat(40),
      protocolBaseline: OMP_PROTOCOL_BASELINE,
      target: `${process.platform}-${process.arch}`,
      executable,
      files: { [executable]: createHash("sha256").update("fixture").digest("hex") },
    }),
  );
  return join(root, executable);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("resolveBundledAgentWiring", () => {
  it("returns verified target-platform OMP wiring, not the retained Node Agent", async () => {
    const entryDir = await makeTempDir();
    const command = await seedArtifact(entryDir);
    await writeFile(join(entryDir, "zcode.cjs"), "// retained bundle\n", "utf8");
    const wiring = await resolveBundledAgentWiring(entryDir, {});
    expect(wiring?.ZCODE_AGENT_SERVER_COMMAND).toBe(command);
    expect(JSON.parse(wiring?.ZCODE_AGENT_SERVER_ARGS_JSON ?? "[]")).toEqual([
      "app-server",
      "--stdio",
    ]);
  });

  it("keeps an explicit ZCODE_AGENT_SERVER_COMMAND untouched", async () => {
    const entryDir = await makeTempDir();
    await writeFile(join(entryDir, "zcode.cjs"), "// bundle\n", "utf8");

    const wiring = await resolveBundledAgentWiring(entryDir, {
      ZCODE_AGENT_SERVER_COMMAND: "/custom/agent",
    });
    expect(wiring).toBeNull();
  });

  it("returns null when no bundled zcode.cjs exists (dev workspace)", async () => {
    const entryDir = await makeTempDir();
    expect(await resolveBundledAgentWiring(entryDir, {})).toBeNull();
  });

  it("recomputes verified wiring from each immutable candidate release", async () => {
    const oldRuntime = await makeTempDir();
    const newRuntime = await makeTempDir();
    for (const runtime of [oldRuntime, newRuntime]) {
      const command = await seedArtifact(runtime);
      expect(await createReleaseAgentWiring(runtime, {})).toEqual({
        ZCODE_AGENT_SERVER_COMMAND: command,
        ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(["app-server", "--stdio"]),
      });
    }
  });

  it("does not replace an explicit agent command while computing release wiring", async () => {
    expect(
      await createReleaseAgentWiring("/release/runtime", {
        ZCODE_AGENT_SERVER_COMMAND: "/custom/agent",
      }),
    ).toBeNull();
  });

  it("rejects packaged legacy-only releases instead of falling back", async () => {
    const runtime = await makeTempDir();
    await writeFile(join(runtime, "zcode.cjs"), "// legacy");
    await expect(resolveBundledAgentWiring(runtime, {})).rejects.toThrow(
      /OMP artifact manifest missing/,
    );
    await expect(createReleaseAgentWiring(runtime, {})).rejects.toThrow(
      /OMP artifact manifest missing/,
    );
  });

  it("preserves explicit args with the verified default command", async () => {
    const runtime = await makeTempDir();
    await seedArtifact(runtime);
    const args = JSON.stringify(["app-server", "--stdio", "--profile", "isolated"]);
    expect(
      (
        await createReleaseAgentWiring(runtime, {
          ZCODE_AGENT_SERVER_ARGS_JSON: args,
        })
      )?.ZCODE_AGENT_SERVER_ARGS_JSON,
    ).toBe(args);
  });

  it("rejects a damaged packaged runtime even when both Agent entrypoints are missing", async () => {
    const runtime = await makeTempDir();
    await writeFile(join(runtime, "package.json"), JSON.stringify({ type: "module" }));
    await expect(resolveBundledAgentWiring(runtime, {})).rejects.toThrow(
      /OMP artifact manifest missing/,
    );
  });
});
