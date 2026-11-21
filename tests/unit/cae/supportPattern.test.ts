/** 14 FLL-M2b: the 3-2-1 pattern search (`bestSupportPattern`): the forced choices, invariance, and every degenerate input. */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import { bestSupportPattern } from '@cae/flightLoads/supportPattern';

type Triple = [Vec3, Vec3, Vec3];

describe('bestSupportPattern', () => {
  it('frees the dof along P1P2 at point 2 and holds the dof that the remaining rotation moves at point 3 (the only full-rank pattern)', () => {
    // P2 on x from P1: ux at P2 restrains nothing P1 does not; the rotation left about x moves P3 = (0, 1, 0) along z.
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ])?.dofs,
    ).toEqual([['ux', 'uy', 'uz'], ['uy', 'uz'], ['uz']]);
    // P2 on z: free uz; the rotation about z moves P3 = (1, 0, 0) along y.
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [0, 0, 2],
        [1, 0, 0],
      ])?.dofs,
    ).toEqual([['ux', 'uy', 'uz'], ['ux', 'uy'], ['uy']]);
    // P2 on y: free uy; the rotation about y moves P3 = (0, 0, 1) along x.
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [0, 3, 0],
        [0, 0, 1],
      ])?.dofs,
    ).toEqual([['ux', 'uy', 'uz'], ['ux', 'uz'], ['ux']]);
  });

  it('is invariant to a translation and a uniform scale of the points (lengths are scaled by the spread about the mean)', () => {
    const base: Triple = [
      [0, 0, 0],
      [3, 1, 0.5],
      [1, 4, 2],
    ];
    const moved = base.map((p): Vec3 => [1000 * p[0] + 120, 1000 * p[1] - 45, 1000 * p[2] + 7]) as Triple;
    const a = bestSupportPattern(base);
    const b = bestSupportPattern(moved);
    expect(a).not.toBeNull();
    expect(b?.dofs).toEqual(a?.dofs);
    expect(b?.conditioning).toBeCloseTo(a?.conditioning ?? Number.NaN, 9);
    expect(a?.conditioning).toBeGreaterThan(0.05);
    expect(a?.conditioning).toBeLessThanOrEqual(1);
  });

  it('a well spread triangle is better conditioned than a slender one', () => {
    const wide = bestSupportPattern([
      [0, 0, 0],
      [1, 0, 0],
      [0.5, 0.87, 0],
    ]);
    const slender = bestSupportPattern([
      [0, 0, 0],
      [1, 0, 0],
      [0.5, 0.2, 0],
    ]);
    expect(wide?.conditioning).toBeGreaterThan(slender?.conditioning ?? Infinity);
  });

  it('has no pattern for two coincident points with a third apart (rank 5: a rotation about the line is free)', () => {
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ).toBeNull();
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [1, 2, 3],
        [1, 2, 3],
      ]),
    ).toBeNull();
  });

  it('has no pattern for non-finite points (NaN or infinite spread) instead of a NaN conditioning', () => {
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [Number.NaN, 0, 0],
        [0, 1, 0],
      ]),
    ).toBeNull();
    expect(
      bestSupportPattern([
        [0, 0, 0],
        [Infinity, 0, 0],
        [0, 1, 0],
      ]),
    ).toBeNull();
  });
});
