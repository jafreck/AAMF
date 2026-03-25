/**
 * Convert a configured iteration cap into the numeric bound expected by the
 * flow runner. A config value of 0 means unlimited.
 */
export function resolveLoopMaxIterations(
  configured: number | undefined,
  fallback: number,
): number {
  const normalized = configured ?? fallback;
  return normalized === 0 ? Number.POSITIVE_INFINITY : normalized;
}