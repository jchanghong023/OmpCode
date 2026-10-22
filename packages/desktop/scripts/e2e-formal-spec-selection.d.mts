export const SSH_FORMAL_SPEC_GLOB: string;
export const MANUAL_REVIEW_SPEC_GLOB: string;
export const FORK_TEMPORARY_E2E_EXCLUDES: string[];
export const FORK_DEFERRED_E2E_SPECS: string[];

export function isTemporarilyExcludedFormalSpec(spec: string): boolean;

export function resolveDeferredFormalSpecExcludes(options: { requestedSpecs: string[] }): string[];

export function hasRequiredSshE2EEnvironment(env: Record<string, string | undefined>): boolean;

export function isSshFormalSpec(spec: string): boolean;

export function resolveEnvironmentGatedFormalSpecExcludes(options: {
  env: Record<string, string | undefined>;
  targeted: boolean;
}): string[];
