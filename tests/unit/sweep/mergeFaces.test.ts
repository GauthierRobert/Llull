/** LIM-1: the cubic edge faces of a station ring are joined into FACE_GROUPS faces that equal them exactly. */
import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import type { NurbsSurfaceData } from '@core/lib/nurbs/surfaceTypes';
import { evaluateSurface } from '@core/lib/nurbs/surface';
import { FACE_GROUPS, mergeEdgeFaces } from '@core/geometry/sweepEval/mergeFaces';

/** A cubic edge face over two v-columns (z = 0 and z = 1) whose u rows are the planar poles `row`. */
function edgeFace(row: ReadonlyArray<readonly [number, number]>): NurbsSurfaceData {
  return {
    degreeU: 3,
    degreeV: 1,
    poles: row.map(([x, y]): Vec3[] => [
      [x, y, 0],
      [x, y, 1],
    ]),
    knotsU: [0, 1],
    multiplicitiesU: [4, 4],
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  };
}

/** Four edges of a smooth ring (C1 at every junction: p3 - p2 = p1' - p0'). */
const SMOOTH = [
  edgeFace([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]),
  edgeFace([
    [3, 0],
    [4, 0],
    [5, 1],
    [5, 2],
  ]),
  edgeFace([
    [5, 2],
    [5, 3],
    [4, 4],
    [3, 4],
  ]),
  edgeFace([
    [3, 4],
    [2, 4],
    [1, 4],
    [0, 4],
  ]),
];
/** The same ring with the second edge kinked at its start (C0 junction). */
const KINKED = [
  SMOOTH[0] as NurbsSurfaceData,
  edgeFace([
    [3, 0],
    [3, 1],
    [5, 1],
    [5, 2],
  ]),
  SMOOTH[2] as NurbsSurfaceData,
  SMOOTH[3] as NurbsSurfaceData,
];

const at = (face: NurbsSurfaceData, u: number, v: number): readonly number[] => [...evaluateSurface(face, u, v)];

describe('mergeEdgeFaces', () => {
  it.each([
    ['a C1 ring (double knots)', SMOOTH, 2],
    ['a kinked ring (a triple knot at the corner)', KINKED, 3],
  ])('joins %s into FACE_GROUPS faces equal to the edge faces', (_name, edges, junctionMultiplicity) => {
    const merged = mergeEdgeFaces(edges, 10);
    expect(merged).toHaveLength(FACE_GROUPS);
    const size = Math.ceil(edges.length / FACE_GROUPS);
    merged.forEach((face, g) => {
      const members = edges.slice(g * size, (g + 1) * size);
      for (const [k, edge] of members.entries())
        for (const s of [0, 0.3, 0.7, 1])
          for (const v of [0, 0.5, 1]) {
            const u = (k + s) / members.length;
            at(face, u, v).forEach((value, axis) => expect(value).toBeCloseTo(at(edge, s, v)[axis] as number, 10));
          }
    });
    if (edges === KINKED) expect(merged[0]?.multiplicitiesU[1]).toBe(junctionMultiplicity);
    if (edges === SMOOTH) expect(merged[0]?.multiplicitiesU[1]).toBe(junctionMultiplicity);
  });

  it('shares the boundary pole rows of neighbouring groups', () => {
    const [a, b] = mergeEdgeFaces(SMOOTH, 10) as [NurbsSurfaceData, NurbsSurfaceData];
    expect(a.poles[a.poles.length - 1]).toEqual(b.poles[0]);
  });

  it('leaves rational, lower-degree and short rings alone', () => {
    expect(mergeEdgeFaces(SMOOTH.slice(0, 3), 10)).toHaveLength(3);
    const rational = {
      ...(SMOOTH[0] as NurbsSurfaceData),
      weights: [
        [1, 1],
        [1, 1],
        [1, 1],
        [1, 1],
      ],
    };
    expect(mergeEdgeFaces([rational, ...SMOOTH.slice(1)], 10)).toHaveLength(4);
    expect(
      mergeEdgeFaces(
        SMOOTH.map((face) => ({ ...face, degreeU: 2 })),
        10,
      ),
    ).toHaveLength(4);
  });
});
