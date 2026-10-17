// Serialized into the existing Electron renderer; no model, Main IPC or daily instance.
export async function admissionAssertions() {
  const f = window.nativeToolsFixture;
  const check = (value, label) => {
    if (!value) throw new Error(label);
  };
  const tick = () =>
    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; ++i) {
      if (predicate()) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(label);
  };
  const state = () => JSON.parse(document.getElementById("admission-state").textContent);
  const open = () => document.getElementById("admission-open").click();
  // This DOM button deliberately remains enabled, so disabled rendering cannot mask a broken guard.
  const attempt = () => document.getElementById("admission-force").click();
  const modal = () => document.querySelector('[role="dialog"]');
  const atAck = (index) =>
    waitFor(() => f.inspect().calls[index]?.phase === "ack", `call ${index} did not reach ACK`);
  const result = (index, expected) =>
    waitFor(
      () => f.inspect().attempts[index]?.result === expected,
      `attempt ${index} did not resolve ${expected}`,
    );
  window.productToolsFixture.reset();
  f.reset();
  for (const gate of ["running", "interaction", "choice"]) {
    f.configure({ gate });
    open();
    await tick();
    check(modal() && state().open, `${gate}: blocked execution also prevented opening tools`);
    check(
      document.getElementById("admission-submit").disabled &&
        state().reason === `ompNativeTools.blocked.${gate}`,
      `${gate}: missing visible disabled state`,
    );
    attempt();
    await tick();
    check(
      f.inspect().calls.length === 0 && f.inspect().reads === 0,
      `${gate}: forced DOM submission crossed admission`,
    );
    check(f.inspect().attempts.at(-1).result === "blocked", `${gate}: request not rejected`);
    check(state().open, `${gate}: rejected request closed the modal`);
  }

  // Both events run in one JS turn; the second must lose before submission is read or send is called.
  f.reset();
  open();
  await tick();
  check(modal(), "initial tool modal missing");
  const button = document.getElementById("admission-force");
  button.click();
  button.click();
  document.getElementById("admission-command").value = "/goal set edited-after-click";
  f.mutateSubmission();
  await result(1, "blocked");
  let observed = f.inspect();
  check(
    observed.calls.length === 1 && observed.reads === 1,
    "synchronous double click admitted twice",
  );
  check(observed.attempts[0].result === null, "first request did not wait at barrier");
  check(observed.calls[0].modalClosedAtEntry && !modal(), "modal closed after send callback entry");
  check(state().reason === "ompNativeTools.blocked.submitting", "pending not exposed to consumer");
  check(observed.calls[0].frozen, "submission or nested model settings were not frozen");
  f.releaseBarrier(0);
  await atAck(0);
  observed = f.inspect();
  check(observed.dispatched.length === 1, "first admitted command never dispatched");
  const sent = observed.dispatched[0];
  check(
    sent.text === "/goal set initial" &&
      sent.submission.mode === "build" &&
      sent.submission.planEnabled === false &&
      sent.submission.modelSelection.modelId === "model-at-click" &&
      sent.submission.modelSelection.options.reasoningLevel === "low",
    "post-click edits changed the deferred command or submission",
  );
  f.acknowledge(0);
  await result(0, "sent");
  await tick();
  check(!state().disabled && !state().open, "successful ACK left pending or reopened tools");

  // A live routing change during a barrier must be checked again, not just at click time.
  for (const gate of ["running", "interaction", "choice"]) {
    f.reset();
    attempt();
    f.configure({ gate });
    check(!f.inspect().calls[0].canSubmit, `${gate}: barrier retained submission permission`);
    f.releaseBarrier(0);
    await result(0, "blocked");
    check(f.inspect().dispatched.length === 0, `${gate}: old request crossed blocked barrier`);
    f.configure({ gate: "ready" });
    await tick();
    check(f.inspect().calls.length === 1, `${gate}: becoming ready automatically retried`);
    attempt();
    f.releaseBarrier(1);
    await atAck(1);
    f.acknowledge(1);
    await result(1, "sent");
  }

  // Exercise every target dimension; equality of A's values must never revive A's old lease.
  const scopes = [
    ["workspacePath", "/isolated/A", "/isolated/B"],
    ["workspaceIdentity", "workspace-A", "workspace-B"],
    ["remoteSessionId", null, "remote-B"],
    ["sessionId", "session-A", "session-B"],
  ];
  for (const phase of ["barrier", "ack"]) {
    for (const [key, a, b] of scopes) {
      const label = `${key} A-B-A during ${phase}`;
      f.reset();
      open();
      attempt();
      if (phase === "ack") {
        f.releaseBarrier(0);
        await atAck(0);
      }
      const firstGeneration = state().generation;
      f.configure({ [key]: b });
      check(
        !f.inspect().calls[0].isCurrent && !f.inspect().calls[0].canSubmit,
        `${label}: B did not revoke old A`,
      );
      open();
      attempt();
      f.releaseBarrier(1);
      await atAck(1);
      check(f.inspect().calls[1].isCurrent, `${label}: B was unusable while old A was pending`);
      f.configure({ [key]: a });
      open();
      attempt();
      f.releaseBarrier(2);
      await atAck(2);
      // Reopen while new A is awaiting ACK; stale completions must not dismiss this new modal.
      open();
      await tick();
      observed = f.inspect();
      check(state().generation > firstGeneration, `${label}: reused the old generation`);
      check(
        !observed.calls[0].isCurrent &&
          !observed.calls[0].canSubmit &&
          !observed.calls[1].isCurrent &&
          !observed.calls[1].canSubmit &&
          observed.calls[2].isCurrent &&
          observed.calls[2].canSubmit,
        `${label}: target lease revived or new A was not admitted`,
      );
      check(modal() && state().open && state().disabled, `${label}: new pending/modal missing`);
      check(
        observed.calls.every((call) => call.modalClosedAtEntry),
        `${label}: a scope called send before closing its modal`,
      );
      if (phase === "barrier") f.releaseBarrier(0);
      else f.acknowledge(0);
      f.acknowledge(1);
      await result(0, "blocked");
      await result(1, "blocked");
      await tick();
      observed = f.inspect();
      check(
        observed.calls[0].phase === (phase === "barrier" ? "rejected" : "done"),
        `${label}: stale barrier was not rejected`,
      );
      check(
        observed.dispatched.length === (phase === "barrier" ? 2 : 3),
        `${label}: rejected old request dispatched or a new scope did not dispatch`,
      );
      check(
        state().open &&
          modal() &&
          state().reason === "ompNativeTools.blocked.submitting" &&
          observed.attempts[2].result === null,
        `${label}: stale completion closed new modal or cleared new pending`,
      );
      // This second new-A request is a counterexample to stale finally clearing the current flight.
      attempt();
      await result(3, "blocked");
      check(
        f.inspect().calls.length === 3 && f.inspect().reads === 3,
        `${label}: lost single-flight`,
      );
      f.acknowledge(2);
      await result(2, "sent");
      await tick();
      check(state().open && modal() && !state().disabled, `${label}: current ACK damaged modal`);
      attempt();
      check(
        f.inspect().calls.length === 4,
        `${label}: current scope unusable after stale completion`,
      );
      f.releaseBarrier(3);
      await atAck(3);
      f.acknowledge(3);
      await result(4, "sent");
    }
  }

  f.reset();
  open();
  attempt();
  f.releaseBarrier(0);
  await atAck(0);
  f.reject(0);
  await result(0, "blocked");
  await tick();
  check(!state().disabled && !state().open, "failure left pending or reopened the modal");
  await tick();
  check(f.inspect().calls.length === 1 && f.inspect().reads === 1, "failure automatically resent");
  open();
  attempt();
  f.releaseBarrier(1);
  await atAck(1);
  f.acknowledge(1, "confirmationRequired");
  await result(1, "confirmationRequired");
  await tick();
  check(
    f.inspect().calls.length === 2 && !state().disabled,
    "explicit retry not independently usable",
  );
  check(!state().open, "confirmationRequired reopened tools over the native interaction");
  open();
  await tick();
  check(modal(), "final admission evidence modal missing");
  return "PASS native hook: React DOM single-flight, frozen click, live guards, all target A-B-A fences at barrier/ACK, stale isolation and explicit-only retry";
}
