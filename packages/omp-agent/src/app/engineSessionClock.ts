/** Owned by one engine; only initial cold hydration restores the history baseline. */
export class EngineSessionClock {
  createdAt = Date.now();
  activityBaselineAt = this.createdAt;

  restore(times: { createdAt?: number; updatedAt?: number }): void {
    this.createdAt = times.createdAt ?? this.createdAt;
    this.activityBaselineAt = times.updatedAt ?? this.createdAt;
  }
}
