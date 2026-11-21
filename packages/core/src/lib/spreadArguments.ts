/**
 * The argument list a spread call `f(...values)` passes, for the linear stand-ins of spread-sensitive built-ins (maxOf, minOf,
 * hypotOf; PERF1 row 12). A spread reads every item before the call, and the built-in then applies ToNumber to each argument in
 * order — so a valueOf that runs user code sees the item list as the spread left it.
 */

/** Array and typed-array items are read in place; any other iterable is drained first, as the spread does. */
export function spreadSource(values: Iterable<unknown>): ArrayLike<unknown> {
  return Array.isArray(values) || ArrayBuffer.isView(values) ? (values as ArrayLike<unknown>) : Array.from(values);
}

/**
 * ToNumber (`+item`, once each, in order) of the items from `start` on. The items are copied before the first conversion: a valueOf
 * must not change the arguments, which the spread already read.
 */
export function toNumbersFrom(items: ArrayLike<unknown>, start: number): number[] {
  const rest: unknown[] = [];
  for (let i = start; i < items.length; i++) rest.push(items[i]);
  const numbers: number[] = [];
  for (const item of rest) numbers.push(+(item as number));
  return numbers;
}
