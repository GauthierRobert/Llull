/** Ordering rule of the increments of a creep hold, shared by `set_creep_step` and the load validation. */

/** 0 < min <= initial <= max <= duration, where min / max may be absent. */
export function incrementsOrdered(min: number | undefined, initial: number, max: number | undefined, duration: number): boolean {
  const upper = max === undefined ? initial : max;
  return initial > 0 && (min === undefined || (min > 0 && min <= initial)) && initial <= upper && upper <= duration;
}
