/**
 * BLD M5 leg readback of check_blends (13.24) over a stub kernel whose contact lines sit at known distances from the edge: the legs are read in the plane perpendicular to the edge at each station,
 * a leg off its law is BLD_CHECK_CHAMFER_LEGS, and every case the kernel cannot answer is a row with a reason (never a pass). The native values are in server/tests/nativeChamferCurved.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { readChamferLegs } from '@core/commands/brep/checkChamferLegs';
import { createEmptyDocument, type MeshSolidEntity, type ShapeRecipe, type Vec3 } from '@core/model/types';
import { chamferNodes } from '@core/geometry/blend/blendInfo';

afterEach(() => setGeometryKernel(null));

const SOURCE: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
const chamfer = (extra: Record<string, unknown> = {}): ShapeRecipe =>
  ({ op: 'chamfer', source: SOURCE, edges: [0], size: 1, sizeEnd: 2, faces: [0], size2: 2, size2End: 4, ...extra }) as ShapeRecipe;
const entityOf = (brep: ShapeRecipe): MeshSolidEntity => ({ id: 'm', kind: 'mesh', brep }) as never;

/** The edge runs along x from 0 to 10; contact line k lies at the distance `legs[k](x)` from it in the plane perpendicular to x. */
function stub(
  options: {
    first?: (x: number) => number;
    second?: (x: number) => number;
    missing?: 'chamfer' | 'contact' | 'graph' | 'names' | 'build' | 'crossing';
  } = {},
): GeometryKernel {
  const first = options.first ?? ((x: number) => 1 + x / 10);
  const second = options.second ?? ((x: number) => 2 + (2 * x) / 10);
  const line = (offset: (x: number) => number, direction: Vec3): Vec3[] =>
    Array.from({ length: 41 }, (_, k): Vec3 => [k / 4, direction[1] * offset(k / 4), direction[2] * offset(k / 4)]);
  const sourceTopology = {
    solids: 1,
    vertices: 0,
    volume: 1,
    faces: [
      { index: 0, name: options.missing === 'names' ? undefined : 'top', surface: 'plane', area: 1 },
      { index: 1, name: options.missing === 'names' ? undefined : 'side', surface: 'plane', area: 1 },
    ],
    edges: [{ index: 0, name: 'E', curve: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0], mid: [5, 0, 0] }],
  };
  const resultTopology = {
    ...sourceTopology,
    faces: [
      { index: 0, name: 'top', surface: 'plane', area: 1 },
      { index: 1, name: 'side', surface: 'plane', area: 1 },
      { index: 2, name: options.missing === 'chamfer' ? 'chamfer(other)' : 'chamfer(E)', surface: 'plane', area: 1 },
    ],
    edges: [0, 1].map((index) => ({
      index,
      name: `c${index}`,
      curve: 'line',
      length: 10,
      start: [0, 0, 0],
      end: [10, 0, 0],
      mid: [5, 0, 0],
    })),
  };
  const query = {
    faceGraph: (shape: { id: string }) =>
      options.missing === 'graph' && shape.id === 'result'
        ? null
        : shape.id === 'source'
          ? { faces: [], edgeFaces: [[0, 1]], edgeConvexity: ['convex'] }
          : {
              faces: [{ loops: [] }, { loops: [] }, { loops: [options.missing === 'contact' ? [0] : [0, 1]] }],
              edgeFaces: [
                [2, 0],
                [2, 1],
              ],
              edgeConvexity: ['smooth', 'smooth'],
            },
    edgeSamples: (shape: { id: string }, edge: number) =>
      shape.id === 'source'
        ? Array.from({ length: 21 }, (_, k) => ({
            t: k / 20,
            s: (10 * k) / 20,
            point: [k / 2, 0, 0] as Vec3,
            tangent: [1, 0, 0] as Vec3,
            curvature: 0,
            dCurvatureDs: 0,
            torsion: 0,
            normal: [0, 1, 0] as Vec3,
          }))
        : line(edge === 0 ? first : second, edge === 0 ? [0, 0, 1] : [0, 1, 0]).map((point, k) => ({
            t: k / 40,
            s: k / 4,
            point: options.missing === 'crossing' ? ([point[0] + 100, point[1], point[2]] as Vec3) : point,
            tangent: [1, 0, 0] as Vec3,
            curvature: 0,
            dCurvatureDs: 0,
            torsion: 0,
            normal: [0, 1, 0] as Vec3,
          })),
  };
  return {
    name: 'stub',
    evaluate: (recipe: ShapeRecipe) => (options.missing === 'build' ? null : recipe.op === 'chamfer' ? { id: 'result' } : { id: 'source' }),
    topology: (shape: { id: string }) => (shape.id === 'source' ? sourceTopology : resultTopology),
    faceQuery: query,
  } as unknown as GeometryKernel;
}

