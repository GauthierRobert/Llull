/** Soft-selection weights of NURBS poles in pole-index space (04 DIR §5.4): d = max(|di| / radiusU, |dj| / radiusV) to the nearest selected pole. */

import { type FalloffShape, softWeight } from '../falloff';

/** Weight per pole of a curve: 1 on `selected`, `softWeight(distance in poles, radius, shape)` elsewhere (radius 0 = only the selection). */
export function curvePoleWeights(count: number, selected: readonly number[], radius: number, shape: FalloffShape): number[] {
  return Array.from({ length: count }, (_, i) => {
    const distance = Math.min(...selected.map((s) => Math.abs(i - s)));
    return selected.includes(i) ? 1 : softWeight(distance, radius, shape);
  });
}

/** Weight per pole (i, j) of a surface grid; the radii are in pole-index units along u and v. */
export function surfacePoleWeights(
  countU: number,
  countV: number,
  selected: ReadonlyArray<readonly [number, number]>,
  radiusU: number,
  radiusV: number,
  shape: FalloffShape,
): number[][] {
  const chosen = new Set(selected.map(([i, j]) => `${i},${j}`));
  return Array.from({ length: countU }, (_, i) =>
    Array.from({ length: countV }, (_, j) => {
      if (chosen.has(`${i},${j}`)) return 1;
      const distance = Math.min(
        ...selected.map(([si, sj]) =>
          Math.max(
            radiusU > 0 ? Math.abs(i - si) / radiusU : Math.abs(i - si) > 0 ? Infinity : 0,
            radiusV > 0 ? Math.abs(j - sj) / radiusV : Math.abs(j - sj) > 0 ? Infinity : 0,
          ),
        ),
      );
      return softWeight(distance, 1, shape);
    }),
  );
}
