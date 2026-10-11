import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { diagnostics } from "./diagnostics.js";

// 修复：新增日志使命令服务超过架构行数上限；只拆出诊断格式，幂等与决策仍由服务持有。
export function envelopeRejected(issueCount: number): void {
  diagnostics.warn("omp.command.rejected", {
    failureStage: "envelope_parse",
    code: -32602,
    issueCount,
  });
}

export function deduplicated(envelope: CommandEnvelope, cached?: CommandAck): void {
  const fields: Record<string, unknown> = {
    commandType: envelope.type,
    commandId: envelope.commandId,
    sessionId: envelope.sessionId,
    source: cached ? "idempotency_cache" : "in_flight",
  };
  if (cached) {
    fields.status = cached.status;
    if (cached.reasonCode) fields.reasonCode = cached.reasonCode;
  }
  diagnostics.debug("omp.command.deduplicated", fields);
}

export function received(envelope: CommandEnvelope): void {
  diagnostics.info("omp.command.received", {
    commandType: envelope.type,
    commandId: envelope.commandId,
    sessionId: envelope.sessionId,
  });
}

export function acknowledged(
  envelope: CommandEnvelope,
  status: CommandAck["status"],
  ack: CommandAck,
): void {
  diagnostics[
    status === "rejected" || status === "stale" ? "warn" : status === "accepted" ? "info" : "debug"
  ]("omp.command.ack", {
    commandType: envelope.type,
    commandId: envelope.commandId,
    sessionId: envelope.sessionId,
    status,
    ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
  });
}