describe('chamferNodes', () => {
  it('finds the variable and asymmetric chamfer nodes (through booleans), not a constant one, outermost first', () => {
    const constant: ShapeRecipe = { op: 'chamfer', source: SOURCE, edges: [0], size: 1 };
    expect(chamferNodes(constant)).toEqual([]);
    expect(chamferNodes(chamfer())).toHaveLength(1);
    expect(
      chamferNodes({
        op: 'boolean',
        boolean: 'union',
        a: chamfer({ faces: undefined, size2: undefined, size2End: undefined }),
        b: chamfer(),
      }),
    ).toHaveLength(2);
    expect(chamferNodes({ op: 'shell', source: chamfer(), thickness: 1 })).toHaveLength(1);
    expect(chamferNodes({ op: 'blend', sources: [chamfer()], radius: 1 })).toHaveLength(1);
  });
});

describe('readChamferLegs', () => {
  it('reads each leg in the plane perpendicular to the edge at every station and compares it with its law: a pass within the tolerance', () => {
    const { rows, findings } = readChamferLegs(stub(), entityOf(chamfer()), 'mm');
    expect(findings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ edge: 0, name: 'E', face: 2, requested: { first: [1, 2], second: [2, 4] } });
    expect(rows[0]?.legs).toHaveLength(21);
    expect(rows[0]?.legs[0]).toMatchObject({ s: 0, first: 1, second: 2, expectedFirst: 1, expectedSecond: 2 });
    expect(rows[0]?.legs[20]).toMatchObject({ s: 1, first: 2, second: 4 });
    expect(rows[0]?.maxDeviation).toBeLessThan(1e-12);
  });

  it('a leg off its law is a BLD_CHECK_CHAMFER_LEGS failure naming the edge and the face, and check_blends turns it into a fail status', () => {
    const off = stub({ first: () => 1.5 });
    const { rows, findings } = readChamferLegs(off, entityOf(chamfer()), 'mm');
    expect(rows[0]?.maxDeviation).toBeCloseTo(0.5, 9);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'BLD_CHECK_CHAMFER_LEGS', severity: 'fail', entityId: 'm', edge: 0, face: 2, limit: 1e-3 });
    setGeometryKernel(off);
    const doc = createEmptyDocument();
    const withEntity = { ...doc, entities: { m: { ...entityOf(chamfer()), mesh: { positions: [], indices: [] } } as never }, order: ['m'] };
    const read = execute(withEntity as never, 'check_blends', {});
    expect((read.data as { status: string; findings: Array<{ code: string }>; chamfers: unknown[] }).status).toBe('fail');
    expect((read.data as { findings: Array<{ code: string }> }).findings.map((f) => f.code)).toContain('BLD_CHECK_CHAMFER_LEGS');
    expect((read.data as { chamfers: unknown[] }).chamfers).toHaveLength(1);
    const named = execute(withEntity as never, 'check_blends', { ids: ['m'] });
    expect((named.data as { status: string }).status).toBe('fail');
  });

  it('a symmetric variable chamfer (no faces) compares both legs with the one law', () => {
    const { rows, findings } = readChamferLegs(
      stub({ second: (x) => 1 + x / 10 }),
      entityOf(chamfer({ faces: undefined, size2: undefined, size2End: undefined })),
      'mm',
    );
    expect(findings).toEqual([]);
    expect(rows[0]?.requested).toEqual({ first: [1, 2], second: [1, 2] });
    expect(rows[0]?.maxDeviation).toBeLessThan(1e-12);
  });

  it.each([
    ['build', 'could not rebuild'],
    ['chamfer', 'no face named chamfer(E)'],
    ['names', 'does not join two named faces'],
    ['contact', 'could not be read'],
    ['crossing', 'do not cross the planes'],
    ['graph', 'could not rebuild'],
  ] as const)('%s: a row with the reason and no pass', (missing, reason) => {
    const { rows, findings } = readChamferLegs(stub({ missing }), entityOf(chamfer()), 'mm');
    expect(findings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.maxDeviation).toBeNull();
    expect(rows[0]?.note).toContain(reason);
  });

  it('a kernel without face queries, or an entity without a recipe, reads nothing', () => {
    const kernel = { ...stub(), faceQuery: undefined } as unknown as GeometryKernel;
    expect(readChamferLegs(kernel, entityOf(chamfer()), 'mm')).toEqual({ rows: [], findings: [] });
    expect(readChamferLegs(stub(), { id: 'x', kind: 'box' } as never, 'mm')).toEqual({ rows: [], findings: [] });
  });
});
