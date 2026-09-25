// 远端继续复用 server 的 Node 执行 omp 适配器，适配器从同目录 omp/ 拉起内嵌二进制。
// resolver 仍找 zcode-agent wrapper；业务会话由 omp-agent.cjs 拥有。

export const REMOTE_AGENT_BUNDLE_NAME = "omp-agent.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'runtime_root="${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.ompcode/server}"',
    `exec "$runtime_root/node" "$runtime_root/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
