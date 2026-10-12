/**
 * @layer lib
 * @pure
 */

/** An array whose items are all strings (an empty array qualifies). */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
