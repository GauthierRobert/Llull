/**
 * Welding key of a coordinate tuple: values snapped to a grid of `unit` (points closer than about
 * `unit` share a key). The one point / segment identity used by edge welding, loop chaining and
 * duplicate removal.
 * @layer lib
 * @pure
 */
export function quantizedKey(values: ReadonlyArray<number>, unit: number): string {
  return values.map((value) => Math.round(value / unit)).join(',');
}
