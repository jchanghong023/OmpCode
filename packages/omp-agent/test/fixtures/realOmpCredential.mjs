import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

// 只读取本机既有 GLM 凭据；不复制认证库，不把密钥写入日志、配置或证据。
export async function realOmpCredential(binary) {
  const result = await runFile(binary, ["token", "zhipu-coding-plan", "--raw"], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }).catch(() => {
    throw new Error("Existing zhipu-coding-plan credential unavailable (details withheld)");
  });
  const key = result.stdout.trim();
  if (!key || key.includes("\n")) throw new Error("Expected one existing provider credential");
  return { ZHIPU_API_KEY: key };
}
