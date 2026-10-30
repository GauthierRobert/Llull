/** 01 DEF §17.4: `deform_lattice` on a B-spline lattice (local control) and an oriented box, on the mesh path, against closed forms and the shared pack. The native exact warp: server/tests/nativeKernelLattice.test.ts. */

import { afterEach, describe, expect, it } from 'vitest';
import type { DeformLaw } from '@core/model/deform';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { determinantBounds, fromBoxCoordinates, latticeDeterminant, latticeMap, restPosition } from '@core/geometry/deform/lattice';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type AnalysisData, type KernelKind, WORLD_Z, addBox, dataOf, installKernel, meshEntity, relative, volumeOf } from './harness';
import { packData } from './packPaths';

const KERNELS: KernelKind[] = ['none', 'manifold'];
type LatticeLaw = Extract<DeformLaw, { kind: 'lattice' }>;

interface Pack {
  readonly laws: Record<string, { params: Record<string, unknown>; points: Array<{ in: Vec3; out: Vec3; det?: number }> }>;
}

afterEach(() => setGeometryKernel(null));

function lawOfPack(params: Record<string, unknown>): LatticeLaw {
  const box = { min: params['min'] as Vec3, max: params['max'] as Vec3 };
  const moved = params['moved'] as Array<{ index: [number, number, number]; delta: Vec3 }>;
  return {
    kind: 'lattice',
    box,
    degrees: params['degrees'] as [number, number, number],
    offsets: moved.map(({ index, delta }) => ({ index, delta })),
    ...(params['splineDegrees'] === undefined ? {} : { splineDegrees: params['splineDegrees'] as [number, number, number] }),
    ...(params['axes'] === undefined ? {} : { axes: params['axes'] as [Vec3, Vec3, Vec3] }),
  };
}

describe('lattice laws against the validation pack (independent Cox-de Boor reference)', () => {
  const pack = packData<Pack>('point_vectors.json');
  it.each(['ffd_spline', 'ffd_oriented', 'ffd_spline_oriented'])('%s maps every golden point within 1e-9 and matches det J', (name) => {
    const entry = pack.laws[name] as Pack['laws'][string];
    const law = lawOfPack(entry.params);
    let withDeterminant = 0;
    for (const point of entry.points) {
      const image = latticeMap(law, point.in);
      image.forEach((value, axis) => expect(Math.abs(value - (point.out[axis] as number))).toBeLessThan(1e-9));
      if (point.det !== undefined) {
        withDeterminant++;
        expect(Math.abs(latticeDeterminant(law, point.in) - point.det)).toBeLessThan(1e-6);
      }
    }
    expect(withDeterminant).toBeGreaterThan(8);
  });
});

describe('an oriented lattice equals its aligned twin in the box coordinates (review: face nodes lost to the frame round trip)', () => {
  const pack = packData<Pack>('point_vectors.json');
  const twinOf = (oriented: LatticeLaw): LatticeLaw => {
    const axes = oriented.axes as [Vec3, Vec3, Vec3];
    const { axes: _unused, ...rest } = oriented;
    void _unused;
    return {
      ...rest,
      offsets: oriented.offsets.map(({ index, delta }) => ({
        index,
        delta: axes.map((row) => row[0] * delta[0] + row[1] * delta[1] + row[2] * delta[2]) as unknown as Vec3,
      })),
    };
  };
  it.each(['ffd_oriented', 'ffd_spline_oriented'])(
    '%s: the det J bounds and the determinant at every face node agree with the twin',
    (name) => {
      const oriented = lawOfPack((pack.laws[name] as Pack['laws'][string]).params);
      const twin = twinOf(oriented);
      const [a, b] = [determinantBounds(oriented), determinantBounds(twin)];
      expect(a.boundMin).toBeCloseTo(b.boundMin, 9);
      expect(a.boundMax).toBeCloseTo(b.boundMax, 9);
      expect(a.sampledMin).toBeCloseTo(b.sampledMin, 9);
      expect(a.sampledMax).toBeCloseTo(b.sampledMax, 9);
      // every node of a 9 x 9 x 9 grid of the box, the faces included: the same det J through the frame as in the box coordinates
      let nodes = 0;
      for (let i = 0; i < 9; i++)
        for (let j = 0; j < 9; j++)
          for (let k = 0; k < 9; k++) {
            const c: Vec3 = [0, 1, 2].map((axis) => {
              const s = [i, j, k][axis] as number;
              return (
                (oriented.box.min[axis] as number) + (s / 8) * ((oriented.box.max[axis] as number) - (oriented.box.min[axis] as number))
              );
            }) as unknown as Vec3;
            expect(latticeDeterminant(oriented, fromBoxCoordinates(oriented, c))).toBeCloseTo(latticeDeterminant(twin, c), 9);
            nodes++;
          }
      expect(nodes).toBe(729);
    },
  );
});

