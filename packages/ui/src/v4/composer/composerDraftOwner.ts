import { createComposerDraftPersistence } from "./composerDraftPersistence.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  type V4ComposerDraft,
} from "./composerDraftStore.js";

export type ComposerContent = Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">;
export type ComposerContentReader = () => ComposerContent | null;
export interface ComposerDraftEvent {
  kind: "content" | "config" | "restore" | "migrate";
  draft: V4ComposerDraft;
  origin?: symbol;
}
export interface ComposerSubmissionReceipt {
  claim(): boolean;
  rollback(): boolean;
  hasNewerEdits(): boolean;
  complete(): void;
}
interface ReaderLease {
  reader?: ComposerContentReader;
  version: number;
}
let configNotificationRevision = 0;

/** renderer scope 的唯一事实源；pane 仅持 reader lease 和编辑器展示，不另建保存者。 */
export class ComposerDraftOwner {
  private value: V4ComposerDraft;
  private redirect: ComposerDraftOwner | null = null;
  private followers = new Set<ComposerDraftOwner>();
  private listeners = new Set<(event: ComposerDraftEvent) => void>();
  private readers = new Map<symbol, ReaderLease>();
  private activeReader: symbol | null = null;
  private contentVersion = 0;
  private userVersion = 0;
  private configVersion = ++configNotificationRevision;
  private receipts = 0;
  private activeClaim: symbol | null = null;
  private claimSnapshot: V4ComposerDraft | null = null;
  private claimUserVersion = -1;
  private preservedMigrationBackup: {
    workspacePath: string;
    workspaceIdentity?: string;
    scopeId: string;
  } | null = null;
  private target: { workspacePath: string; workspaceIdentity?: string; scopeId: string };
  private persistence: ReturnType<typeof createComposerDraftPersistence>;
  /** 兼容无 React 的隔离探针；生产使用有版本的 reader lease。 */
  contentReader: ComposerContentReader | null = null;
  onIdle?: () => void;

