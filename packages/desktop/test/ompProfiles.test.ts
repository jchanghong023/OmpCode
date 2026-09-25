import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { listOmpProfiles } from "../src/main/ompProfiles.js";

test("只列出现有合法 profile，包含默认档", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "omp-profile-list-"));
  context.after(async () => {
    assert.ok(resolve(home).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
  await mkdir(join(home, ".omp", "profiles", "bad name"), { recursive: true });
  assert.deepEqual(await listOmpProfiles(home, {}), ["default", "work"]);
  assert.deepEqual(
    await listOmpProfiles(home, { PI_CONFIG_DIR: relative(home, join(home, ".omp")) }),
    ["default", "work"],
  );
});
