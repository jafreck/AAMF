/**
 * @module util/format
 * Shared formatting utilities used across the runtime.
 */

/** Format a duration in milliseconds as a human-readable string (e.g., "1h 2m 3s", "5m 30s", "45s"). */
export function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}
