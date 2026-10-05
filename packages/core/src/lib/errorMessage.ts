/**
 * @layer lib
 * @pure
 */

/** The message of a thrown `Error`, else the stringified thrown value. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
