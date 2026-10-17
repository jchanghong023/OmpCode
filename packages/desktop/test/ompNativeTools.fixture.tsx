// Real hook, React lifecycle and DOM consumer; only the downstream send boundary is controlled.
import { useRef } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerSubmissionConfig } from "../../ui/src/v4/composer/composerSubmissionConfig.js";
import type { ConversationComposerSendOptions } from "../../ui/src/v4/ConversationComposer.js";
import {
  useOmpNativeTools,
  type OmpNativeToolsSendOptions,
} from "../../ui/src/v4/native-tools/useOmpNativeTools.js";

type Result = "sent" | "blocked" | "confirmationRequired";
type Gate = "ready" | "running" | "interaction" | "choice";
interface Config {
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string | null;
  sessionId: string | null;
  gate: Gate;
  busy: boolean;
  unavailable: boolean;
  capability: boolean;
  submissionAvailable: boolean;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
interface Call {
  text: string;
  options: OmpNativeToolsSendOptions & ConversationComposerSendOptions;
  barrier: Deferred<void>;
  ack: Deferred<Result>;
  modalClosedAtEntry: boolean;
  phase: "barrier" | "rejected" | "ack" | "done";
}
let config: Config;
let submission: ComposerSubmissionConfig;
let renderProbe: () => void;
let unmountProbe: () => void;
let reads = 0;
const calls: Call[] = [];
const attempts: { text: string; result: Result | null }[] = [];
const dispatched: { text: string; submission: ComposerSubmissionConfig | null | undefined }[] = [];
const commands = [{ name: "goal", description: "Admission probe", source: "builtin" as const }];
async function sendText(
  text: string,
  options: OmpNativeToolsSendOptions & ConversationComposerSendOptions = {},
): Promise<Result> {
  const call: Call = {
    text,
    options,
    barrier: deferred<void>(),
    ack: deferred<Result>(),
    modalClosedAtEntry: document.querySelector('[role="dialog"]') === null,
    phase: "barrier",
  };
  calls.push(call);
  // Model the consumer's asynchronous workspace barrier, then recheck its admission lease.
  await call.barrier.promise;
  if (!options.nativeToolsAdmission?.canSubmit()) {
    call.phase = "rejected";
    return "blocked";
  }
  dispatched.push({ text, submission: options.submission });
  call.phase = "ack";
  try {
    return await call.ack.promise;
  } finally {
    call.phase = "done";
  }
}

export function NativeToolsProbe() {
  const form = useRef<HTMLFormElement>(null);
  const snapshot = config.sessionId
    ? ({
        sessionId: config.sessionId,
        pendingInteractions:
          config.gate === "interaction" ? [{ payload: { kind: "confirmation" } }] : [],
        inputRouting: { mode: config.gate === "choice" ? "choice" : "startNow" },
        control: { phase: config.gate === "running" ? "running" : "draft", canStop: false },
        // This consumer reads only routing/control/interaction fields from the projection.
      } as unknown as ConversationSnapshot)
    : null;
  const tools = useOmpNativeTools({
    ...config,
    snapshot,
    commands: config.capability ? commands : [],
    readComposerBusy: () => config.busy,
    readSubmission: () => {
      ++reads;
      return config.submissionAvailable ? submission : null;
    },
    sendText,
  });
  const execute = () => {
    const text = (form.current!.elements.namedItem("command") as HTMLInputElement).value;
    const attempt = { text, result: null as Result | null };
    attempts.push(attempt);
    void tools.onExecute(text).then((result) => {
      attempt.result = result;
    });
  };
  return (
    <section id="admission-probe">
      <h1>Native tools admission boundary</h1>
      <output id="admission-state">
        {JSON.stringify({
          open: tools.open,
          disabled: tools.disabled,
          reason: tools.disabledReason,
          generation: tools.scopeGeneration,
        })}
      </output>
      <button id="admission-open" type="button" onClick={tools.onOpen}>
        Open tools
      </button>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          execute();
        }}
      >
        <label>
          Command
          <input id="admission-command" name="command" defaultValue="/goal set initial" />
        </label>
        <button id="admission-submit" type="submit" disabled={tools.disabled}>
          Submit
        </button>
        {/* Intentionally bypass disabled UI to exercise the hook's authoritative admission guard. */}
        <button id="admission-force" type="button" onClick={execute}>
          Attempt regardless of disabled UI
        </button>
      </form>
      {tools.open ? (
        <section role="dialog" aria-label="Native tools admission probe">
          <p>Tool modal owned by the actual hook</p>
          <button type="button" onClick={() => tools.onOpenChange(false)}>
            Close
          </button>
        </section>
      ) : null}
    </section>
  );
}

const fixture = {
  reset() {
    unmountProbe();
    calls.length = 0;
    attempts.length = 0;
    dispatched.length = 0;
    reads = 0;
    config = {
      workspacePath: "/isolated/A",
      workspaceIdentity: "workspace-A",
      remoteSessionId: null,
      sessionId: "session-A",
      gate: "ready",
      busy: false,
      unavailable: false,
      capability: true,
      submissionAvailable: true,
    };
    submission = {
      mode: "build",
      planEnabled: false,
      modelSelection: {
        providerId: "isolated-provider",
        modelId: "model-at-click",
        options: { reasoningLevel: "low" },
      },
    };
    renderProbe();
  },
  configure(patch: Partial<Config>) {
    config = { ...config, ...patch };
    renderProbe();
  },
  mutateSubmission() {
    submission.planEnabled = true;
    submission.modelSelection.modelId = "model-after-click";
    submission.modelSelection.options!.reasoningLevel = "high";
  },
  releaseBarrier(index: number) {
    calls[index]!.barrier.resolve();
  },
  acknowledge(index: number, result: Result = "sent") {
    calls[index]!.ack.resolve(result);
  },
  reject(index: number) {
    calls[index]!.ack.reject(new Error("isolated-native-send-failure"));
  },
  inspect() {
    return {
      reads,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      dispatched: dispatched.map((item) => JSON.parse(JSON.stringify(item))),
      calls: calls.map((call) => ({
        text: call.text,
        phase: call.phase,
        modalClosedAtEntry: call.modalClosedAtEntry,
        isCurrent: call.options.nativeToolsAdmission?.isCurrent(),
        canSubmit: call.options.nativeToolsAdmission?.canSubmit(),
        submission: call.options.submission,
        frozen:
          Object.isFrozen(call.options.submission) &&
          Object.isFrozen(call.options.submission?.modelSelection) &&
          Object.isFrozen(call.options.submission?.modelSelection.options),
      })),
    };
  },
};

export function installNativeToolsFixture(render: () => void, unmount: () => void) {
  renderProbe = render;
  unmountProbe = unmount;
  window.nativeToolsFixture = fixture;
}

declare global {
  interface Window {
    nativeToolsFixture: typeof fixture;
  }
}
