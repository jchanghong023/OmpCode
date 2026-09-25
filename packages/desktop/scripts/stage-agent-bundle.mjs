// 兼容旧导入路径；实际 omp 资产布局由 Fork 自有模块维护。
export {
  AGENT_BUNDLE_SOURCE_RELATIVE,
  AGENT_BUNDLE_ENTRY,
  resolveAgentBundlePaths,
  stageAgentBundle,
} from "./stage-omp-agent-bundle.mjs";