  constructor(options: {
    workspacePath: string;
    workspaceIdentity?: string;
    scopeId: string;
    draft: V4ComposerDraft;
  }) {
    this.target = options;
    this.value = options.draft;
    this.persistence = createComposerDraftPersistence({
      write: () => {
        this.materialize();
        return persistV4ComposerDraft(
          this.target.workspacePath,
          this.target.workspaceIdentity,
          this.target.scopeId,
          this.value,
        );
      },
    });
  }
  canonical(): ComposerDraftOwner {
    return this.redirect?.canonical() ?? this;
  }
  get draft() {
    return this.canonical().value;
  }
  set draft(draft: V4ComposerDraft) {
    this.canonical().value = draft;
  }
  get scopeId() {
    return this.canonical().target.scopeId;
  }
  get scopeKey() {
    const target = this.canonical().target;
    return JSON.stringify([
      target.workspaceIdentity?.trim() || target.workspacePath,
      target.scopeId,
    ]);
  }
  get hasUserEdits() {
    return this.canonical().userVersion > 0;
  }
  get leaseCount() {
    return this.canonical().readers.size;
  }
  private receiptCount(): number {
    return (
      this.receipts +
      [...this.followers].reduce((count, follower) => count + follower.receiptCount(), 0)
    );
  }
  get pendingCount() {
    return this.canonical().receiptCount();
  }
  getConfigRevision = () => this.canonical().configVersion;
  subscribe = (listener: (event: ComposerDraftEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  subscribeConfig = (listener: () => void) =>
    this.subscribe((event) => {
      if (event.kind !== "content") listener();
    });
  private notify(event: ComposerDraftEvent) {
    for (const listener of this.listeners) listener(event);
    for (const follower of this.followers) follower.notify(event);
  }
  private publish(kind: ComposerDraftEvent["kind"], origin?: symbol) {
    // owner 合并后两个局部计数可能相等；窗口内通知标记单调递增，redirect 必然换快照。
    if (kind !== "content") this.configVersion = ++configNotificationRevision;
    this.notify({ kind, draft: this.value, ...(origin ? { origin } : {}) });
  }
  acquireLease(id = Symbol("composer-reader")) {
    const core = this.canonical();
    if (!core.readers.has(id)) core.readers.set(id, { version: core.contentVersion });
    return id;
  }
  releaseLease(id: symbol) {
    const core = this.canonical();
    core.flush();
    core.readers.delete(id);
    if (core.activeReader === id) core.activeReader = null;
    core.checkIdle();
  }
  registerReader(id: symbol, reader: ComposerContentReader) {
    const core = this.canonical();
    core.acquireLease(id);
    const lease = core.readers.get(id)!;
    lease.reader = reader;
    if (core.activeReader === null) core.activeReader = id;
    return () => {
      const current = this.canonical();
      current.flush();
      const currentLease = current.readers.get(id);
      if (currentLease?.reader === reader) currentLease.reader = undefined;
    };
  }
  /** 只选最后实际编辑且版本仍匹配的 reader；新 pane 的旧初始化 JSON 不能覆盖它。 */
  materialize(): V4ComposerDraft {
    const core = this.canonical();
    if (core !== this) return core.materialize();
    const lease = this.activeReader ? this.readers.get(this.activeReader) : undefined;
    const content =
      lease?.version === this.contentVersion ? lease.reader?.() : this.contentReader?.();
    if (content && content.text === this.value.text) {
      this.value = {
        ...this.value,
        ...(content.editorStateJson ? { editorStateJson: content.editorStateJson } : {}),
      };
    }
    return this.value;
  }
  schedule = () => this.canonical().persistence.schedule();
  flush = () => this.canonical().persistence.flush();
  private checkIdle() {
    if (this.readers.size === 0 && this.receipts === 0) this.onIdle?.();
  }
  private markReader(id: symbol) {
    this.contentVersion++;
    this.userVersion++;
    const lease = this.readers.get(id);
    if (lease) lease.version = this.contentVersion;
    this.activeReader = lease ? id : null;
    this.value = { ...this.value, updatedAt: Date.now() };
  }
  updateContent(id: symbol, content: ComposerContent) {
    const core = this.canonical();
    if (
      core.value.text === content.text &&
      core.value.editorStateJson === content.editorStateJson &&
      core.value.mention === content.mention
    )
      return;
    core.value = { ...core.value, editorStateJson: undefined, mention: undefined, ...content };
    core.markReader(id);
    core.schedule();
    core.publish("content", id);
  }
  markDirty(id: symbol, text?: string, userEdit = true) {
    const core = this.canonical();
    if (userEdit) {
      if (text !== undefined && text !== core.value.text)
        core.value = { ...core.value, text, editorStateJson: undefined, mention: undefined };
      core.markReader(id);
      core.publish("content", id);
    } else {
      const lease = core.readers.get(id);
      if (!lease || lease.version !== core.contentVersion || core.activeReader !== id) return;
    }
    core.schedule();
  }
  updateConfig(update: (current: V4ComposerDraft) => V4ComposerDraft, expected?: V4ComposerDraft) {
    const core = this.canonical();
    if (expected && core.value !== expected) return;
    const next = update(core.value);
    if (next === core.value) return;
    core.value = next;
    core.schedule();
    core.publish("config");
  }
  captureSubmission(id: symbol, content: ComposerContent): ComposerSubmissionReceipt {
    const core = this.canonical();
    const snapshot = { ...core.value, ...content };
    const version = core.userVersion;
    const claimId = Symbol("composer-submission");
    let claimed = false;
    let settled = false;
    core.receipts++;
    const finish = () => {
      settled = true;
      core.receipts--;
      if (core.activeClaim === claimId) {
        core.activeClaim = null;
        core.claimSnapshot = null;
      }
      core.checkIdle();
    };
    return {
      hasNewerEdits: () => core !== this.canonical() || core.userVersion !== version,
      claim: () => {
        if (settled || claimed || core !== this.canonical() || core.userVersion !== version)
          return false;
        claimed = true;
        core.activeClaim = claimId;
        core.claimSnapshot = snapshot;
        core.claimUserVersion = version;
        core.value = { ...core.value, text: "", editorStateJson: undefined, mention: undefined };
        core.contentVersion++;
        core.activeReader = null;
        core.schedule();
        core.publish("content", id);
        core.flush();
        return true;
      },
      rollback: () => {
        if (settled) return false;
        const restore =
          claimed &&
          core === this.canonical() &&
          core.userVersion === version &&
          core.activeClaim === claimId;
        // receipt 是跨 scope 恢复的唯一许可；普通旧编辑器 callback 的 guard 不放宽。
        if (restore) {
          core.value = {
            ...core.value,
            text: snapshot.text,
            editorStateJson: snapshot.editorStateJson,
            mention: snapshot.mention,
          };
          core.contentVersion++;
          core.activeReader = null;
          core.schedule();
          core.publish("restore");
          core.flush();
        }
        finish();
        return restore;
      },
      complete: () => {
        if (settled) return;
        if (claimed && core.userVersion === version && core.preservedMigrationBackup) {
          const address = core.preservedMigrationBackup;
          const backup = readV4ComposerDraft(
            address.workspacePath,
            address.workspaceIdentity,
            address.scopeId,
          );
          if (
            backup?.text === snapshot.text &&
            backup.editorStateJson === snapshot.editorStateJson
          ) {
            clearV4ComposerDraft(address.workspacePath, address.workspaceIdentity, address.scopeId);
          }
        }
        finish();
      },
    };
  }
  preserveMigrationBackup() {
    this.canonical().preservedMigrationBackup = { ...this.canonical().target };
  }
  migrationDraft(preferTarget: boolean) {
    const core = this.canonical();
    core.materialize();
    // 目标已有新编辑时，claim 的空正文不能代替来源提交备份；旧失败仍需保留来源数据。
    return preferTarget &&
      core.claimSnapshot &&
      core.userVersion === core.claimUserVersion &&
      !core.value.text
      ? {
          ...core.value,
          text: core.claimSnapshot.text,
          editorStateJson: core.claimSnapshot.editorStateJson,
          mention: core.claimSnapshot.mention,
        }
      : core.value;
  }
  retarget(scopeId: string, draft: V4ComposerDraft, replaceContent = false) {
    // Storage 已在一次原子迁移中写入最新值，不能再把旧 timer 落回来源 key。
    this.persistence.cancel();
    this.target = { ...this.target, scopeId };
    this.value = draft;
    if (replaceContent) {
      this.userVersion++;
      this.contentVersion++;
      this.activeReader = null;
    }
    this.publish("migrate");
  }
  redirectTo(target: ComposerDraftOwner) {
    const source = this.canonical();
    const destination = target.canonical();
    if (source === destination) return;
    source.persistence.cancel();
    for (const [id, lease] of source.readers)
      destination.readers.set(id, { ...lease, version: -1 });
    source.readers.clear();
    source.redirect = destination;
    destination.followers.add(source);
    destination.publish("migrate");
  }
}

export function createComposerDraftOwner(
  options: ConstructorParameters<typeof ComposerDraftOwner>[0],
) {
  return new ComposerDraftOwner(options);
}
