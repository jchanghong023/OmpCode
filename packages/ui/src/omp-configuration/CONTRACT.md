# OMP configuration

Owner: conversation UI. This module owns only unsaved role and Team drafts. Persisted facts belong to the target OMP AgentSession's configuration service.

The public panel receives an explicit workspace/session target and calls `IZCodeAgentService.configureOmpSession`; it never accesses files, credentials or `window.zcode`. Profile comes from the trusted server response. Draft preview is read-only and revision correlated. A scope change, close, disconnect or process generation change invalidates in-flight callbacks. External changes refresh saved facts but never overwrite dirty drafts or their original CAS revision. Only explicit Save submits; cancellation and defaults only edit local state. Conflict, partial and unknown outcomes never replay saves automatically.

The mounted controller is scoped to service and workspace/session identity, not composer callback identity. Replacing a callback preserves the same target's dirty drafts and confirmed operation notices; completion uses the current callback. A different target still disposes the old controller and rejects its late results.

Role-specific directory reads merge returned descriptors by `roleId` into the mounted target's current directory: existing rows keep their order, matching IDs are replaced once, and new IDs append. Adding a custom role must not hide standard role controls or change any dirty draft or its original CAS revision. These reads never save, reset or rebase another role and remain subject to the same scope-generation invalidation as other requests.

Refreshes started before a save or while it is in flight cannot unlock readback after its outcome; only a new refresh after settlement can do so. A directory refresh rereads retained/requested custom roles absent from the directory through `get_model_roles {roleId}`, never copies old descriptors into fresh facts, and preserves draft selections and original CAS revisions until explicit adoption.

Model search uses the shared `get_team_models {query}` operation, including its verified aliases. Search results are correlated with query and controller connection generation, and affect only the catalog search projection; the complete model directory, saved members, role candidates and defaults remain unchanged.

`contract.ts` contains only shared-schema types and command/lifecycle ports; it does not import a service implementation or re-export runtime values. `module.ts` is the public composition entrypoint consumed by the toolbar. Implementations depend on the contract, never the reverse. Regression tests exercise preview races, scope isolation, conflict preservation, cancellation and receipt states through this composition entrypoint. Parent owns all test execution.
