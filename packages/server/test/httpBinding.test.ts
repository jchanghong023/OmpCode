import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { resolveHttpBindHost, resolveStaticFile } from "../src/http.js";

test("unauthenticated HTTP server is loopback only", () => {
  assert.equal(resolveHttpBindHost(undefined, undefined), "127.0.0.1");
  assert.equal(resolveHttpBindHost("localhost", undefined), "localhost");
  assert.throws(() => resolveHttpBindHost("0.0.0.0", undefined), /authentication token/);
  assert.throws(() => resolveHttpBindHost("::", ""), /authentication token/);
  assert.equal(resolveHttpBindHost("0.0.0.0", "secret"), "0.0.0.0");
});

async function createTempStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-static-"));
  await writeFile(join(root, "index.html"), "<html>ok</html>");
  return root;
}

// spaFallback=true 时未命中路径允许回退到 root 的 index.html（设计行为）；
// 对这类断言只要求"绝不返回 static root 之外的文件"。
function assertNeverOutside(resolved: string | null, root: string): void {
  if (resolved !== null) {
    assert.ok(
      !relative(root, resolved).startsWith(".."),
      `must stay inside static root: ${resolved}`,
    );
  }
}

test("static resolver still serves relative paths inside static root", async () => {
  const root = await createTempStaticRoot();
  const resolved = await resolveStaticFile(root, "/index.html", false);
  assert.ok(resolved, "relative /index.html must resolve");
  assert.equal(resolved.toLowerCase(), join(root, "index.html").toLowerCase());
});

test("static resolver rejects ../ traversal outside static root", async () => {
  const root = await createTempStaticRoot();
  await writeFile(join(dirname(root), "secret.txt"), "secret");
  // 字面量 ../（直接调用 resolveStaticFile 的健壮性）
  assert.equal(await resolveStaticFile(root, "/../secret.txt", false), null);
  // 真实请求中 URL 规范化会消解字面量 ../，攻击者用 %2e%2e 编码绕过，到达该函数时才解码
  assert.equal(await resolveStaticFile(root, "/%2e%2e/secret.txt", false), null);
  // 即使开启 SPA fallback 也不得借 index.html 泄露越界读取路径的存在性
  assert.equal(await resolveStaticFile(root, "/%2e%2e/secret.txt", true), null);
});

test(
  "static resolver rejects Windows absolute path forms (cross-drive traversal)",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await createTempStaticRoot();
    // 修复前：resolve(root, "C:/Windows/win.ini") 直接落到 C 盘，跨盘符 relative()
    // 返回绝对路径导致 isInsideDirectory 误判 inside，免鉴权返回盘外真实文件。
    // 现由 isInsideDirectory 的卷根一致性校验拦截（root 与 candidate 的 parse().root 不同盘）。
    assert.equal(await resolveStaticFile(root, "/C:/Windows/win.ini", false), null);
    // spaFallback=true 时：若 root 与目标同盘，该形态退化为 root 内未命中、回退 index.html
    // （设计行为）；无论哪种盘符组合，都绝不返回 root 外文件。
    assertNeverOutside(await resolveStaticFile(root, "/C:/Windows/win.ini", true), root);
    // 同盘符绝对路径形态同样必须拒绝
    const rootDrive = root.slice(0, 2);
    assert.equal(await resolveStaticFile(root, `/${rootDrive}/Windows/win.ini`, false), null);
    // 反斜杠/UNC 根形态："\x" 指向当前盘根，"\\server" 指向 UNC 共享
    assert.equal(await resolveStaticFile(root, "/\\Windows/win.ini", false), null);
    assert.equal(await resolveStaticFile(root, "/\\\\server/share/file.txt", false), null);
  },
);

test(
  "static resolver rejects drive-relative path forms (no separator after drive)",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await createTempStaticRoot();
    // 盘符相对形态（盘符后无分隔符，win32 isAbsolute 为 false 但 resolve 仍落到该盘）：
    // 修复前卷根校验缺失时，跨盘 drive-relative 会被 relative() 误判为 inside 并返回盘外真实文件。
    // root 在本机 tmpdir（C:）时 "/C:Windows/..." 以 staticRoot 为基目录解析、落在 root 内未命中；
    // root 换到 D: 盘时该形态落到 C 盘、由卷根一致性校验拦截——两种盘符组合都必须安全。
    assert.equal(await resolveStaticFile(root, "/C:Windows/win.ini", false), null);
    assertNeverOutside(await resolveStaticFile(root, "/c:windows/win.ini", true), root);
    // cwd 盘 drive-relative（本机 cwd 在 D:、tmpdir 在 C:，跨盘）：旧实现返回仓库根真实
    // package.json；现由卷根一致性校验拦截。若 tmpdir 与 cwd 同盘，则解析结果仍在 root
    // 内且文件不存在，同样返回 null——两种组合下断言均成立。
    assert.equal(await resolveStaticFile(root, "/d:package.json", false), null);
    // URL 形态的 //server/share 前导斜杠会被剥离、退化为 root 内相对路径，必 miss；
    // 真正危险的反斜杠 UNC 形态由 isInsideDirectory 的卷根校验拦截（见上一用例）。
    assert.equal(await resolveStaticFile(root, "//server/share/x", false), null);
  },
);
