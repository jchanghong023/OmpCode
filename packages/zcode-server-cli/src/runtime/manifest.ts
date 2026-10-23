import { platform, arch } from "node:process";
import { SERVER_RUNTIME_NODE_VERSION } from "../contracts.js";
import { z } from "zod";

export const supportedServerTargets = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
] as const;

export type ServerTarget = (typeof supportedServerTargets)[number];

export interface ServerRuntimeManifest {
  product: "zcode-server";
  target: ServerTarget;
  appVersion: string;
  nodeVersion: string;
  entrypoints: { cli: string; core: string };
  native: string[];
  tools?: string[];
  plugins?: string[];
  components?: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }>;
}

export const serverRuntimeManifestSchema = z
  .object({
    product: z.literal("zcode-server"),
    target: z.enum(supportedServerTargets),
    appVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    entrypoints: z.object({ cli: z.string(), core: z.string() }).strict(),
    native: z.array(z.string()),
    tools: z.array(z.string()).optional(),
    plugins: z.array(z.string()).optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export function currentServerTarget(): ServerTarget {
  const target = `${platform}-${arch}`;
  if (!supportedServerTargets.includes(target as ServerTarget)) {
    throw new Error(`Unsupported ZCode Server target: ${target}`);
  }
  return target as ServerTarget;
}

export function createRuntimeManifest(
  target = currentServerTarget(),
  appVersion = "0.0.0-dev",
  extras: Pick<ServerRuntimeManifest, "tools" | "plugins" | "components"> = {},
): ServerRuntimeManifest {
  return {
    product: "zcode-server",
    target,
    appVersion,
    nodeVersion: SERVER_RUNTIME_NODE_VERSION,
    // 此 manifest 只声明 Source Server 的内部入口；外部 OMP 由运行环境提供，
    // 保留的 zcode.cjs 是 CLI/TUI 资产，不是 Agent 备用入口。
    entrypoints: {
      cli: "runtime/server-cli.js",
      core: "runtime/server-core.js",
    },
    native: ["node-pty"],
    ...extras,
  };
}
