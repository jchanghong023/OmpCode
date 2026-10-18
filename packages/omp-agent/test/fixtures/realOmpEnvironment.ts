import { join } from "node:path";
import { MOCK_PROVIDER, MOCK_MODEL_ID } from "./ompMockServer.mjs";

export function createRealOmpEnvironment(
  inherited: NodeJS.ProcessEnv,
  options: {
    home: string;
    configRoot: string;
    ompBinary: string;
  },
): Record<string, string> {
  // 服务宿主会先合并 process.env；敏感项必须显式置空，不能只省略后被补回。
  const inheritedEnv = Object.fromEntries(
    Object.entries(inherited).map(([key, value]) => [
      key,
      /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(key) ||
      /^(?:PI|OMP)_(?:SMOL|SLOW|PLAN|COMPACT|ADVISOR|DEFAULT)_MODEL$/iu.test(key) ||
      /^(?:OMP_AUTH_BROKER_.+|PI_CONFIG_FILES|CLAUDE_CONFIG_DIR|OMP_OFFLINE|HOME|USERPROFILE|OMP_CONFIG_ROOT|OMP_PROFILE|PI_PROFILE|OMPCODE_CENTOS7_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_NATIVES_DIR|OMP_RPC_ARGS_JSON|OMP_E2E_MODEL_SELECTOR)$/iu.test(
        key,
      )
        ? ""
        : (value ?? ""),
    ]),
  );
  return {
    ...inheritedEnv,
    HOME: options.home,
    USERPROFILE: options.home,
    CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
    OMP_OFFLINE: "",
    PI_CONFIG_FILES: "",
    OMP_CONFIG_ROOT: options.configRoot,
    PI_NATIVES_DIR: join(options.configRoot, "natives"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    OMPCODE_CENTOS7_PROFILE: "",
    PI_CONFIG_DIR: "",
    PI_CODING_AGENT_DIR: "",
    OMP_E2E_MODEL_SELECTOR: "",
    PI_SMOL_MODEL: "",
    PI_SLOW_MODEL: "",
    PI_PLAN_MODEL: "",
    OMP_SMOL_MODEL: "",
    OMP_SLOW_MODEL: "",
    OMP_PLAN_MODEL: "",
    ZCODE_WORKSPACE_IDENTITY: "real-e2e-workspace",
    OMP_RPC_BINARY_PATH: options.ompBinary,
    OMP_RPC_ARGS_JSON: JSON.stringify([
      "--provider",
      MOCK_PROVIDER,
      "--model",
      MOCK_MODEL_ID,
      "--no-title",
      "--thinking",
      "low",
      "--approval-mode",
      "yolo",
    ]),
  };
}
