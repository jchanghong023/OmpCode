import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OmpGoalAction, OmpOrchestrationCommandResult } from "./ompOrchestrationCommands.js";

const GOAL_ACTIONS: readonly { value: OmpGoalAction; label: string }[] = [
  { value: "set", label: "ompOrchestration.goalSet" },
  { value: "show", label: "ompOrchestration.goalShow" },
  { value: "pause", label: "ompOrchestration.goalPause" },
  { value: "resume", label: "ompOrchestration.goalResume" },
  { value: "drop", label: "ompOrchestration.goalDrop" },
  { value: "budget", label: "ompOrchestration.goalBudget" },
];

type GoalFieldsProps = {
  id: string;
  disabled: boolean;
  preview: OmpOrchestrationCommandResult;
  action: OmpGoalAction;
  objective: string;
  budget: string;
  onActionChange: (action: OmpGoalAction) => void;
  onObjectiveChange: (objective: string) => void;
  onBudgetChange: (budget: string) => void;
};

export function OmpGoalFields({
  id,
  disabled,
  preview,
  action,
  objective,
  budget,
  onActionChange,
  onObjectiveChange,
  onBudgetChange,
}: GoalFieldsProps) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "ompOrchestration.goalHelp" })}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-goal-action`}>
          {intl.formatMessage({ id: "ompOrchestration.goalAction" })}
        </Label>
        <Select
          value={action}
          disabled={disabled}
          onValueChange={(value) => {
            const next = GOAL_ACTIONS.find((entry) => entry.value === value);
            if (next) onActionChange(next.value);
          }}
        >
          <SelectTrigger id={`${id}-goal-action`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GOAL_ACTIONS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {intl.formatMessage({ id: entry.label })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {action === "set" ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-objective`}>
            {intl.formatMessage({ id: "ompOrchestration.objective" })}
          </Label>
          <Textarea
            id={`${id}-objective`}
            value={objective}
            disabled={disabled}
            required
            onChange={(event) => onObjectiveChange(event.target.value)}
          />
        </div>
      ) : null}
      {action === "budget" ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-budget`}>
            {intl.formatMessage({ id: "ompOrchestration.budget" })}
          </Label>
          <Input
            id={`${id}-budget`}
            value={budget}
            disabled={disabled}
            required
            aria-invalid={!preview.ok}
            onChange={(event) => onBudgetChange(event.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}

type LoopFieldsProps = {
  id: string;
  disabled: boolean;
  preview: OmpOrchestrationCommandResult;
  action: "start" | "stop";
  kind: "count" | "duration";
  limit: string;
  interval: string;
  onActionChange: (action: "start" | "stop") => void;
  onKindChange: (kind: "count" | "duration") => void;
  onLimitChange: (limit: string) => void;
  onIntervalChange: (interval: string) => void;
};

export function OmpLoopFields({
  id,
  disabled,
  preview,
  action,
  kind,
  limit,
  interval,
  onActionChange,
  onKindChange,
  onLimitChange,
  onIntervalChange,
}: LoopFieldsProps) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "ompOrchestration.loopHelp" })}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-loop-action`}>
          {intl.formatMessage({ id: "ompOrchestration.loopAction" })}
        </Label>
        <Select
          value={action}
          disabled={disabled}
          onValueChange={(value) => onActionChange(value === "stop" ? "stop" : "start")}
        >
          <SelectTrigger id={`${id}-loop-action`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="start">
              {intl.formatMessage({ id: "ompOrchestration.loopStart" })}
            </SelectItem>
            <SelectItem value="stop">
              {intl.formatMessage({ id: "ompOrchestration.loopStop" })}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {action === "start" ? (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${id}-loop-kind`}>
              {intl.formatMessage({ id: "ompOrchestration.loopKind" })}
            </Label>
            <Select
              value={kind}
              disabled={disabled}
              onValueChange={(value) => onKindChange(value === "duration" ? "duration" : "count")}
            >
              <SelectTrigger id={`${id}-loop-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="count">
                  {intl.formatMessage({ id: "ompOrchestration.loopCount" })}
                </SelectItem>
                <SelectItem value="duration">
                  {intl.formatMessage({ id: "ompOrchestration.loopDuration" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-limit`}>
              {intl.formatMessage({ id: "ompOrchestration.loopLimit" })}
            </Label>
            <Input
              id={`${id}-limit`}
              value={limit}
              disabled={disabled}
              required
              aria-invalid={
                !preview.ok && (preview.error === "count" || preview.error === "duration")
              }
              onChange={(event) => onLimitChange(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-interval`}>
              {intl.formatMessage({ id: "ompOrchestration.loopInterval" })}
            </Label>
            <Input
              id={`${id}-interval`}
              value={interval}
              disabled={disabled}
              aria-invalid={!preview.ok && preview.error === "interval"}
              onChange={(event) => onIntervalChange(event.target.value)}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
