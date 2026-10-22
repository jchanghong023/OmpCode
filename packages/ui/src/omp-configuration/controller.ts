import {
  ompSaveReceiptSchema,
  type OmpModelRef,
  type OmpRoleDescriptor,
  type OmpRoleSelection,
  type OmpSaveReceipt,
  type OmpTeamConfig,
  type OmpTeamModels,
  type ZCodeSessionConfigureParams,
  type ZCodeSessionConfigureResult,
} from "@zcode/shared";
import type { OmpConfigurationService, OmpConfigurationTarget } from "./contract.js";

export type TeamDraftMember = OmpModelRef | { rawSelector: string };
/** Local messages are resolved by the view; backend messages remain opaque data. */
export type OmpConfigurationMessage =
  | string
  | {
      id:
        | "omp.configuration.profileChanged"
        | "omp.configuration.unresolvedSlots"
        | "omp.configuration.savedEffective"
        | "omp.configuration.savedOverridden"
        | "omp.configuration.saveIncomplete"
        | "omp.configuration.roleSaved"
        | "omp.configuration.temporaryModelSwitched"
        | "omp.configuration.connectionChanged";
      values?: Record<string, string | number>;
    };
interface RoleDraft {
  selection: OmpRoleSelection;
  expectedRevision: string;
}
export interface OmpConfigurationState {
  team: OmpTeamConfig | null;
  roles: OmpRoleDescriptor[];
  models: OmpTeamModels["models"];
  modelSearch: { query: string; models: OmpTeamModels["models"] } | null;
  members: TeamDraftMember[] | null | undefined;
  expectedRevision: string | null;
  clientRevision: string;
  preview: NonNullable<OmpTeamConfig["preview"]> | null;
  roleDrafts: Record<string, RoleDraft>;
  dirty: boolean;
  externalChange: boolean;
  busy: boolean;
  supported: boolean | null;
  error: OmpConfigurationMessage | null;
  errorCode: string | null;
  notice: OmpConfigurationMessage | null;
  receipt: OmpSaveReceipt | null;
  requiresReadback: boolean;
}
function errorDetails(error: unknown): {
  message: string;
  code?: unknown;
  data?: unknown;
  errorCode?: string;
} {
  if (typeof error === "object" && error !== null) {
    const value = error as { message?: unknown; code?: unknown; data?: unknown };
    const data =
      typeof value.data === "object" && value.data !== null
        ? (value.data as Record<string, unknown>)
        : {};
    return {
      message: typeof value.message === "string" ? value.message : String(error),
      code: value.code,
      data: value.data,
      ...(typeof data.errorCode === "string" ? { errorCode: data.errorCode } : {}),
    };
  }
  return { message: String(error) };
}

