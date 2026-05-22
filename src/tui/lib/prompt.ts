/**
 * Safe terminal prompt for the TUI.
 *
 * Temporarily exits raw mode, reads a line via stdin, and restores raw mode.
 * This is a stopgap — prefer proper in-TUI text inputs for new code.
 * TODO: Replace all callers with a proper TextareaRenderable-based widget.
 */

export function promptFor(label: string, current: string): string {
  const wasRaw = process.stdin.isRaw;

  // Exit raw mode so prompt() / stdin line mode works
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    // Non-TTY stdin; proceed anyway
  }

  try {
    // Bun supports prompt() as a stdin readline shim
    const result = prompt(`${label}:`);
    return result?.trim() || current;
  } catch {
    // If prompt() fails (e.g., non-interactive), return default
    return current;
  } finally {
    // Restore raw mode — critical: must succeed if we changed it
    if (wasRaw) {
      try {
        process.stdin.setRawMode?.(true);
      } catch {
        // Best-effort; terminal might have been destroyed
      }
    }
  }
}
