/** Reconciliation requery schedule: 30s, 2m, 10m, 1h, 6h, then escalate to a human. */
export const RECONCILIATION_SCHEDULE_MS: readonly number[] = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];

/** Delay before the next requery, or null = budget exhausted -> ESCALATE. */
export function nextReconciliationDelayMs(attemptsMade: number): number | null {
  const d = RECONCILIATION_SCHEDULE_MS[attemptsMade];
  return d === undefined ? null : d;
}

/**
 * Webhook delivery retry: exponential backoff with full jitter, capped.
 * Returns null after maxAttempts -> mark delivery DEAD (surface it in the dashboard).
 */
export function webhookRetryDelayMs(
  attemptCount: number,
  rand: () => number = Math.random,
  baseMs = 5_000,
  capMs = 3_600_000,
  maxAttempts = 12,
): number | null {
  if (attemptCount >= maxAttempts) return null;
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attemptCount - 1));
  return Math.max(1_000, Math.floor(rand() * ceiling)); // floor: no hot retry loops
}
