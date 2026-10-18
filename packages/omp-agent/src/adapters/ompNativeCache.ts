import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { logger } from "./logger.js";

/** 只拥有本 core 创建的叶目录；父根及原有共享 addon 从不修改或删除。 */
export class OmpNativeCache {
  private preparation: Promise<NodeJS.ProcessEnv> | undefined;
  private closed: Promise<void> = Promise.resolve();
  private directory: string | undefined;
  private cleanup: Promise<void> | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly coreInstanceId: string,
    private readonly fields: () => Record<string, unknown>,
  ) {}

  prepare(): Promise<NodeJS.ProcessEnv> {
    return (this.preparation ??= this.create());
  }

  private async create(): Promise<NodeJS.ProcessEnv> {
    if (process.platform !== "win32") return this.env;
    logger.debug("omp_core_native_cache_preparing", {
      ...this.fields(),
      event: "omp_core_native_cache_preparing",
      stage: "native_cache",
    });
    try {
      let parent = this.env.PI_NATIVES_DIR?.trim();
      const home = this.env.USERPROFILE ?? homedir();
      if (parent === "~") parent = home;
      else if (parent?.startsWith("~/") || parent?.startsWith("~\\"))
        parent = home + parent.slice(1);
      const root = parent && isAbsolute(parent) ? normalize(parent) : tmpdir();
      await mkdir(root, { recursive: true });
      // Windows 已加载 DLL 会令共享目标 rename 触发 EPERM；每个真核使用空叶隔离，而非重试或预热掩盖竞争。
      this.directory = await mkdtemp(join(root, `omp-core-${this.coreInstanceId}-`));
      logger.debug("omp_core_native_cache_prepared", {
        ...this.fields(),
        event: "omp_core_native_cache_prepared",
        stage: "native_cache",
      });
      return { ...this.env, PI_NATIVES_DIR: this.directory };
    } catch (error) {
      this.logFailure("omp_core_native_cache_prepare_failed", error);
      throw error;
    }
  }

  track(child: ChildProcessWithoutNullStreams): void {
    // exit 可能先于 stdio / DLL 句柄释放；仅 close 后允许删除加载过的 native 文件。
    this.closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        resolve();
        void this.remove().catch(() => undefined);
      }),
    );
  }

  async dispose(): Promise<void> {
    await this.preparation?.catch(() => undefined);
    await this.closed;
    await this.remove();
  }

  private remove(): Promise<void> {
    if (!this.directory) return Promise.resolve();
    const directory = this.directory;
    return (this.cleanup ??= (async () => {
      try {
        await rm(directory, { recursive: true, force: true });
        logger.debug("omp_core_native_cache_removed", {
          ...this.fields(),
          event: "omp_core_native_cache_removed",
          stage: "native_cache",
        });
      } catch (error) {
        this.logFailure("omp_core_native_cache_cleanup_failed", error);
        throw error;
      }
    })());
  }

  private logFailure(event: string, error: unknown): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    logger.error(event, {
      ...this.fields(),
      event,
      stage: "native_cache",
      errorType: error instanceof Error ? error.name : typeof error,
      errorCode: typeof code === "string" ? code : undefined,
    });
  }
}
