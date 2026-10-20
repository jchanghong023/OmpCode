import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { createArtifactIO } from "./test-gates-artifacts.mjs";
import { materializeStageGroup } from "./test-gates-action.mjs";
import { artifactCancelSelfTest } from "./test-gates-artifacts-cancel-selftest.mjs";

const ioPath = (path) => (process.platform === "win32" ? toNamespacedPath(path) : path);

// 使用真实文件而非 mock：覆盖普通目录新路径及仍需原生复制的链接边界。
export async function artifactIOSelfTest(root) {
  const workspace = join(root, "artifact-workspace");
  const bin = join(root, "artifact-bin");
  const source = join(bin, "gates/artifacts/gate-artifact-boundaries");
  const tree = join(source, "tree");
  const destination = join(workspace, "tree");
  const longRelative = join(
    ...Array.from({ length: 9 }, (_, index) => `long-directory-${index}-abcdefghijklmnop`),
    "leaf.txt",
  );
  await mkdir(ioPath(join(tree, longRelative, "..")), { recursive: true });
  await writeFile(ioPath(join(tree, longRelative)), "long-path-cache-content");
  await chmod(ioPath(join(tree, longRelative)), 0o444);
  await writeFile(join(tree, "product.txt"), "GOOD");
  await chmod(join(tree, "product.txt"), 0o444);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "unrelated.txt"), "keep-sibling");
  const stage = { id: "artifact-boundaries", outputs: ["tree"] };
  for (const [sourceMode, mode] of [
    [0o444, 0o444],
    [0o444, 0o666],
    [0o666, 0o444],
    [0o666, 0o666],
  ]) {
    const file = join(destination, "product.txt");
    await chmod(join(tree, "product.txt"), sourceMode);
    // 同 size/mtime 的篡改仍必须复制真实内容，不得复用旧恢复结果。
    await writeFile(file, "EVIL");
    const original = await stat(join(tree, "product.txt"));
    await utimes(file, original.atime, original.mtime);
    await chmod(file, mode);
    await materializeStageGroup([stage], bin, { workspace });
    assert.equal(await readFile(file, "utf8"), "GOOD");
    assert.equal(
      await readFile(ioPath(join(destination, longRelative)), "utf8"),
      "long-path-cache-content",
    );
    assert.equal(await readFile(join(destination, "unrelated.txt"), "utf8"), "keep-sibling");
    await writeFile(ioPath(join(destination, longRelative)), "long-path-consumer-write");
    assert.equal(
      await readFile(ioPath(join(destination, longRelative)), "utf8"),
      "long-path-consumer-write",
    );
    assert.equal(
      await readFile(ioPath(join(tree, longRelative)), "utf8"),
      "long-path-cache-content",
    );
    await writeFile(file, "consumer-overwrite");
    assert.equal(await readFile(file, "utf8"), "consumer-overwrite");
    assert.equal(await readFile(join(tree, "product.txt"), "utf8"), "GOOD");
    assert.equal((await stat(join(tree, "product.txt"))).mode & 0o200, sourceMode & 0o200);
  }
  // 完全相同的真实内容保持消费者时间戳；只读目的仍须恢复可写，缓存源保持只读。
  const product = join(destination, "product.txt");
  const stableTime = new Date("2001-02-03T04:05:06.000Z");
  await chmod(join(tree, "product.txt"), 0o444);
  for (const mode of [0o444, 0o666]) {
    await writeFile(product, "GOOD");
    await utimes(product, stableTime, stableTime);
    await chmod(product, mode);
    const before = await stat(product);
    await materializeStageGroup([stage], bin, { workspace });
    assert.equal(await readFile(product, "utf8"), "GOOD");
    assert.equal((await stat(product)).mtimeMs, before.mtimeMs);
    await writeFile(product, "consumer-can-still-write");
    assert.equal(await readFile(product, "utf8"), "consumer-can-still-write");
    assert.equal((await stat(join(tree, "product.txt"))).mode & 0o200, 0);
  }
  // 跨比较块的末尾篡改也必须恢复，不能仅比较首块或把大小一致当成内容一致。
  const largeSource = join(tree, "large.bin");
  const largeDestination = join(destination, "large.bin");
  const largeContents = Buffer.alloc(1024 * 1024 + 17, 0x61);
  await writeFile(largeSource, largeContents);
  await chmod(largeSource, 0o444);
  await writeFile(largeDestination, largeContents);
  await utimes(largeDestination, stableTime, stableTime);
  const unchanged = await stat(largeDestination);
  await materializeStageGroup([stage], bin, { workspace });
  assert.equal((await stat(largeDestination)).mtimeMs, unchanged.mtimeMs);
  largeContents[largeContents.length - 1] = 0x62;
  await writeFile(largeDestination, largeContents);
  const cached = await stat(largeSource);
  await utimes(largeDestination, cached.atime, cached.mtime);
  await materializeStageGroup([stage], bin, { workspace });
  largeContents[largeContents.length - 1] = 0x61;
  assert.deepEqual(await readFile(largeDestination), largeContents);
  assert.deepEqual(await readFile(largeSource), largeContents);
  // 生产者写入前准备必须遍历只读目录内容，也不能触及目录链接的目标。
  const outside = join(root, "artifact-link-target");
  await mkdir(outside);
  await writeFile(join(outside, "external.txt"), "external-unchanged");
  await chmod(join(outside, "external.txt"), 0o444);
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(outside, join(tree, "linked-directory"), type);
  await symlink(outside, join(source, "root-link"), type);
  if (process.platform !== "win32") await symlink("product.txt", join(tree, "linked-file"));
  await writeFile(join(source, "undeclared.txt"), "must-not-copy");
  await materializeStageGroup([stage, { id: stage.id, outputs: ["root-link"] }], bin, {
    workspace,
  });
  for (const link of ["tree/linked-directory", "root-link"]) {
    const path = join(workspace, link);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), await readlink(join(source, link)));
    assert.equal(await readFile(join(path, "external.txt"), "utf8"), "external-unchanged");
  }
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(destination, "linked-file"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(destination, "linked-file")), "product.txt");
    assert.equal(await readFile(join(destination, "linked-file"), "utf8"), "GOOD");
  }
  await assert.rejects(lstat(join(workspace, "undeclared.txt")), { code: "ENOENT" });
  await chmod(join(destination, "product.txt"), 0o444);
  await createArtifactIO().prepare(destination);
  await writeFile(join(destination, "product.txt"), "prepared-producer-write");
  assert.equal(await readFile(join(destination, "product.txt"), "utf8"), "prepared-producer-write");
  assert.equal((await stat(join(outside, "external.txt"))).mode & 0o200, 0);
  assert.equal(await readFile(join(outside, "external.txt"), "utf8"), "external-unchanged");
  // 缺失与真实目标类型冲突都必须拒绝；不经过组级取消，避免污染后续真实 Bazel 用例。
  await assert.rejects(
    createArtifactIO().copy(join(source, "missing"), join(workspace, "missing")),
    { code: "ENOENT" },
  );
  const blocker = join(workspace, "blocked-directory");
  await writeFile(blocker, "blocking-file");
  await assert.rejects(createArtifactIO().copy(tree, blocker), (error) =>
    ["EEXIST", "ENOTDIR"].includes(error.code),
  );
  assert.equal(await readFile(blocker, "utf8"), "blocking-file");
  await artifactCancelSelfTest(root);
}
