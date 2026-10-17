import { isRecord } from './isRecord';

/**
 * `value` with every `confirmation` object (a human signature, TR-MAT-51) replaced by `{ verified: true }`, at any depth (a plan step carries
 * its own). Signatures are checked by the command and never stored in history, saved files or the live command log.
 * @invariant the input is not mutated; a value with no `confirmation` object is returned as the same reference
 */
export function withoutConfirmations(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(withoutConfirmations);
    return mapped.some((entry, index) => entry !== value[index]) ? mapped : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
    const next = key === 'confirmation' && typeof entry === 'object' && entry !== null ? { verified: true } : withoutConfirmations(entry);
    if (next !== entry) changed = true;
    return [key, next];
  });
  return changed ? Object.fromEntries(entries) : value;
}
