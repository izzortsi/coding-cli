/**
 * Raw-mode key selection utility.
 *
 * Shared by picker.ts and channelSidebar.ts. Handles entering raw mode,
 * listening for navigation keys, and cleaning up on selection/cancel.
 */

export interface RawSelectCallbacks {
  /** Called on arrow up / k */
  onUp: () => void;
  /** Called on arrow down / j */
  onDown: () => void;
  /** Called on Enter — return the selected value or null */
  onSelect: () => string | null;
  /** Called on Escape / q / Ctrl+C — return null to cancel */
  onCancel: () => null;
  /** Called on number key 1-9 — return value or undefined to ignore */
  onNumber?: (n: number) => string | null | undefined;
  /** Additional key codes that trigger cancel (e.g. Ctrl+B = '\x02') */
  extraCancelKeys?: string[];
}

/**
 * Enter raw mode and listen for navigation keys.
 * Resolves with the selected value string, or null if cancelled.
 */
export function rawSelect(callbacks: RawSelectCallbacks): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    function cleanup(): void {
      stdin.removeListener('data', onKey);
      if (wasRaw !== undefined) stdin.setRawMode(wasRaw);
      stdin.resume();
    }

    function done(value: string | null): void {
      cleanup();
      resolve(value);
    }

    function onKey(data: Buffer): void {
      const key = data.toString();

      // Arrow up / k
      if (key === '\x1b[A' || key === 'k') {
        callbacks.onUp();
        return;
      }

      // Arrow down / j
      if (key === '\x1b[B' || key === 'j') {
        callbacks.onDown();
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        done(callbacks.onSelect());
        return;
      }

      // Escape / q / Ctrl+C
      if (key === '\x1b' || key === 'q' || key === '\x03') {
        done(callbacks.onCancel());
        return;
      }

      // Extra cancel keys (e.g. Ctrl+B for sidebar)
      if (callbacks.extraCancelKeys?.includes(key)) {
        done(callbacks.onCancel());
        return;
      }

      // Number keys 1-9
      if (callbacks.onNumber) {
        const num = parseInt(key, 10);
        if (num >= 1 && num <= 9) {
          const result = callbacks.onNumber(num);
          if (result !== undefined) {
            done(result);
            return;
          }
        }
      }
    }

    // Enter raw mode
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  });
}
