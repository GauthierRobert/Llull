import { describe, expect, it } from 'vitest';
import { COMPRESSED, FOLDED, NEUTRAL, STRETCHED, jacobianColor, parseJacobianMap } from '@ui/viewport/3d/overlays/jacobianColors';

describe('jacobianColor', () => {
  it('is neutral at 1, saturates at a factor of two either way (log scale) and is symmetric between 0.5 and 2', () => {
    expect(jacobianColor(1, 1e-6)).toEqual(NEUTRAL);
    expect(jacobianColor(2, 1e-6)).toEqual(STRETCHED);
    expect(jacobianColor(0.5, 1e-6)).toEqual(COMPRESSED);
    expect(jacobianColor(100, 1e-6)).toEqual(STRETCHED);
    expect(jacobianColor(1e-3, 1e-6)).toEqual(COMPRESSED);
    const half = jacobianColor(Math.SQRT2, 1e-6);
    expect(half[0]).toBeCloseTo((NEUTRAL[0] + STRETCHED[0]) / 2, 9);
  });
  it('a determinant at or below the floor, or NaN, is folded', () => {
    expect(jacobianColor(0, 1e-6)).toEqual(FOLDED);
    expect(jacobianColor(-3, 1e-6)).toEqual(FOLDED);
    expect(jacobianColor(1e-6, 1e-6)).toEqual(FOLDED);
    expect(jacobianColor(Number.NaN, 1e-6)).toEqual(FOLDED);
  });
});

describe('parseJacobianMap', () => {
  const good = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    determinant: [1, 2, -1],
    floor: 1e-6,
    min: -1,
    max: 2,
    folded: 1,
  };
  it('builds the buffers of the answer: one colour per vertex, folded in magenta', () => {
    const view = parseJacobianMap(good);
    expect(view?.positions).toHaveLength(9);
    expect(Array.from(view?.indices ?? [])).toEqual([0, 1, 2]);
    expect(Array.from(view?.colors.slice(6, 9) ?? [])).toEqual([...FOLDED]);
    expect(view).toMatchObject({ min: -1, max: 2, folded: 1 });
  });
  it('rejects data that is not a map: wrong type, lengths that disagree, a triangle past the vertices, no floor', () => {
    expect(parseJacobianMap(null)).toBeNull();
    expect(parseJacobianMap('x')).toBeNull();
    expect(parseJacobianMap({ ...good, positions: [0, 0, 0] })).toBeNull();
    expect(parseJacobianMap({ ...good, indices: [0, 1, 3] })).toBeNull();
    expect(parseJacobianMap({ ...good, indices: [0, 1] })).toBeNull();
    expect(parseJacobianMap({ ...good, floor: undefined })).toBeNull();
    expect(parseJacobianMap({ ...good, min: undefined, max: undefined, folded: undefined })).toMatchObject({
      min: null,
      max: null,
      folded: 0,
    });
  });
});
