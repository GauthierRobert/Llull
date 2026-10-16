/** Round `value` to `digits` significant digits (default 12, PHY-21 TR-FPR-11); non-finite values pass through. */
export function roundSignificant(value: number, digits = 12): number {
  return Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(digits)) : value;
}

/** Deep copy of a JSON-like value with every number rounded to `digits` significant digits and -0 normalised to 0. */
export function roundDeep<T>(value: T, digits = 12): T {
  if (typeof value === 'number') return (Object.is(value, -0) ? 0 : roundSignificant(value, digits)) as T;
  if (Array.isArray(value)) return value.map((entry) => roundDeep(entry, digits)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundDeep(entry, digits)])) as T;
  return value;
}
