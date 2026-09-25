import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  type RemoteResourcePackageId,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@zcode/server/remote/remoteAssetInstaller.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";
import { deployDevelopmentZCodeAgentRuntime } from "@zcode/server/remote/zcodeAgentDevDeploy.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@zcode/server/remote/zcodeAgentWrapperDeploy.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";

const REMOTE_AGENT_RUNTIME_BASE = `${REMOTE_BASE}/agents`;

export interface DeployZCodeAgentRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
  force?: boolean;
}

function isSelectedZCodeAgentComponent(
  componentId: string,
  selectedResourcePackageIds: readonly RemoteResourcePackageId[] | undefined,
): boolean {
  return (
    !selectedResourcePackageIds ||
    selectedResourcePackageIds.includes(componentId as RemoteResourcePackageId)
  );
}

async function shouldSkipZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  remoteOmpBinaryPath: string;
  runtimeResourceDir: string;
  expectedArtifactSha256: string | null;
  componentId: string;
  platformArch: string;
  force: boolean;
  installer: RemoteAssetInstaller;
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  if (!params.expectedArtifactSha256) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=manifest SHA unavailable`,
    );
    return false;
  }

  const identityDecision = await checkRemoteAssetComponentIdentity(params.backend, {
    componentId: params.componentId,
    platformArch: params.platformArch,
    expectedIdentity: { sha256: params.expectedArtifactSha256 },
  });
  if (identityDecision.shouldDeploy) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=${identityDecision.reason}`,
    );
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote wrapper missing path=${params.remoteBinaryPath}`,
    );
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        params.loggers.logWarn(
          `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=wsl wrapper stale path=${params.remoteBinaryPath}`,
        );
        return false;
      }
    } catch {
      return false;
    }
  }

  // wrapper 在、但 omp-agent.cjs 缺失（被清理 / 旧部署残留）时也要重新部署。
  if (!(await params.backend.exists(params.remoteBundlePath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote bundle missing path=${params.remoteBundlePath}`,
    );
    return false;
  }
  if (!(await params.backend.exists(params.remoteOmpBinaryPath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=omp binary missing path=${params.remoteOmpBinaryPath}`,
    );
    return false;
  }

  params.loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 制品 SHA ${params.expectedArtifactSha256} 已部署，跳过`,
  );
  return true;
}

/**
 * 部署 ZCode Agent runtime 到远程机器。
 *
 * 生产态只用 manifest SHA 判断制品是否变化；语义版本不参与跳过决策。
 */
export async function deployZCodeAgentRuntime(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployZCodeAgentRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const provider = ZCODE_AGENT_PROVIDER;
  const runtime = ZCODE_AGENT_RUNTIME;
  const componentId = provider;
  if (!isSelectedZCodeAgentComponent(componentId, options.selectedResourcePackageIds)) {
    loggers.log(`[zcode-agent-deploy] ${provider}: 未选择资源包 ${componentId}，跳过检查和部署`);
    return;
  }

  // binaryName 指 wrapper 可执行文件名（如 zcode-agent / zcode-agent.exe）——
  // 一个调用远端 node 执行 omp-agent.cjs 的壳脚本。
  const binaryName = runtime.resolveEntrySegments(env.platform).at(-1);
  if (!binaryName) {
    loggers.logWarn(`[zcode-agent-deploy] ${provider}: 无法解析 agent 入口名称，跳过部署`);
    return;
  }

  const remoteProviderDir = `${REMOTE_AGENT_RUNTIME_BASE}/${runtime.bundledResourceDir}`;
  const remoteVersionFile = `${remoteProviderDir}/.version`;
  const remoteBinaryPath = `${remoteProviderDir}/${binaryName}`;
  const remoteBundlePath = `${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`;
  const remoteOmpBinaryPath = `${remoteProviderDir}/omp/omp`;

  if (
    await deployDevelopmentZCodeAgentRuntime(
      backend,
      {
        runtimeVersion: runtime.version,
        runtimeResourceDir: runtime.bundledResourceDir,
        remoteProviderDir,
        remoteVersionFile,
        remoteBinaryPath,
        remoteOmpBinaryPath,
        platformArch: options.platformArch,
        force: Boolean(options.force),
      },
      loggers,
    )
  ) {
    return;
  }

  let expectedArtifactSha256: string | null = null;
  try {
    expectedArtifactSha256 =
      (await options.installer.resolveComponentSha256?.(componentId)) ?? null;
  } catch (error) {
    loggers.logWarn(
      `[zcode-agent-deploy] ${provider}: 读取 manifest SHA 失败，将重新部署: ${String(error)}`,
    );
  }

  if (
    await shouldSkipZCodeAgentDeploy({
      backend,
      remoteBinaryPath,
      remoteBundlePath,
      remoteOmpBinaryPath,
      runtimeResourceDir: runtime.bundledResourceDir,
      expectedArtifactSha256,
      componentId,
      platformArch: options.platformArch,
      force: Boolean(options.force),
      installer: options.installer,
      loggers,
    })
  ) {
    return;
  }

  loggers.log(`[zcode-agent-deploy] ${provider}: 开始部署 v${runtime.version}...`);
  const forceRefreshRuntimeAsset = Boolean(options.force);
  // 二进制与适配器均就绪后才更新 wrapper 与 live marker，避免半成品被复用。
  await options.installer.installFile({
    componentId,
    sourceRelativePath: `${runtime.bundledResourceDir}/${options.platformArch}/${REMOTE_AGENT_BUNDLE_NAME}`,
    remotePath: remoteBundlePath,
    executable: false,
    forceRefresh: forceRefreshRuntimeAsset,
  });
  await options.installer.installFile({
    componentId,
    sourceRelativePath: `${runtime.bundledResourceDir}/${options.platformArch}/omp/omp`,
    remotePath: remoteOmpBinaryPath,
    executable: true,
    forceRefresh: forceRefreshRuntimeAsset,
  });
  // resolver 期望的入口仍为 zcode-agent；wrapper 执行 omp 适配器。
  await deployRemoteAgentWrapper({
    backend,
    content: buildRemoteAgentBundleWrapper(runtime.bundledResourceDir),
    remoteWrapperPath: remoteBinaryPath,
  });

  const versionStream = await backend.exec(
    buildWriteLiteralFileCommand(remoteVersionFile, runtime.version),
  );
  await waitForClose(versionStream);
  if (expectedArtifactSha256) {
    // GLM 的语义版本可能不变但制品内容已更新，必须把 manifest SHA
    // 写入远端 live marker，下一次连接才能按真实制品身份决定是否重部署。
    await writeRemoteAssetComponentMeta(backend, {
      id: componentId,
      version: runtime.version,
      sha256: expectedArtifactSha256,
      platformArch: options.platformArch,
    });
  }
  loggers.log(`[zcode-agent-deploy] ${provider}: 部署完成 v${runtime.version}`);
}
