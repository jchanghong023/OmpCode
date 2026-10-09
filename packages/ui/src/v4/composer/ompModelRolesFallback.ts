// omp 模型角色对话框的纯判定逻辑（omp-project-mode.md / 协议 §8.3）。
// 1) 回落判定：只有 OMP 旧核永久缺失项目模式（-32601，错误消息特征
//    "not supported by omp core"，与 useOmpCommandCompletion 同判据）才允许回落
//    主进程直写用户 omp config.yml；rpc 未就绪（agent 启动中/远端等待）与
//    -32000（项目进程暂时不可用、崩溃退避窗，可重试）一律不回落——避免绕过 omp
//    的 role 校验/修订直写用户配置，与 omp 自身 flush 并发写造成丢更新。
// 2) 被覆盖判定：user scope 保存成功但生效值来源是更高优先级覆盖层时提示
//    「用户配置已保存，但当前被覆盖」（omp rpc-project-models #effectiveNote 把
//    runtime 列为覆盖层；global/default 表示 user 配置本身就是生效来源）。

/** -32601（旧核永久缺失）在 UI 侧的错误消息特征；与 useOmpCommandCompletion 保持一致。 */
const OMP_CAPABILITY_MISSING_MARKER = "not supported by omp core";

export function isOmpCapabilityMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(OMP_CAPABILITY_MISSING_MARKER);
}

/** 角色 RPC 目录加载结论：loaded=RPC 成功；fallback=旧核永久缺失可回落；unavailable=暂时不可用。 */
export type OmpRolesLoadOutcome = "loaded" | "fallback" | "unavailable";

export function resolveOmpRolesLoadOutcome(params: {
  rpcReady: boolean;
  error: unknown;
}): OmpRolesLoadOutcome {
  // rpcReady=false（远端会话未注册等等待态）与 -32000 都是可恢复状态：不回落，
  // 由调用方停留错误态并提供重试入口。
  if (!params.rpcReady) return "unavailable";
  return isOmpCapabilityMissingError(params.error) ? "fallback" : "unavailable";
}

/** 保存失败分类：capabilityMissing=旧核永久缺失（唯一允许转本地回落保存的类别）。 */
export type OmpRoleSaveFailureKind = "capabilityMissing" | "unavailable";

export function classifyOmpRoleSaveFailure(error: unknown): OmpRoleSaveFailureKind {
  return isOmpCapabilityMissingError(error) ? "capabilityMissing" : "unavailable";
}

/**
 * 被覆盖判定（S8-4）：显式用户配置已持久化（explicitValue 存在）但当前生效值
 * 来源是覆盖层时为真。runtime 是覆盖层（omp rpc-project-models #effectiveNote），
 * 覆盖时必须提示「已保存但被覆盖」，不得静默显示「已保存」；global/default 表示
 * user 配置即生效来源，不算被覆盖；其余未知来源按被覆盖处理（fail-visible）。
 */
export function isOmpRoleOverridden(role: { explicitValue?: string; source?: string }): boolean {
  return (
    role.explicitValue !== undefined &&
    role.source !== undefined &&
    role.source !== "global" &&
    role.source !== "default"
  );
}

/** §8.3：保存成功后透传 omp 返回的实际生效说明（effectiveNote）；空缺/空串归一为 null。 */
export function ompRoleEffectiveNote(
  result: { effectiveNote?: string } | null | undefined,
): string | null {
  return typeof result?.effectiveNote === "string" && result.effectiveNote.length > 0
    ? result.effectiveNote
    : null;
}
