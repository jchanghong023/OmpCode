import {
  interactionEntryFromEvent,
  interactionObject,
  type InteractionSource,
} from "./OmpAgentInteractionRecords.js";

/** 会话引擎拥有的轻量 live 观察；普通对话不进入该读面，不额外落盘。 */
export class OmpAgentInteractionLog {
  private readonly records = new Map<string, unknown[]>();
  private readonly stableRecords = new Map<string, Set<string>>();
  private count = 0;
  truncated = false;
  revision = 0;

  ingest(agentId: string, event: unknown): void {
    const entry = interactionEntryFromEvent(event);
    if (!entry) return;
    const record = interactionObject(entry);
    const message = interactionObject(record?.message);
    const details = interactionObject(message?.details);
    const messageId = typeof details?.id === "string" ? details.id : null;
    const key = messageId ? `message:${messageId}` : null;
    let keys = this.stableRecords.get(agentId);
    if (!keys) {
      keys = new Set();
      this.stableRecords.set(agentId, keys);
    }
    if (key && keys.has(key)) return;
    if (this.count >= 20_000) {
      if (!this.truncated) this.revision += 1;
      this.truncated = true;
      return;
    }
    if (key) keys.add(key);
    let entries = this.records.get(agentId);
    if (!entries) {
      entries = [];
      this.records.set(agentId, entries);
    }
    entries.push(entry);
    this.count += 1;
    this.revision += 1;
  }

  sources(): InteractionSource[] {
    return [...this.records].map(([agentId, entries]) => ({
      agentId,
      entries: entries.slice(),
      key: `live:${agentId}`,
      source: "live" as const,
    }));
  }
}
