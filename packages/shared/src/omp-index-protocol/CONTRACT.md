# OMP index protocol

`@zcode/shared/omp-indexes` is the sole public package subpath for the Wiki and Repo schemas and inferred types. This domain module depends only on Zod. It performs no IO and owns no index, cancellation registry, cache, queue, session, or progress state. The execution-side OMP native index implementation owns those resources; services route requests and UI renders its results. No UI or service implementation may be imported here.

## Request and transport boundary

The existing consumer request is a strict action-discriminated object. Every action includes a nonempty `workspacePath` and `operationId`, plus optional `workspaceIdentity` and `remoteSessionId`. `workspacePath` names the execution-side filesystem location, not a client-local lookup. Routing and isolation use `workspaceIdentity?.trim() || workspacePath`; the schema preserves these fields without normalizing or conflating them. Remote requests preserve `remoteSessionId` in the workspace reference throughout routing and progress correlation, rather than matching by path alone. `operationId` correlates work, progress, cancellation and stale-result filtering within that workspace; it does not create an operation or guarantee idempotency itself.

The service adapter maps `action` to `omp/wiki/<action>` or `omp/repo/<action>`, places the workspace reference and operation ID in the native request envelope, and omits `action` from the native payload. This module describes the consumer boundary, not a replacement wire protocol or a vendor protocol extension.

Wiki initialization requires `directory`, `name` and `confirmedDirectory`. Repo mutations require `confirmedRoot`; the executor validates actual path equality and authorization. Schema acceptance alone never grants filesystem permission. Search queries are nonempty; Wiki pages allow 1–200 hits, Repo pages 1–50, and optional Wiki character budgets allow 1–1,000,000. Limits and budgets must be integers. Empty operation IDs and unknown object fields are rejected.

## Results and events

Result schemas retain the native list/build/query/status/removal/cancellation shapes. Repo coverage exposes incomplete, pending and uncertain state instead of claiming a complete index. Progress carries its workspace and operation ID alongside the Wiki or Repo progress payload. The owner emits progress before terminal completion; adapters and consumers must match the workspace and operation before applying it and discard obsolete-operation events. Progress is a transient projection, not replay or persistence owned here. Both desktop continuous delivery and mobile replayable delivery retain their existing runtime owners; these schemas introduce neither delivery mechanism.

`contract.test.ts` exercises invalid request bounds, required confirmations, strict unknown-field rejection and malformed results/events. `contract.example.ts` shows typed consumer requests and progress without running an index or fabricating runtime success.
