import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, toNamespacedPath } from "node:path";
import {
  commandOutput,
  commandsAreCancelled,
  trackGateIO,
  windowsSystemToolPath,
} from "./test-gates-process.mjs";

const ioPath = (path) => (process.platform === "win32" ? toNamespacedPath(path) : path);

// 一个物化组共享首错误；Node IO 无法由 taskkill 取消，停止准入后必须等已准入任务结束。
export function createArtifactIO() {
  let failure;
  const check = () => {
    if (failure) throw failure;
    if (commandsAreCancelled()) throw new Error("Gate cancelled; refusing artifact IO");
  };
  const fail = (error) => {
    failure ??= error;
  };
  async function existing(path) {
    try {
      return await lstat(ioPath(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    }
  }
  async function writable(path, info) {
    // chmod 会跟随链接，绝不能借工作区链接修改共享缓存或其他未声明路径。
    if (info && !info.isSymbolicLink() && !(info.mode & 0o200))
      await chmod(ioPath(path), info.mode | 0o200);
  }
  async function sameContents(source, destination, sourceInfo, destinationInfo) {
    // 大小只能证明不同；相同必须读取当前真实字节，不能信任时间戳或上次恢复结果。
    if (sourceInfo.size !== destinationInfo.size) return false;
    const handles = [];
    try {
      handles.push(await open(ioPath(source), "r"));
      handles.push(await open(ioPath(destination), "r"));
      // 每个在途文件最多占用两个 1 MiB 块；空文件仍须实际读到 EOF。
      const length = Math.max(1, Math.min(sourceInfo.size, 1024 * 1024));
      const left = Buffer.allocUnsafe(length);
      const right = Buffer.allocUnsafe(length);
      while (true) {
        check();
        const { bytesRead: sourceBytes } = await handles[0].read(left, 0, length, null);
        const { bytesRead: destinationBytes } = await handles[1].read(right, 0, length, null);
        if (
          sourceBytes !== destinationBytes ||
          !left.subarray(0, sourceBytes).equals(right.subarray(0, destinationBytes))
        )
          return false;
        if (!sourceBytes) return true;
      }
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      // 比较读盘与关闭句柄都属于同一次受监督 IO；失败也不能遗留另一句柄。
      const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
      const rejected = closed.find((result) => result.status === "rejected");
      if (rejected) {
        fail(rejected.reason);
        throw failure;
      }
    }
  }
  async function walk(initial, visit) {
    const pending = [initial];
    let offset = 0;
    while (offset < pending.length) {
      check();
      const batch = pending.slice(offset, offset + 16);
      offset += batch.length;
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          try {
            check();
            await visit(entry, pending);
          } catch (error) {
            fail(error);
            throw error;
          }
        }),
      );
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw failure;
    }
  }
  async function nativeLink(source, destination) {
    // Robocopy /SL /SJ 保留 Windows symlink/junction 本身，不解引用缓存链接。
    // 从父目录复制才能保留根链接；排除全部兄弟，不能扩大声明输出的所有权。
    const siblings = await readdir(ioPath(dirname(source)), { withFileTypes: true });
    const others = siblings.filter((entry) => entry.name !== basename(source));
    const directories = others.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    const files = others.filter((entry) => !entry.isDirectory());
    for (const attributesOnly of [true, false]) {
      check();
      const result = await commandOutput(
        windowsSystemToolPath("robocopy.exe"),
        [
          dirname(source),
          dirname(destination),
          "/E",
          "/SL",
          "/SJ",
          "/IS",
          "/IT",
          "/IM",
          "/R:0",
          "/W:0",
          attributesOnly ? "/COPY:A" : "/COPY:DAT",
          "/DCOPY:DT",
          ...(attributesOnly ? [] : ["/A-:R"]),
          ...(directories.length
            ? ["/XD", ...directories.map((entry) => join(dirname(source), entry.name))]
            : []),
          ...(files.length ? ["/XF", ...files.map((entry) => entry.name)] : []),
          "/NFL",
          "/NDL",
          "/NJH",
          "/NJS",
          "/NP",
        ],
        { quiet: true, stageId: "artifact-copy" },
      );
      if (result.reason || result.code >= 8 || result.code < 0)
        throw new Error(`Artifact copy failed (${result.code}): ${result.output.trim()}`);
    }
  }
  async function copy(source, destination) {
    await walk({ source, destination }, async (entry, pending) => {
      const sourceInfo = await lstat(ioPath(entry.source));
      if (sourceInfo.isSymbolicLink()) {
        if (process.platform === "win32") {
          await nativeLink(entry.source, entry.destination);
        } else {
          // 原因：bazel Linux 沙箱把动作声明输入物化为指向沙箱内部的绝对符号链接；
          // 按原文本复制会得到工作区外悬空链接，并与既有目标冲突（EEXIST symlink）。
          // 依据：绝对链接（沙箱/bazel-out 链接）解引用按真实内容复制；相对链接仍按
          // 原文本保留，仓库内相对缓存链接语义不变。
          const target = await readlink(ioPath(entry.source));
          if (isAbsolute(target))
            await cp(ioPath(entry.source), ioPath(entry.destination), {
              force: true,
              dereference: true,
              recursive: true,
            });
          else
            await cp(ioPath(entry.source), ioPath(entry.destination), {
              force: true,
              verbatimSymlinks: true,
              recursive: true,
            });
        }
        return;
      }
      let destinationInfo = await existing(entry.destination);
      if (destinationInfo?.isSymbolicLink()) {
        await unlink(ioPath(entry.destination));
        destinationInfo = undefined;
      }
      if (sourceInfo.isDirectory()) {
        await writable(entry.destination, destinationInfo);
        if (!destinationInfo?.isDirectory())
          await mkdir(ioPath(entry.destination), {
            recursive: true,
            mode: sourceInfo.mode | 0o700,
          });
        const entries = await readdir(ioPath(entry.source));
        for (const name of entries)
          pending.push({
            source: join(entry.source, name),
            destination: join(entry.destination, name),
          });
      } else if (sourceInfo.isFile()) {
        const mode = sourceInfo.mode | 0o200;
        if (
          destinationInfo?.isFile() &&
          (await sameContents(entry.source, entry.destination, sourceInfo, destinationInfo))
        ) {
          // 内容相同也要修复消费者改过的权限；已正确时不再产生 chmod 写入。
          if ((destinationInfo.mode & 0o7777) !== (mode & 0o7777))
            await chmod(ioPath(entry.destination), mode);
          return;
        }
        // 子文件的父目录已在入队前创建；仅独立文件输出需要补建，避免逐文件重复 IO。
        if (entry.source === source)
          await mkdir(ioPath(dirname(entry.destination)), { recursive: true });
        await writable(entry.destination, destinationInfo);
        await copyFile(ioPath(entry.source), ioPath(entry.destination));
        // copyFile 恢复源权限；仅只读源需要补 owner 写位，绝不 chmod 共享缓存源。
        await writable(entry.destination, sourceInfo);
      } else {
        throw new Error(`Unsupported declared artifact: ${entry.source}`);
      }
    });
  }
  async function prepare(target) {
    await walk(target, async (path, pending) => {
      const info = await existing(path);
      await writable(path, info);
      if (info?.isDirectory()) {
        const entries = await readdir(ioPath(path));
        for (const name of entries) pending.push(join(path, name));
      }
    });
  }
  return {
    // 登记整个操作，必须覆盖 copyFile 完成后仍在运行的 chmod 与同批已准入 IO。
    copy: (source, destination) => trackGateIO(copy(source, destination)),
    prepare: (target) => trackGateIO(prepare(target)),
    fail,
  };
}
