/**
 * Shared formatting utilities for the Frieren TUI.
 */

/** Truncate text with an ellipsis, normalizing whitespace. */
export function truncate(value: string, width = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > width ? `${normalized.slice(0, width - 1)}…` : normalized;
}

/** Format an ISO timestamp to "YYYY-MM-DD HH:MM". */
export function formatStamp(value: string | undefined): string {
  return value?.replace("T", " ").slice(0, 16) ?? "-";
}

/** Format an ISO timestamp to "MM-DD HH:MM" (no year). */
export function formatStampShort(value: string | undefined): string {
  return value?.replace("T", " ").slice(5, 16) ?? "-";
}