describe('B-spline lattice (closed forms)', () => {
  const base = {
    kind: 'lattice' as const,
    box: { min: [0, 0, 0] as Vec3, max: [10, 10, 100] as Vec3 },
    degrees: [2, 2, 6] as [number, number, number],
  };

  it('control points rest on the Greville abscissae; Bernstein ones at i / net', () => {
    expect(restPosition({ degrees: [2, 2, 6] }, 2, 3)).toBeCloseTo(0.5, 12);
    expect(restPosition({ degrees: [2, 2, 6], splineDegrees: [2, 2, 2] }, 2, 0)).toBe(0);
    expect(restPosition({ degrees: [2, 2, 6], splineDegrees: [2, 2, 2] }, 2, 6)).toBe(1);
    expect(restPosition({ degrees: [2, 2, 6], splineDegrees: [2, 2, 2] }, 2, 1)).toBeCloseTo(0.1, 12);
    expect(restPosition({ degrees: [2, 2, 6], splineDegrees: [2, 2, 3] }, 2, 2)).toBeCloseTo((0 + 0.25 + 0.5) / 3, 12);
  });

  it('no offsets is the identity and a constant offset is a translation, on every span (linear precision)', () => {
    const moveAll = (delta: Vec3): LatticeLaw['offsets'] =>
      Array.from({ length: 3 * 3 * 7 }, (_, n) => ({
        index: [Math.floor(n / 21), Math.floor(n / 7) % 3, n % 7] as [number, number, number],
        delta,
      }));
    const identity: LatticeLaw = { ...base, splineDegrees: [2, 2, 2], offsets: [] };
    const shifted: LatticeLaw = { ...base, splineDegrees: [2, 2, 2], offsets: moveAll([1, -2, 3]) };
    for (const q of [
      [1, 2, 3],
      [5, 5, 50],
      [9.5, 0.5, 99],
      [3, 7, 20.5],
    ] as Vec3[]) {
      latticeMap(identity, q).forEach((v, a) => expect(v).toBeCloseTo(q[a] as number, 12));
      latticeMap(shifted, q).forEach((v, a) => expect(v).toBeCloseTo((q[a] as number) + [1, -2, 3][a]!, 12));
    }
  });

  it('local control: a control point moves only the body inside its support; the Bernstein lattice moves everything', () => {
    const offsets: LatticeLaw['offsets'] = [{ index: [1, 1, 3], delta: [2, 0, 0] }];
    const spline: LatticeLaw = { ...base, splineDegrees: [2, 2, 2], offsets };
    const bezier: LatticeLaw = { ...base, offsets };
    // z support of control 3 (p = 2, 7 points): knots 1/5 .. 4/5, i.e. z in [20, 80]
    for (const z of [0, 5, 19.9, 80.1, 95, 100]) expect(latticeMap(spline, [5, 5, z])).toEqual([5, 5, z]);
    for (const z of [5, 19.9, 80.1, 95]) expect(Math.abs(latticeMap(bezier, [5, 5, z])[0] - 5)).toBeGreaterThan(0);
    expect(latticeMap(spline, [5, 5, 50])[0]).toBeGreaterThan(5.3);
  });

  it('the det J enclosure per knot span contains the sampled values, a Bernstein lattice of the same degree equals p = net', () => {
    const offsets: LatticeLaw['offsets'] = [{ index: [1, 1, 3], delta: [2, 1, 0] }];
    const spline: LatticeLaw = { ...base, splineDegrees: [2, 2, 2], offsets };
    const bounds = determinantBounds(spline);
    expect(bounds.boundMin).toBeLessThanOrEqual(bounds.sampledMin + 1e-9);
    expect(bounds.boundMax).toBeGreaterThanOrEqual(bounds.sampledMax - 1e-9);
    const equal: LatticeLaw = { ...base, degrees: [2, 2, 2], splineDegrees: [2, 2, 2], offsets: [{ index: [1, 1, 1], delta: [2, 1, 0] }] };
    const bezier: LatticeLaw = { ...equal };
    delete (bezier as { splineDegrees?: unknown }).splineDegrees;
    for (const q of [
      [1, 2, 3],
      [5, 5, 50],
      [9, 9, 90],
    ] as Vec3[])
      latticeMap(equal, q).forEach((v, a) => expect(v).toBeCloseTo(latticeMap(bezier, q)[a] as number, 12));
  });

  it('the sampled det J extremes of a B-spline lattice are those of a dense grid (not only of the interpolation nodes)', () => {
    const offsets: LatticeLaw['offsets'] = [
      { index: [1, 1, 3], delta: [3.1, 1.7, 0] },
      { index: [1, 0, 2], delta: [-2, 0.8, 0.5] },
    ];
    const spline: LatticeLaw = { ...base, splineDegrees: [2, 2, 2], offsets };
    const bounds = determinantBounds(spline);
    let [min, max] = [Infinity, -Infinity];
    const N = 31;
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        for (let k = 0; k < N; k++) {
          const q: Vec3 = [(10 * i) / (N - 1), (10 * j) / (N - 1), (100 * k) / (N - 1)];
          const value = latticeDeterminant(spline, q);
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
    expect(bounds.sampledMin).toBeLessThanOrEqual(min + 1e-9);
    expect(bounds.sampledMax).toBeGreaterThanOrEqual(max - 1e-9);
    expect(bounds.boundMin).toBeLessThanOrEqual(bounds.sampledMin + 1e-9);
  });

  it('an oriented box measures c = A q: the point of box coordinates (0.5, 0.5, 0.5) is the middle of the rotated box', () => {
    const axes: [Vec3, Vec3, Vec3] = [
      [Math.SQRT1_2, Math.SQRT1_2, 0],
      [0, 0, 1],
      [Math.SQRT1_2, -Math.SQRT1_2, 0],
    ];
    fromBoxCoordinates({ axes }, [Math.SQRT2, 3, 0]).forEach((v, k) => expect(v).toBeCloseTo([1, 1, 3][k] as number, 12));
  });

  it('a recipe node validates splineDegrees and axes', () => {
    const node = (patch: Record<string, unknown>): unknown => ({
      op: 'deform',
      source: { op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' },
      law: { ...base, offsets: [], ...patch },
      frame: WORLD_Z,
      output: { mode: 'mesh', tolerance: 0.01, preserveAnalytic: false },
    });
    expect(validateShapeRecipe(node({ splineDegrees: [2, 2, 3] }))).toBeNull();
    expect(validateShapeRecipe(node({ splineDegrees: [1, 2, 3] }))).toContain('splineDegrees');
    expect(validateShapeRecipe(node({ splineDegrees: [3, 2, 3] }))).toContain('splineDegrees');
    expect(
      validateShapeRecipe(
        node({
          axes: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        }),
      ),
    ).toBeNull();
    expect(
      validateShapeRecipe(
        node({
          axes: [
            [1, 0, 0],
            [1, 0, 0],
            [0, 0, 1],
          ],
        }),
      ),
    ).toContain('axes');
  });
});

describe.each(KERNELS)('deform_lattice with splineDegrees and orientation, kernel: %s', (kind) => {
  const bar = (): { doc: CadDocument; id: string } => addBox([10, 10, 100]);
  const BOX = { min: [-5, -5, 0], max: [5, 5, 100] };

  it('a B-spline lattice moves only the part of the body under the control point; the Bernstein one moves all of it', async () => {
    await installKernel(kind);
    const { doc, id } = bar();
    const params = {
      id,
      degrees: [2, 2, 6],
      box: BOX,
      frame: WORLD_Z,
      moves: [{ index: [1, 1, 3], delta: [2, 0, 0] }],
      output: { tolerance: 0.01 },
    };
    const local = execute(doc, 'deform_lattice', { ...params, splineDegrees: [2, 2, 2] });
    expect(local.error, local.summary).toBeUndefined();
    const next = local.affected[0] as string;
    const positions = meshEntity(local.document, next).mesh.positions;
    let outside = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const z = positions[i + 2] as number;
      if (z < 19 || z > 81) {
        outside++;
        expect(Math.abs(positions[i] as number)).toBeLessThanOrEqual(5 + 1e-9);
        expect(Math.abs(positions[i + 1] as number)).toBeLessThanOrEqual(5 + 1e-9);
      }
    }
    expect(outside).toBeGreaterThan(8);
    expect(meshEntity(local.document, next).brep).toMatchObject({ law: { kind: 'lattice', splineDegrees: [2, 2, 2] } });
    const analysis = dataOf<AnalysisData>(execute(local.document, 'analyze_deformation', { id: next }));
    expect(analysis.jacobian.bound.min).toBeLessThanOrEqual(analysis.jacobian.min + 1e-9);
    expectPure(doc, () => execute(doc, 'deform_lattice', { ...params, splineDegrees: [2, 2, 2] }));
  });

  it('an oriented lattice moved by an affine map is that map: scaling world x by 1.2 scales the volume', async () => {
    await installKernel(kind);
    const { doc, id } = bar();
    // box axes: u = (1, 1, 0) / sqrt 2, v = z, w = u cross v = (1, -1, 0) / sqrt 2 (frame coordinates)
    const axes: [Vec3, Vec3, Vec3] = [
      [Math.SQRT1_2, Math.SQRT1_2, 0],
      [0, 0, 1],
      [Math.SQRT1_2, -Math.SQRT1_2, 0],
    ];
    const box = { min: [-8, -1, -8] as Vec3, max: [8, 101, 8] as Vec3 };
    const moves: Array<{ index: [number, number, number]; delta: Vec3 }> = [];
    for (let i = 0; i <= 2; i++)
      for (let j = 0; j <= 2; j++)
        for (let k = 0; k <= 2; k++) {
          const c: Vec3 = [box.min[0] + (i / 2) * 16, box.min[1] + (j / 2) * 102, box.min[2] + (k / 2) * 16];
          const rest = fromBoxCoordinates({ axes }, c);
          moves.push({ index: [i, j, k], delta: [0.2 * rest[0], 0, 0] });
        }
    const result = execute(doc, 'deform_lattice', {
      id,
      degrees: [2, 2, 2],
      box,
      orientation: { uAxis: [1, 1, 0], vAxis: [0, 0, 1] },
      frame: WORLD_Z,
      moves,
      fixedLayers: 0,
      output: { tolerance: 0.01 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const next = result.affected[0] as string;
    expect(relative(volumeOf(result.document, next), 12000)).toBeLessThan(1e-6);
    const positions = meshEntity(result.document, next).mesh.positions;
    const xs = positions.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(6, 6);
    expect(Math.min(...xs)).toBeCloseTo(-6, 6);
    const stored = (meshEntity(result.document, next).brep as unknown as { law: LatticeLaw }).law.axes as [Vec3, Vec3, Vec3];
    stored.forEach((row, i) => row.forEach((v, k) => expect(v).toBeCloseTo(axes[i]?.[k] as number, 12)));
  });

  it('the default box of an oriented lattice is the body bounds along its axes; near picks the rest position of a spline net', async () => {
    await installKernel(kind);
    const { doc, id } = bar();
    const result = execute(doc, 'deform_lattice', {
      id,
      degrees: [3, 3, 3],
      splineDegrees: [2, 2, 2],
      orientation: { uAxis: [1, 1, 0], vAxis: [0, 0, 1] },
      frame: WORLD_Z,
      moves: [{ near: [0, 0, 50], delta: [0.5, 0.5, 0] }],
      fixedLayers: 0,
      output: { tolerance: 0.01 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const law = meshEntity(result.document, result.affected[0] as string).brep as unknown as { law: LatticeLaw };
    expect(law.law.box.min[0]).toBeCloseTo(-Math.SQRT2 * 5, 3);
    expect(law.law.box.max[1]).toBeCloseTo(100, 3);
    expect(law.law.offsets).toHaveLength(1);
    // near [0, 0, 50]: the box coordinates are (0, 50, 0), the middle of the box on u and w and the middle of v: Greville rest positions of 4 points are 0, 1/4... of the span
    expect(law.law.offsets[0]?.index[0]).toBeGreaterThanOrEqual(1);
    expect(law.law.offsets[0]?.index[1]).toBeGreaterThanOrEqual(1);
  });

  it('accepts spline degree 1 on an axis whose lattice degree is 1 (that is the Bernstein degree), 2 or more elsewhere', async () => {
    await installKernel(kind);
    const { doc, id } = bar();
    const result = execute(doc, 'deform_lattice', {
      id,
      degrees: [1, 2, 2],
      splineDegrees: [1, 2, 2],
      box: BOX,
      frame: WORLD_Z,
      moves: [{ index: [1, 1, 1], delta: [0.5, 0, 0] }],
      fixedLayers: 0,
    });
    expect(result.error, result.summary).toBeUndefined();
    expect(
      execute(doc, 'deform_lattice', {
        id,
        degrees: [3, 2, 2],
        splineDegrees: [1, 2, 2],
        box: BOX,
        frame: WORLD_Z,
        moves: [{ index: [1, 1, 1], delta: [1, 0, 0] }],
      }).error?.code,
    ).toBe('DEF_LATTICE_DEGREE');
  });

  it('refuses a spline degree outside 2..degree, a degenerate orientation and a fold, by name', async () => {
    await installKernel(kind);
    const { doc, id } = bar();
    const base = { id, degrees: [3, 3, 3], box: BOX, frame: WORLD_Z, moves: [{ index: [1, 1, 1], delta: [1, 0, 0] }] };
    expectNoOp(execute(doc, 'deform_lattice', { ...base, splineDegrees: [1, 2, 2] }), doc, 'DEF_LATTICE_DEGREE');
    expect(execute(doc, 'deform_lattice', { ...base, splineDegrees: [2, 4, 2] }).error?.code).toBe('DEF_LATTICE_DEGREE');
    expect(execute(doc, 'deform_lattice', { ...base, orientation: { uAxis: [0, 0, 0], vAxis: [0, 0, 1] } }).error?.code).toBe(
      'DEF_FRAME_DEGENERATE',
    );
    expect(execute(doc, 'deform_lattice', { ...base, orientation: { uAxis: [0, 0, 1], vAxis: [0, 0, 2] } }).error?.code).toBe(
      'DEF_FRAME_DEGENERATE',
    );
    const folded = execute(doc, 'deform_lattice', {
      ...base,
      degrees: [2, 2, 6],
      splineDegrees: [2, 2, 2],
      box: { min: [-5, -5, 0], max: [5, 5, 100] },
      moves: [{ index: [1, 1, 3], delta: [-60, 0, 0] }],
    });
    expect(folded.error?.code).toBe('DEF_FOLDOVER');
  });
});
