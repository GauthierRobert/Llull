/**
 * @layer lib
 * @pure
 */

const NICE = [1, 2, 5, 10];

/** Smallest 1-2-5 step (times a power of ten) that is at least `minimum`: scale bars, scales, ticks. */
export function niceStep(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(minimum, 1e-9)));
  return (NICE.map((n) => n * power).find((step) => step >= minimum - 1e-12) as number) ?? power * 10;
}
