/**
 * BLD M5 leg readback of check_blends (13.24) over a stub kernel whose contact lines sit at known distances from the edge: the legs are read in the plane perpendicular to the edge at each station,
 * a leg off its law is BLD_CHECK_CHAMFER_LEGS, and every case the kernel cannot answer is a row with a reason (never a pass). The native values are in server/tests/nativeChamferCurved.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { readChamferLegs } from '@core/commands/brep/checkChamferLegs';
import { createEmptyDocument, type ShapeRecipe, type Vec3 } from '@core/model/types';
import { chamferNodes } from '@core/geometry/blend/blendInfo';
import { SOURCE, chamfer, entityOf, stub } from '../helpers/chamferLegsKernel';

afterEach(() => setGeometryKernel(null));

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
    ['crossing', 'not verified'],
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

  it('a distance-angle chamfer: the second leg is d sin(a) / sin(phi + a) of the dihedral at the station (a right angle: d tan 30 = 0.5774), not the first leg; a wrong leg fails, no normals leave it unverified', () => {
    const angled = entityOf(chamfer({ sizeEnd: undefined, size2: undefined, size2End: undefined, angleDeg: 30, size: 1 }));
    const right: readonly [Vec3, Vec3] = [
      [0, 0, 1],
      [0, 1, 0],
    ];
    const good = readChamferLegs(stub({ normals: right, first: () => 1, second: () => Math.tan(Math.PI / 6) }), angled, 'mm');
    expect(good.findings).toEqual([]);
    expect(good.rows[0]?.maxDeviation).toBeLessThan(1e-9);
    expect(good.rows[0]?.legs[0]).toMatchObject({ first: 1, expectedSecond: 0.5773502692 });
    expect(good.rows[0]?.requested).toMatchObject({ second: { angleDeg: 30 } });
    // the second leg equal to the first (what a symmetric reading would expect) is off the law
    const wrong = readChamferLegs(stub({ normals: right, first: () => 1, second: () => 1 }), angled, 'mm');
    expect(wrong.findings.map((finding) => finding.code)).toEqual(['BLD_CHECK_CHAMFER_LEGS']);
    // a dihedral of 120 degrees between the faces (normals 60 apart): phi = 120, expected sin(30) / sin(150) = 1
    const open: readonly [Vec3, Vec3] = [
      [0, 0, 1],
      [0, Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)],
    ];
    const obtuse = readChamferLegs(stub({ normals: open, first: () => 1, second: () => 1 }), angled, 'mm');
    expect(obtuse.findings).toEqual([]);
    // without face normals only the first leg can be compared: a row with a reason, never a pass
    const blind = readChamferLegs(stub({ first: () => 1, second: () => 0.5 }), angled, 'mm');
    expect(blind.rows[0]?.note).toContain('only the first leg is compared');
    expect(blind.findings).toEqual([]);
  });

  it('check_blends counts a row it could not verify as a warning and, with nothing measured, as not_run; a measured chamfer next to it keeps its status', () => {
    setGeometryKernel(stub({ missing: 'contact' }));
    const withEntity = {
      ...createEmptyDocument(),
      entities: { m: { ...entityOf(chamfer()), mesh: { positions: [], indices: [] } } as never },
      order: ['m'],
    };
    const read = execute(withEntity as never, 'check_blends', {});
    const info = read.data as { status: string; findings: Array<{ code: string; severity: string }>; unverified: number };
    expect(info.status).toBe('not_run');
    expect(info.findings).toEqual([expect.objectContaining({ code: 'BLD_CHECK_CHAMFER_UNVERIFIED', severity: 'warn' })]);
    expect(info.unverified).toBe(1);
    setGeometryKernel(stub());
    expect((execute(withEntity as never, 'check_blends', {}).data as { status: string; unverified: number }).status).toBe('pass');
  });

  it('a polyline of 200 samples of a circle R 50 is read to the leg 0.5 within 1e-4 (the chord sag of a linear crossing is 3e-3), and the leg on the cylinder side to the same', () => {
    const radius = 50;
    const circle = (r: number, z: number, count: number): Vec3[] =>
      Array.from(
        { length: count },
        (_, k): Vec3 => [r * Math.cos((Math.PI * k) / (count - 1)), r * Math.sin((Math.PI * k) / (count - 1)), z],
      );
    const stations = circle(radius, 0, 21);
    const sample = (point: Vec3, k: number, count: number): Record<string, unknown> => {
      const angle = (Math.PI * k) / (count - 1);
      return {
        t: k / (count - 1),
        s: (Math.PI * radius * k) / (count - 1),
        point,
        tangent: [-Math.sin(angle), Math.cos(angle), 0] as Vec3,
        curvature: 0,
        dCurvatureDs: 0,
        torsion: 0,
        normal: [0, 0, 1] as Vec3,
      };
    };
    const kernel = stub() as unknown as { faceQuery: { edgeSamples: (shape: { id: string }, edge: number) => unknown } };
    const arc = {
      ...kernel,
      faceQuery: {
        ...kernel.faceQuery,
        edgeSamples: (shape: { id: string }, edge: number) =>
          shape.id === 'source'
            ? stations.map((point, k) => sample(point, k, 21))
            : circle(edge === 0 ? radius - 0.5 : radius, edge === 0 ? 0 : -2, 200).map((point, k) => sample(point, k, 200)),
      },
    } as unknown as GeometryKernel;
    const { rows, findings } = readChamferLegs(arc, entityOf(chamfer({ sizeEnd: 0.5, size: 0.5, size2: 2, size2End: 2 })), 'mm');
    expect(findings).toEqual([]);
    expect(rows[0]?.maxDeviation).toBeLessThan(1e-4);
    expect(rows[0]?.skipped).toBe(0);
  });

  it('stations the contact lines do not cross are counted (skipped) and, above a quarter of them, make the row unverified', () => {
    const partly = (limit: number): ReturnType<typeof stub> => {
      const base = stub() as unknown as { faceQuery: { edgeSamples: (shape: { id: string }, edge: number) => Array<{ point: Vec3 }> } };
      return {
        ...base,
        faceQuery: {
          ...base.faceQuery,
          // the contact lines end at x = limit: the stations beyond it have no crossing
          edgeSamples: (shape: { id: string }, edge: number) =>
            base.faceQuery.edgeSamples(shape, edge).filter((sample) => shape.id === 'source' || sample.point[0] <= limit),
        },
      } as unknown as ReturnType<typeof stub>;
    };
    const few = readChamferLegs(partly(9.7), entityOf(chamfer()), 'mm');
    expect(few.rows[0]?.skipped).toBe(1);
    expect(few.rows[0]?.note).toBeUndefined();
    const many = readChamferLegs(partly(5), entityOf(chamfer()), 'mm');
    expect(many.rows[0]?.skipped).toBeGreaterThan(5);
    expect(many.rows[0]?.note).toContain('not verified');
  });
});
