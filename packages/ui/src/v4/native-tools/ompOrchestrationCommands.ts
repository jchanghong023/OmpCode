import type { ZCodeSlashCommand } from "@zcode/shared";

const OMP_ORCHESTRATION_COMMANDS = [
  "goal",
  "loop",
  "team",
  "orchestrate",
  "workflowz",
  "fullsend",
] as const;
export type OmpOrchestrationCommand = (typeof OMP_ORCHESTRATION_COMMANDS)[number];
export type OmpGoalAction = "set" | "show" | "pause" | "resume" | "drop" | "budget";
export type OmpOrchestrationRequest =
  | { command: "goal"; action: OmpGoalAction; objective?: string; budget?: string }
  | { command: "loop"; action: "stop" }
  | {
      command: "loop";
      action: "start";
      kind: "count" | "duration";
      limit: string;
      interval: string;
      task: string;
    }
  | { command: "team" | "orchestrate" | "workflowz" | "fullsend"; task: string };
type OmpOrchestrationValidationError =
  | "required"
  | "budget"
  | "count"
  | "duration"
  | "interval"
  | "loopTask";
export type OmpOrchestrationCommandResult =
  | { ok: true; text: string; confirmation: "drop" | "loop" | null }
  | { ok: false; error: OmpOrchestrationValidationError };

const TIME_UNITS_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};
const MAX_INTERVAL_MS = 2_147_483_647;

/** 候选只描述本面板支持的表单，执行能力始终与当前目录求交。 */
export function getOmpOrchestrationCapabilities(commands: readonly ZCodeSlashCommand[]) {
  const names = new Set(
    commands.map((entry) => entry.name.trim().replace(/^\/+/, "").toLowerCase()),
  );
  return {
    available: OMP_ORCHESTRATION_COMMANDS.filter((name) => names.has(name)),
    missing: OMP_ORCHESTRATION_COMMANDS.filter((name) => !names.has(name)),
  };
}

function positiveInteger(text: string): boolean {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0;
}

function compactDurationSegments(text: string): RegExpExecArray[] | null {
  if (!/^(?:\d+[a-z]+)+$/i.test(text)) return null;
  return Array.from(text.toLowerCase().matchAll(/(\d+)([a-z]+)/g));
}

function durationMs(text: string, allowSpacedUnit: boolean): number | null {
  if (allowSpacedUnit) {
    const spaced = /^(\d+)\s+([a-z]+)$/i.exec(text);
    if (spaced) {
      const unitName = (spaced[2] ?? "").toLowerCase();
      const unit = Object.hasOwn(TIME_UNITS_MS, unitName) ? TIME_UNITS_MS[unitName] : undefined;
      return positiveInteger(spaced[1] ?? "") && unit !== undefined
        ? Number(spaced[1]) * unit
        : null;
    }
  }
  const segments = compactDurationSegments(text);
  if (!segments) return null;
  let total = 0;
  for (const segment of segments) {
    const unitName = segment[2] ?? "";
    const unit = Object.hasOwn(TIME_UNITS_MS, unitName) ? TIME_UNITS_MS[unitName] : undefined;
    if (unit === undefined || !positiveInteger(segment[1] ?? "")) return null;
    total += Number(segment[1]) * unit;
  }
  return total > 0 ? total : null;
}

/** 原生 parser 会吞掉这些正文前缀；不能把“预览任务”悄悄变成 interval/condition。 */
function hasAmbiguousLoopTask(
  task: string,
  kind: "count" | "duration",
  hasInterval: boolean,
): boolean {
  if (task.startsWith("--")) return true;
  if (hasInterval) return false;
  const firstToken = (task.split(/\s+/, 1)[0] ?? "").toLowerCase();
  if (kind === "count" && Object.hasOwn(TIME_UNITS_MS, firstToken)) return true;
  const segments = compactDurationSegments(firstToken);
  return (
    segments !== null && segments.every((segment) => Object.hasOwn(TIME_UNITS_MS, segment[2] ?? ""))
  );
}

/** 仅生成已验证的原生语法，不维护 Goal/Loop/Team 运行状态。 */
export function buildOmpOrchestrationCommand(
  request: OmpOrchestrationRequest,
): OmpOrchestrationCommandResult {
  if (request.command === "goal") {
    if (request.action === "set") {
      const objective = request.objective?.trim();
      return objective
        ? { ok: true, text: `/goal set ${objective}`, confirmation: null }
        : { ok: false, error: "required" };
    }
    if (request.action === "budget") {
      const budget = request.budget?.trim() ?? "";
      if (budget.toLowerCase() !== "off" && !positiveInteger(budget))
        return { ok: false, error: "budget" };
      return { ok: true, text: `/goal budget ${budget.toLowerCase()}`, confirmation: null };
    }
    return {
      ok: true,
      text: `/goal ${request.action}`,
      confirmation: request.action === "drop" ? "drop" : null,
    };
  }
  if (request.command === "loop") {
    if (request.action === "stop") return { ok: true, text: "/loop", confirmation: "loop" };
    const limit = request.limit.trim();
    const interval = request.interval.trim();
    const task = request.task.trim();
    if (request.kind === "count" ? !positiveInteger(limit) : durationMs(limit, true) === null) {
      return { ok: false, error: request.kind === "count" ? "count" : "duration" };
    }
    if (interval) {
      const milliseconds = durationMs(interval, false);
      if (
        milliseconds === null ||
        !Number.isSafeInteger(milliseconds) ||
        milliseconds > MAX_INTERVAL_MS
      ) {
        return { ok: false, error: "interval" };
      }
    }
    if (!task) return { ok: false, error: "required" };
    if (hasAmbiguousLoopTask(task, request.kind, Boolean(interval)))
      return { ok: false, error: "loopTask" };
    return {
      ok: true,
      text: `/loop ${limit}${interval ? ` ${interval}` : ""} ${task}`,
      confirmation: null,
    };
  }
  const task = request.task.trim();
  return task
    ? { ok: true, text: `/${request.command} ${task}`, confirmation: null }
    : { ok: false, error: "required" };
}
