/**
 * @layer lib
 * @pure
 */

/** A number that is neither NaN nor ±Infinity. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
