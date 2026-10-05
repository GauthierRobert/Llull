/** @layer ui/store JSON in localStorage for presentation preferences; never throws (storage may be unavailable). */

/** The JSON value stored under `key`; `undefined` when absent, malformed or storage is unavailable. */
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/** Store `value` as JSON under `key`; silently skipped when storage is unavailable or full. */
export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sandboxed iframe, test environment or quota exceeded
  }
}
