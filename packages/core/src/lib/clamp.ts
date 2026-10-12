/** `value` limited to [`min`, `max`]; NaN stays NaN. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `value` limited to [0, 1]. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
