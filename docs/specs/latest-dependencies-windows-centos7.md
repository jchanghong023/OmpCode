# Dependency refresh: Windows and CentOS 7

## Product rule

- Refresh direct runtime and development dependencies in the root and active `packages/*` workspace to the current stable npm `latest` versions. Keep `workspace:*` links and the retained, non-workspace `apps/zcode-cli` snapshot unchanged. A prerelease dist-tag is not treated as a stable update unless the existing declaration already opts into that prerelease family.
- Keep React and React DOM on the same version through the root override. Keep related package families, including Lexical, OpenTelemetry, Streamdown, and xterm, internally compatible.
- Preserve the current desktop, web, server, and omp behavior. This change is a dependency migration, not a new product feature or a new state owner.
- The Windows x64 desktop build must use the refreshed dependencies. The CentOS 7 x64 release must still build from the same frozen lockfile on Ubuntu 24.04 and run through its existing isolated userspace and PRoot launcher. Do not change its package identity, launcher isolation, tag scheme, or publishing behavior.

## Ownership and migration boundary

- Root and active package manifests own direct version declarations; `pnpm-lock.yaml` owns the exact resolved graph. The root pnpm override owns the React pair. The existing `@arms/rum-electron@0.0.3` patch remains attached to that exact package unless a stable successor and a verified patch migration exist.
- Adapt only application calls that changed in a new dependency API. Existing services and stores retain ownership of their state; dependency changes do not add a parallel path for commands, persistence, or remote delivery.
- Keep the repository's Node and pnpm toolchain pins unless a new dependency proves they must change; any such change must be checked in both Windows and CentOS 7 workflows before acceptance.
- Where the latest major version violates a direct peer contract, use the newest compatible stable version and record the constraint: `@arms/rum-electron@0.0.3` requires `@babel/runtime@^7.24.5`, and `@hono/node-ws@1.3.1` requires `@hono/node-server@^1.19.11`. TypeScript 7 has no JavaScript compiler API, so scripts that parse source may use the official `@typescript/typescript6` compatibility package while `tsc` remains version 7.
- Keep oxlint on the newest previously passing minor (`1.60.x`) for this migration: `1.85.0` newly reports `max-lines` errors across unchanged legacy files, while the existing policy requires the 400-line rule and the task forbids unrelated refactors or suppressions. Upgrade oxlint separately after those files are brought under the rule.

## Acceptance

- Windows: a frozen install succeeds; typecheck, lint, relevant package tests, architecture check, and desktop build succeed. Exercise changed interaction paths when an upgraded API affects the UI.
- Linux release path: a frozen install and the CentOS 7 workflow's Linux desktop build steps succeed in Ubuntu 24.04. Check that the produced Linux app still contains Electron, the renderer, and embedded omp. A failure in this path blocks the merge.
- The lockfile resolves the declared versions, no direct active-workspace dependency remains behind a stable npm `latest` tag without a recorded compatibility reason, and the branch is merged into `main` only after the applicable checks pass.
