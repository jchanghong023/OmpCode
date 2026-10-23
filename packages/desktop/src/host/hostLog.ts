const NODE_WARNING_LOG_PATTERN =
  /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u;

export function shouldReportHostConsoleError(args: unknown[]): boolean {
  const message = args
    .map((arg) => stringifyHostLogArg(arg))
    .join(" ")
    .trimStart();
  return !NODE_WARNING_LOG_PATTERN.test(message);
}

export function stringifyHostLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  if (arg instanceof Error) {
    try {
      return JSON.stringify(serializeErrorForHostLog(arg));
    } catch {
      return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    }
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function serializeErrorForHostLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
} {
  const serialized: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  } = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) {
    serialized.stack = error.stack;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    // Error 被 JSON.stringify 时会变成 {}，导致远端握手失败只剩空对象。
    // cause 也可能是 Error，这里递归压成普通对象，保证 host 日志中继能保留真实错误链路。
    serialized.cause = cause instanceof Error ? serializeErrorForHostLog(cause) : cause;
  }
  return serialized;
}

interface HostOutputStream {
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * 原始 console 与结构化 parentPort 日志互不依赖；失效描述符只关闭对应输出 sink。
 */
export function createHostRawConsole(
  rawConsole: Pick<Console, "log" | "warn" | "error">,
  stdout: HostOutputStream,
  stderr: HostOutputStream,
): Pick<Console, "log" | "warn" | "error"> {
  function createSink(stream: HostOutputStream) {
    let available = true;
    function handleError(error: unknown): void {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "EBADF" && code !== "EPIPE") {
        throw error;
      }
      // Citrix／shell 关闭描述符时，异步 error 与同步 write 都可能失败；不递归写日志。
      available = false;
    }
    stream.on("error", handleError);
    return (write: (...args: unknown[]) => void, args: unknown[]): void => {
      if (!available) return;
      try {
        write(...args);
      } catch (error) {
        handleError(error);
      }
    };
  }

  const writeStdout = createSink(stdout);
  const writeStderr = createSink(stderr);
  return {
    log: (...args: unknown[]) => writeStdout(rawConsole.log, args),
    warn: (...args: unknown[]) => writeStderr(rawConsole.warn, args),
    error: (...args: unknown[]) => writeStderr(rawConsole.error, args),
  };
}
