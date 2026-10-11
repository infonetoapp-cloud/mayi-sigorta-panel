/** OFFLINE LOGIC fixture only. Does not model provider bucketing, ingestion or email. */
export function interpretFreshnessScalar(value: unknown): 'NO_ALERT' | 'ALERT' | 'DIAGNOSTIC' {
  return value === 0 ? 'NO_ALERT' : value === 1 ? 'ALERT' : 'DIAGNOSTIC';
}
export function evaluateBackupWindow(
  timestamps: unknown,
  now: number,
): 'NO_ALERT' | 'ALERT' | 'DIAGNOSTIC' {
  if (
    !Array.isArray(timestamps) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    timestamps.some((t) => !Number.isSafeInteger(t) || t < 0 || t > now)
  )
    return 'DIAGNOSTIC';
  const count = timestamps.filter((t) => t >= now - 2700000).length;
  return interpretFreshnessScalar(count === 0 ? 1 : 0);
}
