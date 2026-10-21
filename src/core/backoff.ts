export const DEFAULT_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

export function backoffDelayMs(
  baseMs: number,
  attempt: number,
  maxMs: number = MAX_BACKOFF_MS,
): number {
  const safeBase = Math.max(0, Math.floor(baseMs));
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const delay = safeBase * 2 ** (safeAttempt - 1);
  return Math.min(delay, Math.max(0, Math.floor(maxMs)));
}