/** One controller per mounted target. No accepted/persisted truth is owned here. */
export class OmpConfigurationController {
  readonly #service: OmpConfigurationService;
  readonly #target: OmpConfigurationTarget;
  readonly #onTemporaryModelSelected?: (model: OmpModelRef) => void;
  readonly #listeners = new Set<() => void>();
  readonly #requestedRoleIds = new Set<string>();
  #disposed = false;
  #generation = 0;
  #readSequence = 0;
  #searchSequence = 0;
  #draftSequence = 0;
  #state: OmpConfigurationState = {
    team: null,
    roles: [],
    models: [],
    modelSearch: null,
    members: undefined,
    expectedRevision: null,
    clientRevision: "draft-0",
    preview: null,
    roleDrafts: {},
    dirty: false,
    externalChange: false,
    busy: false,
    supported: null,
    error: null,
    errorCode: null,
    notice: null,
    receipt: null,
    requiresReadback: false,
  };
  constructor(
    service: OmpConfigurationService,
    target: OmpConfigurationTarget,
    onTemporaryModelSelected?: (model: OmpModelRef) => void,
  ) {
    this.#service = service;
    this.#target = target;
    this.#onTemporaryModelSelected = onTemporaryModelSelected;
  }
  getSnapshot = (): OmpConfigurationState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #patch(patch: Partial<OmpConfigurationState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #request(params: ZCodeSessionConfigureParams): Promise<ZCodeSessionConfigureResult> {
    return this.#service.configureOmpSession({ ...this.#target, ...params });
  }
  #current(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }
  #applyTeam(team: OmpTeamConfig): void {
    if (this.#state.team && team.profile !== this.#state.team.profile) {
      // An attachment/profile change invalidates drafts instead of transplanting them.
      this.#generation++;
      this.#patch({
        error: { id: "omp.configuration.profileChanged" },
        requiresReadback: true,
        busy: false,
        preview: null,
        modelSearch: null,
      });
      return;
    }
    const preserve = this.#state.dirty;
    this.#patch({
      team,
      supported: true,
      externalChange: preserve && this.#state.expectedRevision !== team.revision,
      ...(preserve
        ? {}
        : {
            members:
              team.userMembers?.map((slot) =>
                slot.status === "available" && slot.model
                  ? slot.model
                  : { rawSelector: slot.rawSelector },
              ) ?? team.userMembers,
            expectedRevision: team.revision,
          }),
    });
  }
  async refresh(): Promise<void> {
    const generation = this.#generation;
    const sequence = ++this.#readSequence;
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "get_team_config",
      });
      if (
        !this.#current(generation) ||
        sequence !== this.#readSequence ||
        result.operation !== "get_team_config"
      )
        return;
      this.#applyTeam(result.data);
      if (!this.#current(generation)) return;
      const [roles, models] = await Promise.all([
        this.#request({ sessionId: this.#target.sessionId, operation: "get_model_roles" }),
        this.#request({ sessionId: this.#target.sessionId, operation: "get_team_models" }),
      ]);
      if (!this.#current(generation) || sequence !== this.#readSequence) return;
      if (roles.operation === "get_model_roles") {
        const present = new Set(roles.data.roles.map((role) => role.roleId));
        // 自定义 role 可能不在目录中，必须定向重读，不能沿用旧事实。
        const missing = new Set([
          ...this.#requestedRoleIds,
          ...Object.keys(this.#state.roleDrafts),
        ]);
        const additional = await Promise.all(
          [...missing].filter((roleId) => !present.has(roleId)).map((roleId) =>
            this.#request({
              sessionId: this.#target.sessionId,
              operation: "get_model_roles",
              roleId,
            }),
          ),
        );
        if (!this.#current(generation) || sequence !== this.#readSequence) return;
        for (const result of additional) {
          if (result.operation !== "get_model_roles") continue;
          for (const role of result.data.roles) {
            if (present.has(role.roleId)) continue;
            present.add(role.roleId);
            roles.data.roles.push(role);
          }
        }
      }
      this.#patch({
        requiresReadback: false,
        ...(roles.operation === "get_model_roles"
          ? {
              roles: roles.data.roles,
              externalChange:
                this.#state.externalChange ||
                roles.data.roles.some((role) => {
                  const draft = this.#state.roleDrafts[role.roleId];
                  return draft !== undefined && draft.expectedRevision !== role.revision;
                }),
            }
          : {}),
        ...(models.operation === "get_team_models" ? { models: models.data.models } : {}),
      });
    } catch (error) {
      if (!this.#current(generation) || sequence !== this.#readSequence) return;
      const details = errorDetails(error);
      this.#patch({
        error: details.message,
        ...(details.code === -32601 ? { supported: false } : {}),
      });
    }
  }
  async searchModels(query: string): Promise<void> {
    const generation = this.#generation;
    const sequence = ++this.#searchSequence;
    if (!query) {
      this.#patch({ modelSearch: null });
      return;
    }
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "get_team_models",
        query,
      });
      if (
        !this.#current(generation) ||
        sequence !== this.#searchSequence ||
        result.operation !== "get_team_models"
      )
        return;
      // 搜索只投影匹配项，不覆盖成员和默认模型使用的完整目录。
      this.#patch({ modelSearch: { query, models: result.data.models } });
    } catch (error) {
      if (this.#current(generation) && sequence === this.#searchSequence)
        this.#patch({ modelSearch: null, error: errorDetails(error).message });
    }
  }
  setMembers(members: TeamDraftMember[] | null): void {
    this.#patch({
      members,
      dirty: true,
      preview: null,
      clientRevision: `draft-${++this.#draftSequence}`,
      notice: null,
    });
  }
  setRole(role: OmpRoleDescriptor, selection: OmpRoleSelection): void {
    this.#patch({
      roleDrafts: {
        ...this.#state.roleDrafts,
        [role.roleId]: {
          selection,
          expectedRevision: this.#state.roleDrafts[role.roleId]?.expectedRevision ?? role.revision,
        },
      },
      notice: null,
    });
  }
  async preview(): Promise<void> {
    const generation = this.#generation;
    const { clientRevision, members } = this.#state;
    if (members === undefined) return;
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "get_team_config",
        preview: { clientRevision, members },
      });
      if (
        !this.#current(generation) ||
        this.#state.clientRevision !== clientRevision ||
        result.operation !== "get_team_config" ||
        result.data.preview?.clientRevision !== clientRevision
      )
        return;
      if (this.#state.team && result.data.profile !== this.#state.team.profile) {
        this.invalidate();
        return;
      }
      this.#patch({ preview: result.data.preview });
    } catch (error) {
      if (this.#current(generation) && this.#state.clientRevision === clientRevision)
        this.#patch({ error: errorDetails(error).message });
    }
  }
  async saveTeam(): Promise<void> {
    const { members, expectedRevision, busy, requiresReadback } = this.#state;
    if (
      members === undefined ||
      busy ||
      requiresReadback ||
      !expectedRevision ||
      !this.#state.team?.writableScopes.includes("user")
    )
      return;
    if (members?.some((member) => "rawSelector" in member)) {
      this.#patch({ error: { id: "omp.configuration.unresolvedSlots" } });
      return;
    }
    const generation = this.#generation;
    const revision = this.#state.clientRevision;
    // 保存前的读取不得解除失败门禁；保存期间的读取也须在结果后失效。
    this.#readSequence++;
    this.#patch({ busy: true, error: null, receipt: null });
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "set_team_config",
        scope: "user",
        expectedRevision,
        members: members as OmpModelRef[] | null,
      });
      if (!this.#current(generation) || result.operation !== "set_team_config") return;
      const complete = result.data.saveState === "complete";
      this.#patch({
        receipt: result.data,
        dirty: complete && revision === this.#state.clientRevision ? false : this.#state.dirty,
        requiresReadback: !complete,
        notice: complete
          ? (result.data.effectiveNote ?? {
              id: result.data.effectiveMatchesRequested
                ? "omp.configuration.savedEffective"
                : "omp.configuration.savedOverridden",
            })
          : { id: "omp.configuration.saveIncomplete" },
      });
      this.#applyTeam(result.data.config);
    } catch (error) {
      if (!this.#current(generation)) return;
      const details = errorDetails(error);
      // Protocol errors may carry a machine errorCode alongside the actual receipt.
      const raw =
        typeof details.data === "object" && details.data !== null
          ? (details.data as Record<string, unknown>)
          : {};
      const { errorCode: _errorCode, ...receiptData } = raw;
      const receipt = ompSaveReceiptSchema.safeParse(receiptData);
      const known = receipt.success ? receipt.data : null;
      this.#patch({
        error: details.message,
        errorCode: details.errorCode ?? null,
        requiresReadback: true,
        receipt:
          known ??
          (details.errorCode
            ? {
                saveState: "failed",
                writes: {
                  active: { status: "not_attempted" },
                  persistent: { status: "not_attempted" },
                },
              }
            : {
                saveState: "unknown",
                writes: { active: { status: "unknown" }, persistent: { status: "unknown" } },
              }),
      });
      if (known?.config) this.#applyTeam(known.config);
    } finally {
      if (this.#current(generation)) {
        this.#readSequence++;
        this.#patch({ busy: false });
      }
    }
  }
  async saveRole(roleId: string): Promise<void> {
    const draft = this.#state.roleDrafts[roleId];
    if (!draft || this.#state.busy || this.#state.requiresReadback) return;
    const generation = this.#generation;
    this.#readSequence++;
    this.#patch({ busy: true, error: null });
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "set_model_role",
        roleId,
        scope: "user",
        ...draft,
      });
      if (!this.#current(generation) || result.operation !== "set_model_role") return;
      const roleDrafts = { ...this.#state.roleDrafts };
      if (roleDrafts[roleId] === draft) delete roleDrafts[roleId];
      this.#patch({
        roles: this.#state.roles.map((role) => (role.roleId === roleId ? result.data.role : role)),
        roleDrafts,
        notice: result.data.effectiveNote ?? {
          id: "omp.configuration.roleSaved",
          values: { roleId },
        },
      });
    } catch (error) {
      if (this.#current(generation)) {
        const details = errorDetails(error);
        this.#patch({
          error: details.message,
          errorCode: details.errorCode ?? null,
          requiresReadback: true,
        });
      }
    } finally {
      if (this.#current(generation)) {
        this.#readSequence++;
        this.#patch({ busy: false });
      }
    }
  }
  /** React StrictMode may reconnect an effect after cleanup on the same owner. */
  connect(): void {
    this.#disposed = false;
  }
  async switchTemporaryModel(model: OmpModelRef): Promise<void> {
    if (this.#state.busy) return;
    const generation = this.#generation;
    this.#patch({ busy: true, error: null });
    try {
      await this.#service.setModel({
        ...this.#target,
        model: { providerId: model.provider, modelId: model.modelId },
        persistAsWorkspaceLastUsed: false,
      });
      if (!this.#current(generation)) return;
      this.#onTemporaryModelSelected?.(model);
      this.#patch({ notice: { id: "omp.configuration.temporaryModelSwitched" } });
      await this.refresh();
    } catch (error) {
      if (this.#current(generation)) this.#patch({ error: errorDetails(error).message });
    } finally {
      if (this.#current(generation)) this.#patch({ busy: false });
    }
  }
  async addRole(roleId: string): Promise<void> {
    const generation = this.#generation;
    try {
      const result = await this.#request({
        sessionId: this.#target.sessionId,
        operation: "get_model_roles",
        roleId,
      });
      if (!this.#current(generation) || result.operation !== "get_model_roles") return;
      this.#requestedRoleIds.add(roleId);
      const roles = new Map(this.#state.roles.map((role) => [role.roleId, role]));
      for (const role of result.data.roles) roles.set(role.roleId, role);
      this.#patch({ roles: [...roles.values()] });
    } catch (error) {
      if (this.#current(generation)) this.#patch({ error: errorDetails(error).message });
    }
  }
  /** After reviewing latest facts, explicitly rebase a retained draft, never replay. */
  rebase(): void {
    if (this.#state.requiresReadback) return;
    const roleDrafts = { ...this.#state.roleDrafts };
    for (const role of this.#state.roles) {
      const draft = roleDrafts[role.roleId];
      if (draft) {
        roleDrafts[role.roleId] = { ...draft, expectedRevision: role.revision };
      }
    }
    this.#patch({
      expectedRevision: this.#state.team?.revision ?? null,
      roleDrafts,
      externalChange: false,
      error: null,
    });
  }
  invalidate(): void {
    this.#generation++;
    this.#readSequence++;
    this.#patch({
      requiresReadback: true,
      busy: false,
      preview: null,
      modelSearch: null,
      error: { id: "omp.configuration.connectionChanged" },
    });
  }
  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#listeners.clear();
  }
}
