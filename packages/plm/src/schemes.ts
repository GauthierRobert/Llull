/** Revision label schemes (FR-PLM-02, §5.3): asme-alpha, numeric-2 and custom ordered lists. */

/** A-Y without I, O, Q, S, X, Z (ASME Y14.35 practice, secondary sources). */
const ASME_ALPHABET = 'ABCDEFGHJKLMNPRTUVWY';
const ASME_CAPACITY = ASME_ALPHABET.length * (ASME_ALPHABET.length + 1);
const NUMERIC_CAPACITY = 99;

export const DEFAULT_SCHEME = 'asme-alpha';
const CUSTOM_PREFIX = 'custom:';

/** Whether `scheme` names a built-in scheme or a well-formed `custom:<name>`. */
export function isKnownScheme(scheme: string): boolean {
  return scheme === 'asme-alpha' || scheme === 'numeric-2' || (scheme.startsWith(CUSTOM_PREFIX) && scheme.length > CUSTOM_PREFIX.length);
}

/** Whether `labels` is a usable custom list: non-empty, non-blank, unique. */
export function isValidCustomList(labels: readonly string[]): boolean {
  return labels.length > 0 && labels.every((label) => label.trim() !== '') && new Set(labels).size === labels.length;
}

/**
 * The `n`-th (1-based) revision label of `scheme`, or null when the scheme is exhausted (asme-alpha: 420, numeric-2: 99, custom: its list).
 * @invariant asme-alpha: n <= 20 is one letter, then two letters (first = (n-21) div 20, second = (n-21) mod 20)
 */
export function revisionLabel(scheme: string, n: number, customLabels: readonly string[] = []): string | null {
  if (!Number.isInteger(n) || n < 1) return null;
  if (scheme === 'asme-alpha') {
    if (n > ASME_CAPACITY) return null;
    const size = ASME_ALPHABET.length;
    if (n <= size) return ASME_ALPHABET.charAt(n - 1);
    return ASME_ALPHABET.charAt(Math.floor((n - size - 1) / size)) + ASME_ALPHABET.charAt((n - size - 1) % size);
  }
  if (scheme === 'numeric-2') return n > NUMERIC_CAPACITY ? null : String(n).padStart(2, '0');
  return customLabels[n - 1] ?? null;
}
