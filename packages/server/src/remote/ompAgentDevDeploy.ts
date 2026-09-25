// Fork 专属的 omp 开发态远端部署；上游入口只保留兼容转发以减少同步冲突。
import { ZCODE_AGENT_PROVIDER, resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@zcode/server/remote/posixShell.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@zcode/server/remote/zcodeAgentWrapperDeploy.js";

const DEV_AGENT_BUNDLE_RELATIVE_PATH = "packages/omp-agent/dist/omp-agent.cjs";
const DEV_AGENT_BUNDLE_ENV = "ZCODE_REMOTE_DEV_AGENT_BUNDLE";
const REMOTE_DEV_AGENT_VERSION_FILE_NAME = ".dev-version";

interface DeployDevelopmentZCodeAgentRuntimeParams {
  runtimeVersion: string;
  runtimeResourceDir: string;
  remoteProviderDir: string;
  remoteVersionFile: string;
  remoteBinaryPath: string;
  remoteOmpBinaryPath: string;
  platformArch: string;
  force: boolean;
}

async function findUpward(relativePath: string): Promise<{ rootDir: string; path: string } | null> {
  let current = resolve(process.cwd());
  while (true) {
    const candidate = join(current, relativePath);
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    ) {
      return { rootDir: current, path: candidate };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function shouldUseDevelopmentAgentBundle(): boolean {
  if (resolveZCodeRuntimeEnv(process.env) !== "development") return false;
  const explicit = process.env[DEV_AGENT_BUNDLE_ENV]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") return false;
  if (explicit === "1" || explicit === "true") return true;
  return !process.env.VITEST;
}

async function resolveDevelopmentAgentAssets(platformArch: string): Promise<{
  bundlePath: string;
  ompPath: string;
} | null> {
  if (!shouldUseDevelopmentAgentBundle()) return null;
  const found = await findUpward(DEV_AGENT_BUNDLE_RELATIVE_PATH);
  if (!found) return null;
  const ompPath = join(
    found.rootDir,
    "packages/desktop/bundled-agents",
    platformArch,
    "glm/omp/omp",
  );
  if (
    !(await access(ompPath).then(
      () => true,
      () => false,
    ))
  )
    return null;
  return { bundlePath: found.path, ompPath };
}

async function uploadFile(
  backend: IRemoteBackend,
  localPath: string,
  remotePath: string,
  executable: boolean,
): Promise<void> {
  const tempPath = `${remotePath}.new-${randomUUID()}`;
  await backend.upload(localPath, tempPath);
  const command = executable
    ? buildRemoteExecutableReplaceCommand(tempPath, remotePath)
    : buildRemoteMoveCommand(tempPath, remotePath);
  await waitForClose(await backend.exec(command));
}

export async function deployDevelopmentZCodeAgentRuntime(
  backend: IRemoteBackend,
  params: DeployDevelopmentZCodeAgentRuntimeParams,
  loggers: DeployLoggers,
): Promise<boolean> {
  const assets = await resolveDevelopmentAgentAssets(params.platformArch);
  if (!assets) return false;

  const remoteBundlePath = `${params.remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`;
  const remoteDevVersionFile = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_VERSION_FILE_NAME}`;
  const hash = createHash("sha256");
  hash.update(await readFile(assets.bundlePath));
  hash.update(await readFile(assets.ompPath));
  const devVersion = hash.digest("hex");

  if (!params.force) {
    try {
      const [runtimeVersion, remoteDevVersion, wrapper] = await Promise.all([
        backend.readFile(params.remoteVersionFile),
        backend.readFile(remoteDevVersionFile),
        backend.readFile(params.remoteBinaryPath),
      ]);
      if (
        runtimeVersion.trim() === params.runtimeVersion &&
        remoteDevVersion.trim() === devVersion &&
        isRemoteAgentBundleWrapperCurrent(wrapper, params.runtimeResourceDir) &&
        (await backend.exists(remoteBundlePath)) &&
        (await backend.exists(params.remoteOmpBinaryPath))
      ) {
        loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态 omp 资源未变化，跳过`);
        return true;
      }
    } catch {
      // 首次部署或旧资源缺失时继续上传。
    }
  }

  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 上传开发态 omp 资源 ${devVersion.slice(0, 12)}`,
  );
  await waitForClose(
    await backend.exec(`mkdir -p ${quotePosixPathArg(params.remoteProviderDir + "/omp")}`),
  );
  await uploadFile(backend, assets.bundlePath, remoteBundlePath, false);
  await uploadFile(backend, assets.ompPath, params.remoteOmpBinaryPath, true);

  const wrapperContent = buildRemoteAgentBundleWrapper(params.runtimeResourceDir);
  const markers = [
    buildWriteLiteralFileCommand(remoteDevVersionFile, devVersion),
    buildWriteLiteralFileCommand(params.remoteVersionFile, params.runtimeVersion),
  ];
  if (isWslBackend(backend)) {
    await deployRemoteAgentWrapper({
      backend,
      content: wrapperContent,
      remoteWrapperPath: params.remoteBinaryPath,
    });
    await waitForClose(await backend.exec(markers.join(" && ")));
  } else {
    const wrapperTempPath = `${params.remoteBinaryPath}.new-${randomUUID()}`;
    await waitForClose(
      await backend.exec(
        [
          buildWriteLiteralFileCommand(wrapperTempPath, wrapperContent),
          buildRemoteExecutableReplaceCommand(wrapperTempPath, params.remoteBinaryPath),
          ...markers,
        ].join(" && "),
      ),
    );
  }
  loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态 omp 部署完成`);
  return true;
}
