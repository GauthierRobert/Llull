/** m/s²; converts kg to kN (÷ 1000) and tonnes to N (× 1000 × GRAVITY). */
export const GRAVITY = 9.80665;

/** Rounds to `digits` decimals; never returns -0. */
export const round = (value: number, digits = 2): number =>
  Math.round(value * 10 ** digits) / 10 ** digits + 0;
