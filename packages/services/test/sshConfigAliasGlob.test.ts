import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSSHConfigAliasesFromLocalConfig } from "../src/system/sshConfigAlias.js";

test("SSH Include wildcard expands local config files", async () => {
  const home = await mkdtemp(join(tmpdir(), "ssh-include-glob-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = "";
  try {
    const sshDir = join(home, ".ssh");
    await mkdir(join(sshDir, "conf.d"), { recursive: true });
    await writeFile(join(sshDir, "config"), "Include conf.d/*.conf\n");
    await writeFile(
      join(sshDir, "conf.d", "database.conf"),
      "Host database\n  HostName db.example.test\n  Port 2222\n  User deploy\n",
    );

    const aliases = await listSSHConfigAliasesFromLocalConfig();
    assert.deepEqual(aliases, [
      {
        alias: "database",
        host: "db.example.test",
        port: 2222,
        username: "deploy",
        privateKeyPath: undefined,
        source: join(sshDir, "conf.d", "database.conf"),
      },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(home, { recursive: true, force: true });
  }
});
