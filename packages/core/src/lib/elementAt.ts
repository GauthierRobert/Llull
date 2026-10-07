/**
 * Element `index` of `list`; throws RangeError when out of bounds (an invariant breach by
 * construction, never user input — `execute` turns a throw into a no-op).
 *
 * @layer lib
 * @pure
 */
export function elementAt<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new RangeError(`index ${index} out of range (length ${list.length})`);
  }
  return value;
}
