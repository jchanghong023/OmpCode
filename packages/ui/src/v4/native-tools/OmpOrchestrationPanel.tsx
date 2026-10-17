import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
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
import { logger } from "@/logger.js";
import type { OmpNativeToolsPanelProps } from "./OmpNativeToolsDialog.js";
import { OmpGoalFields, OmpLoopFields } from "./OmpOrchestrationFields.js";
import {
  buildOmpOrchestrationCommand,
  getOmpOrchestrationCapabilities,
  type OmpGoalAction,
  type OmpOrchestrationCommand,
  type OmpOrchestrationRequest,
} from "./ompOrchestrationCommands.js";

/** 表单只拥有参数草稿；命令准入与原生运行状态由当前会话持有。 */
export function OmpOrchestrationPanel({ commands, disabled, onExecute }: OmpNativeToolsPanelProps) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const [selectedCommand, setSelectedCommand] = useState<OmpOrchestrationCommand>("goal");
  const [goalAction, setGoalAction] = useState<OmpGoalAction>("set");
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [loopAction, setLoopAction] = useState<"start" | "stop">("start");
  const [loopKind, setLoopKind] = useState<"count" | "duration">("count");
  const [limit, setLimit] = useState("");
  const [interval, setInterval] = useState("");
  const [task, setTask] = useState("");
  const [confirmedText, setConfirmedText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<
    "sent" | "blocked" | "confirmationRequired" | "failed" | null
  >(null);
  const flight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { available, missing } = getOmpOrchestrationCapabilities(commands);
  const command = available.includes(selectedCommand) ? selectedCommand : (available[0] ?? "goal");
  const request: OmpOrchestrationRequest =
    command === "goal"
      ? { command, action: goalAction, objective, budget }
      : command === "loop"
        ? loopAction === "stop"
          ? { command, action: "stop" }
          : { command, action: "start", kind: loopKind, limit, interval, task }
        : { command, task };
  const preview = buildOmpOrchestrationCommand(request);
  const requiresConfirmation = preview.ok && preview.confirmation !== null;
  const canExecute =
    !disabled &&
    !pending &&
    available.includes(command) &&
    preview.ok &&
    (!requiresConfirmation || confirmedText === preview.text);
  const fieldsDisabled = disabled || pending || available.length === 0;

  async function execute() {
    // 同步 flight 防止 React 尚未提交 disabled 时双击；冻结文本，不读取随后编辑的草稿。
    if (flight.current || !canExecute || !preview.ok) return;
    const text = preview.text;
    flight.current = true;
    setPending(true);
    setFeedback(null);
    try {
      const outcome = await onExecute(text);
      if (alive.current) setFeedback(outcome);
    } catch (error) {
      logger.error("[omp-native-tools] 编排命令提交失败", {
        command,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      if (alive.current) setFeedback("failed");
    } finally {
      flight.current = false;
      if (alive.current) {
        setPending(false);
        setConfirmedText(null);
      }
    }
  }

  return (
    <form
      className="flex flex-col gap-3 text-ui-base"
      onSubmit={(event) => {
        event.preventDefault();
        void execute();
      }}
    >
      <div className="space-y-1">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "ompOrchestration.title" })}
        </h3>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "ompOrchestration.description" })}
        </p>
      </div>
      {missing.length > 0 ? (
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage(
            { id: "ompOrchestration.missing" },
            { commands: missing.map((name) => `/${name}`).join(", ") },
          )}
        </p>
      ) : null}
      {available.length === 0 ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "ompOrchestration.noCapabilities" })}
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${id}-command`}>
            {intl.formatMessage({ id: "ompOrchestration.command" })}
          </Label>
          <Select
            value={command}
            disabled={disabled || pending}
            onValueChange={(value) => {
              const next = available.find((name) => name === value);
              if (next) {
                setSelectedCommand(next);
                setConfirmedText(null);
                setFeedback(null);
              }
            }}
          >
            <SelectTrigger id={`${id}-command`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {available.map((name) => (
                <SelectItem key={name} value={name}>
                  /{name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {available.length > 0 && command === "goal" ? (
        <OmpGoalFields
          id={id}
          disabled={fieldsDisabled}
          preview={preview}
          action={goalAction}
          objective={objective}
          budget={budget}
          onActionChange={(action) => {
            setGoalAction(action);
            setConfirmedText(null);
            setFeedback(null);
          }}
          onObjectiveChange={setObjective}
          onBudgetChange={setBudget}
        />
      ) : null}
      {available.length > 0 && command === "loop" ? (
        <OmpLoopFields
          id={id}
          disabled={fieldsDisabled}
          preview={preview}
          action={loopAction}
          kind={loopKind}
          limit={limit}
          interval={interval}
          onActionChange={(action) => {
            setLoopAction(action);
            setConfirmedText(null);
            setFeedback(null);
          }}
          onKindChange={setLoopKind}
          onLimitChange={setLimit}
          onIntervalChange={setInterval}
        />
      ) : null}
      {available.length > 0 &&
      command !== "goal" &&
      (command !== "loop" || loopAction === "start") ? (
        <>
          {command !== "loop" ? (
            <p className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({
                id: command === "team" ? "ompOrchestration.teamHelp" : "ompOrchestration.magicHelp",
              })}
            </p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor={`${id}-task`}>
              {intl.formatMessage({ id: "ompOrchestration.task" })}
            </Label>
            <Textarea
              id={`${id}-task`}
              value={task}
              disabled={fieldsDisabled}
              required
              aria-invalid={
                !preview.ok && (preview.error === "required" || preview.error === "loopTask")
              }
              onChange={(event) => setTask(event.target.value)}
            />
          </div>
        </>
      ) : null}
      {available.length > 0 ? (
        <>
          <div className="space-y-1">
            <p
              id={`${id}-preview-label`}
              className="text-ui-caption font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: "ompOrchestration.preview" })}
            </p>
            {preview.ok ? (
              <pre
                aria-labelledby={`${id}-preview-label`}
                className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2 font-mono text-ui-base text-foreground"
              >
                {preview.text}
              </pre>
            ) : (
              <p className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "ompOrchestration.previewEmpty" })}
              </p>
            )}
          </div>
          {!preview.ok ? (
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: `ompOrchestration.invalid.${preview.error}` })}
            </p>
          ) : null}
          {preview.ok && preview.confirmation ? (
            <div className="flex items-start gap-2 rounded-md border border-border p-2">
              <Checkbox
                id={`${id}-confirm`}
                disabled={fieldsDisabled}
                checked={confirmedText === preview.text}
                onCheckedChange={(checked) =>
                  setConfirmedText(checked === true ? preview.text : null)
                }
              />
              <Label htmlFor={`${id}-confirm`} className="text-ui-caption leading-relaxed">
                {intl.formatMessage({
                  id:
                    preview.confirmation === "drop"
                      ? "ompOrchestration.confirmDrop"
                      : "ompOrchestration.confirmLoop",
                })}
              </Label>
            </div>
          ) : null}
          {disabled ? (
            <p role="status" className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "ompOrchestration.blocked" })}
            </p>
          ) : null}
          <Button type="submit" disabled={!canExecute} className="self-start">
            {intl.formatMessage({
              id: pending ? "ompOrchestration.submitting" : "ompOrchestration.execute",
            })}
          </Button>
        </>
      ) : null}
      {feedback ? (
        <p role="status" className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: `ompOrchestration.${feedback}` })}
        </p>
      ) : null}
    </form>
  );
}
