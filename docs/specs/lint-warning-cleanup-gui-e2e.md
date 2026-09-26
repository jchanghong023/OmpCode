# Lint warning cleanup and GUI acceptance

This is the scoped engineering record for the lint cleanup and its GUI acceptance attempt, not an ongoing product requirement or authorization to run another acceptance session. Product requirements live in [the requirements directory](../requirements/README.md); actual results and untested boundaries are in [the GUI report](../test-reports/gui-e2e-2026-09-26.md).

## Scope and invariants

- Remove the current `pnpm lint` warnings without suppressing rules or changing user-visible behavior.
- Keep existing state owners, public interfaces, event order, persistence, and failure behavior unchanged. Unused imports, declarations, and redundant syntax can be removed only after confirming that they are not referenced.
- Preserve local user data and running applications. GUI acceptance uses an isolated test instance and `zhipu-coding-plan/glm-5.3-flash`; it must not take focus from the user's video playback.

## Acceptance

- `pnpm lint` reports zero warnings and zero errors; `pnpm typecheck`, `pnpm fmt:check`, and `pnpm architecture:check --changed` pass.
- Existing package tests relevant to changed code pass.
- GUI acceptance visits all reachable top-level desktop surfaces and checks their visible controls, navigation, settings, and a real model conversation. Record untested surfaces or environment limits explicitly.
