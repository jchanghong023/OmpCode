/**
 * Host 工具进程的 stdout/stderr 写入目标可能继承 Citrix 或 shell 会话中的
 * 无效描述符。EBADF/EPIPE 表示原始输出管道已关闭：此时日志继续经既有结构化
 * 消息通道发往 Main，不能让写日志反杀 Host；无关写错误保持可见
 * （centos7-release.md「Host 工具进程使用专属 stdout/stderr 管道」）。
 *
 * 独立成模块是为了让该容错分类可被 UT 直接覆盖（host/index.ts 入口文件
 * 含大量进程级副作用，无法在纯 Node 测试中装载）。
 */
export function isClosedHostOutput(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === "EBADF" ||
      (error as NodeJS.ErrnoException).code === "EPIPE")
  );
}
