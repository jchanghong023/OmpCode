/** 运行身份由 Main 在 React 启动前投影；默认 profile 保留旧键，不猜测待重启设置。 */
export function composerProfileStorageSuffix(): string {
  const profile =
    typeof window === "undefined"
      ? undefined
      : (window as Window & { __OMP_ACTIVE_PROFILE__?: string }).__OMP_ACTIVE_PROFILE__;
  return profile && profile !== "default" ? `:omp-profile:${encodeURIComponent(profile)}` : "";
}
