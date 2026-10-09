import { loadEndpointEnv } from "./load-endpoint-env.mjs";
const endpointEnv = await loadEndpointEnv();
const DEFAULT_INTRANET_MACHINE_HOST = "";
function resolveIntranetMachineHost(env = { ...endpointEnv, ...process.env }) {
  // 自建镜像机器地址统一从 INTRANET_MACHINE_HOST 读取，避免多处硬编码漏改。
  return env.INTRANET_MACHINE_HOST?.trim() || DEFAULT_INTRANET_MACHINE_HOST;
}

const INTRANET_ASSET_SERVICE_PORT = 12345;

export function resolveIntranetDepsBaseUrl(env = process.env) {
  env = { ...endpointEnv, ...env };
  const depsBaseUrl = env.ZCODE_DEPS_BASE_URL?.trim();
  if (depsBaseUrl) {
    return depsBaseUrl.replace(/\/+$/, "");
  }

  const host = resolveIntranetMachineHost(env);
  if (!host)
    throw new Error(
      "Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST in .env before downloading internal dependencies",
    );
  return `http://${host}:${INTRANET_ASSET_SERVICE_PORT}/zcode/deps`;
}
