// 与当前内嵌 omp 的 profile 命名规则保持一致。
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

export function normalizeOmpProfileName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name || name === "default") return "default";
  if (
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    !PROFILE_NAME_RE.test(name) ||
    WINDOWS_RESERVED_RE.test(name)
  ) {
    throw new Error("omp_profile_invalid");
  }
  return name;
}

export function resolveOmpProfileFromEnv(env: {
  OMP_PROFILE?: string;
  PI_PROFILE?: string;
}): string {
  return normalizeOmpProfileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
}
