import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const assets: Record<string, string> = {
  "omp-windows-x64.exe": "windows release fixture",
  "omp-linux-x64": "linux release fixture",
};
const sums = Object.entries(assets)
  .map(([name, content]) => `${createHash("sha256").update(content).digest("hex")}  ${name}`)
  .join("\n");

async function fixture(mode: "valid" | "missing" | "no-entry" | "wrong") {
  const root = await mkdtemp(join(tmpdir(), "omp-release-fetch-"));
  const desktop = join(root, "packages", "desktop");
  const script = join(desktop, "scripts", "fetch-omp-release.mjs");
  await mkdir(join(desktop, "scripts"), { recursive: true });
  await copyFile(new URL("../scripts/fetch-omp-release.mjs", import.meta.url), script);
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const name = request.url?.split("/").at(-1);
    if (name === "SHA256SUMS.txt") {
      response.statusCode = mode === "missing" ? 404 : 200;
      response.end(
        mode === "no-entry"
          ? ""
          : mode === "wrong"
            ? ` ${"0".repeat(64)}  omp-windows-x64.exe`
            : sums,
      );
    } else if (name && Object.hasOwn(assets, name)) {
      response.end(assets[name]);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  async function run(platform = "win32") {
    const env = { ...process.env };
    delete env.OMP_RELEASE_BINARY_PATH;
    delete env.OMP_RELEASE_SKIP;
    delete env.OMP_LINUX_LIBC;
    delete env.GITHUB_TOKEN;
    return execute(process.execPath, [script], {
      cwd: root,
      env: {
        ...env,
        OMP_RELEASE_TAG: "fixture-tag",
        OMP_RELEASE_DOWNLOAD_BASE: `http://127.0.0.1:${address.port}`,
        ZCODE_TARGET_OS: platform,
        ZCODE_TARGET_ARCH: "x64",
      },
      timeout: 15_000,
    });
  }
  return {
    desktop,
    run,
    requests: () => requests,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("发布资产与缓存均校验，缓存篡改在复制资源前失败", async () => {
  const f = await fixture("valid");
  try {
    await f.run();
    const staged = join(f.desktop, "bundled-agents", "win32-x64", "glm", "omp", "omp.exe");
    assert.equal(await readFile(staged, "utf8"), assets["omp-windows-x64.exe"]);
    const requests = f.requests();
    await f.run();
    assert.equal(f.requests(), requests, "verified cache reuse must not redownload");
    await writeFile(
      join(f.desktop, ".omp-release-cache", "fixture-tag", "omp-windows-x64.exe"),
      "corrupted",
    );
    await assert.rejects(f.run(), /SHA256 校验失败/);
    assert.equal(await readFile(staged, "utf8"), assets["omp-windows-x64.exe"]);
  } finally {
    await f.close();
  }
});

for (const mode of ["missing", "no-entry", "wrong"] as const) {
  test(`发布校验失败不能暂存资产：${mode}`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(f.run(), /SHA256/);
      await assert.rejects(
        readFile(join(f.desktop, "bundled-agents", "win32-x64", "glm", "omp", "omp.exe")),
        { code: "ENOENT" },
      );
    } finally {
      await f.close();
    }
  });
}

test("同 tag 多平台缓存分别保留资产来源与摘要", async () => {
  const f = await fixture("valid");
  try {
    await f.run();
    await f.run("linux");
    await f.run();
    for (const platform of ["win32", "linux"]) {
      const manifest = JSON.parse(
        await readFile(
          join(f.desktop, "bundled-agents", `${platform}-x64`, "glm", "omp", "omp-release.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.tag, "fixture-tag");
      assert.equal(manifest.asset, platform === "win32" ? "omp-windows-x64.exe" : "omp-linux-x64");
    }
  } finally {
    await f.close();
  }
});
