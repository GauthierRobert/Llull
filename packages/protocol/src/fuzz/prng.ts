/**
 * Deterministic PRNG for the robustness fuzz (SC-Q3): mulberry32, so a seed names one design on every machine and Node version.
 * Lengths are drawn on the 2.5 mm fuzz grid.
 */

/** Every generated length and placement is a multiple of this (mm). */
export const FUZZ_GRID_MM = 2.5;

export interface Prng {
  /** Uniform in [0, 1). */
  readonly next: () => number;
  /** Uniform integer in [min, max] (inclusive). */
  readonly int: (min: number, max: number) => number;
  readonly pick: <T>(items: readonly [T, ...T[]]) => T;
  /** A multiple of the grid in [minSteps, maxSteps] grid steps (both inclusive). */
  readonly grid: (minSteps: number, maxSteps: number) => number;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => (max <= min ? min : min + Math.floor(next() * (max - min + 1)));
  return {
    next,
    int,
    pick: <T>(items: readonly [T, ...T[]]): T => items[int(0, items.length - 1)] ?? items[0],
    grid: (minSteps: number, maxSteps: number): number => int(minSteps, maxSteps) * FUZZ_GRID_MM,
  };
}

/** `value` rounded down (towards zero) onto the grid. */
export const floorToGrid = (value: number): number => Math.trunc(value / FUZZ_GRID_MM) * FUZZ_GRID_MM;
