import { describe, expect, it } from 'vitest';
import { boxCage, cageProblem, cylinderCage, subdivide, type Cage } from '@core/geometry/subdivision';
import { edgeKey } from '@core/geometry/subd/edgeKey';
import { levelMeshVolume, levelQuadCount, limitVolumeEstimate } from '@core/geometry/subd/volume';
import {
  childEdgeSharpness,
  edgeSharpnessMap,
  partitionSharpness,
  uniformChild,
  vertexRule,
  vertexSharpnessArray,
} from '@core/geometry/subd/sharpness';

const cube = boxCage([2, 2, 2], [1, 1, 1]);
const edgesOf = (cage: Cage): Array<[number, number]> => {
  const edges = new Map<string, [number, number]>();
  for (const face of cage.faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      edges.set(edgeKey(a, b), [a, b]);
    });
  return [...edges.values()];
};
const sharpCube = (s: number): Cage => ({ ...cube, edgeSharpness: edgesOf(cube).map(([a, b]) => ({ a, b, s })) });

describe('Catmull-Clark with semi-sharp creases (VC-DIR-04, 05, 07)', () => {
  it('keeps the legacy volumes: smooth cube level 3 and an all-creased cube', () => {
    expect(levelMeshVolume(cube, 3)).toBeCloseTo(2.66462478968, 9);
    expect(levelMeshVolume({ ...cube, creases: edgesOf(cube) }, 4)).toBeCloseTo(8, 12);
  });
  it.each([
    [1, 6.31819142235],
    [2, 7.56419867056],
    [0.5, 4.23357576242],
  ])('every edge at sharpness %s, level 4', (s, volume) => {
    expect(levelMeshVolume(sharpCube(s), 4)).toBeCloseTo(volume, 9);
  });
  it('sharpness 1 equals one sharp step: the segmented box', () => {
    expect(levelMeshVolume(sharpCube(1), 4)).toBeCloseTo(levelMeshVolume(boxCage([2, 2, 2], [2, 2, 2]), 3), 9);
  });
  it('sharpness 10 is infinite, like the legacy creases', () => {
    expect(levelMeshVolume(sharpCube(10), 3)).toBeCloseTo(8, 12);
  });
  it('carries decayed sharpness into the refined cage (uniform and chaikin)', () => {
    const uniform = subdivide(sharpCube(3), 1);
    expect(uniform.edgeSharpness).toHaveLength(24);
    expect(uniform.edgeSharpness?.every((e) => e.s === 2)).toBe(true);
    const chaikin = subdivide({ ...sharpCube(3), creaseMethod: 'chaikin' }, 1);
    expect(chaikin.creaseMethod).toBe('chaikin');
    expect(chaikin.edgeSharpness?.every((e) => e.s > 0 && e.s < 3)).toBe(true);
    expect(subdivide(sharpCube(10), 2).creases).toHaveLength(48);
  });
  it('keeps a sharp corner in place and blends it back when the sharpness fades', () => {
    const refined = subdivide({ ...cube, vertexSharpness: [{ v: 0, s: 5 }] }, 1);
    expect(refined.vertices[0]).toEqual(cube.vertices[0]);
    expect(refined.vertexSharpness).toEqual([{ v: 0, s: 4 }]);
    const half = subdivide({ ...cube, vertexSharpness: [{ v: 0, s: 0.5 }] }, 1);
    const smooth = subdivide(cube, 1);
    const [corner, rounded, blended] = [cube.vertices[0], smooth.vertices[0], half.vertices[0]].map(
      (p) => (p as readonly number[])[0] as number,
    );
    expect(blended).toBeCloseTo(((corner as number) + (rounded as number)) / 2, 12);
    expect(half.vertexSharpness).toBeUndefined();
  });
  it('validates sharpness values and edges', () => {
    expect(cageProblem({ ...cube, edgeSharpness: [{ a: 0, b: 6, s: 1 }] })).toContain('not an edge');
    expect(cageProblem({ ...cube, edgeSharpness: [{ a: 0, b: 1, s: 11 }] })).toContain('sharpness');
    expect(cageProblem({ ...cube, vertexSharpness: [{ v: 99, s: 1 }] })).toContain('outside');
    expect(cageProblem({ ...cube, vertexSharpness: [{ v: 1, s: 0 }] })).toContain('sharpness');
    expect(cageProblem({ ...cube, edgeSharpness: [{ a: 0, b: 1, s: 2 }], vertexSharpness: [{ v: 1, s: 2 }] })).toBeNull();
  });
});

describe('sharpness helpers', () => {
  it('maps creases and semi-sharp edges, the larger value wins', () => {
    const map = edgeSharpnessMap({
      creases: [[0, 1]],
      edgeSharpness: [
        { a: 1, b: 0, s: 3 },
        { a: 2, b: 3, s: 4 },
      ],
    });
    expect(map.get(edgeKey(0, 1))).toBe(10);
    expect(map.get(edgeKey(2, 3))).toBe(4);
    expect(
      vertexSharpnessArray(
        {
          creases: [],
          vertexSharpness: [
            { v: 1, s: 2 },
            { v: 9, s: 1 },
          ],
        },
        3,
      ),
    ).toEqual([0, 2, 0]);
  });
  it('lowers sharpness per level', () => {
    expect([uniformChild(10), uniformChild(3), uniformChild(1), uniformChild(0.5)]).toEqual([10, 2, 0, 0]);
    expect(childEdgeSharpness(3, 'uniform', [4])).toBe(2);
    expect(childEdgeSharpness(3, 'chaikin', [])).toBe(2);
    expect(childEdgeSharpness(3, 'chaikin', [5])).toBeCloseTo(0.75 * 3 + 0.25 * 5 - 1, 12);
    expect(childEdgeSharpness(10, 'chaikin', [1])).toBe(10);
    expect(childEdgeSharpness(1, 'chaikin', [1])).toBe(0);
  });
  it('picks the vertex rule and partitions entries', () => {
    expect([vertexRule(0, 0), vertexRule(1, 0), vertexRule(2, 0), vertexRule(3, 0), vertexRule(0, 1)]).toEqual([
      'smooth',
      'smooth',
      'crease',
      'corner',
      'corner',
    ]);
    expect(
      partitionSharpness([
        [0, 1, 10],
        [1, 2, 3],
        [2, 3, 0],
      ]),
    ).toEqual({ creases: [[0, 1]], edgeSharpness: [{ a: 1, b: 2, s: 3 }] });
  });
});

describe('level meshes and the limit volume (VC-DIR-28 data)', () => {
  it('estimates the limit volume of the smooth cube', () => {
    const estimate = limitVolumeEstimate(cube);
    expect(estimate?.volume).toBeCloseTo(2.62041911579, 4);
    expect(estimate?.level).toBe(5);
  });
  it('declines when even level 2 is too large, and counts quads', () => {
    expect(limitVolumeEstimate(cube, 10)).toBeNull();
    expect(levelQuadCount(cube, 0)).toBe(6);
    expect(levelQuadCount(cube, 3)).toBe(6 * 4 ** 3);
    expect(levelQuadCount(cylinderCage(1, 2, 6, 1), 1)).toBe(6 * 4 + 6 + 6);
  });
});
