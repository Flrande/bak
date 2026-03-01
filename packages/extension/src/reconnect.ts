const DEFAULT_BASE_DELAY_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 15_000;

export interface ReconnectBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

export function computeReconnectDelayMs(
  attempt: number,
  options: ReconnectBackoffOptions = {}
): number {
  const baseDelayMs = Math.max(100, clampNonNegative(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
  const maxDelayMs = Math.max(baseDelayMs, clampNonNegative(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
  const normalizedAttempt = Number.isFinite(attempt) ? Math.floor(attempt) : 0;
  const safeAttempt = Math.max(0, Math.min(10, normalizedAttempt));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** safeAttempt);
}
