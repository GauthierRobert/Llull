/**
 * @layer lib
 * @pure
 */

/** A plain (non-null, non-array) object, e.g. a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
