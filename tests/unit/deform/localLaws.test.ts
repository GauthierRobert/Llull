import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { buildFlowLaw, flowMap } from '@core/geometry/deform/flow';
import { type LatticeLaw, determinantBounds, latticeJacobian, latticeMap } from '@core/geometry/deform/lattice';
import { type PointLaw, determinantRange, foldLimit, pointDeterminant, pointMap } from '@core/geometry/deform/pointPush';
import { mapLocal, localDeterminant } from '@core/geometry/deform/laws';
import { predictedVolumeOf } from '@core/geometry/deform/predicted';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { Vec3 } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type AnalysisData, type KernelKind, type RunData, WORLD_Z, addBox, dataOf, installKernel, relative, volumeOf } from './harness';
import { packData } from './packPaths';
import { region } from './nodes';

afterEach(() => setGeometryKernel(null));

interface FfdCases {
  identity: { box: { min: Vec3; max: Vec3 }; degrees: [number, number, number]; maxResidual: number };
  affine: { matrix: Vec3[]; translation: Vec3; det: number; boxVolume: number; imageVolume: number };
  barrel: Array<{ m: number; volume: number; jacobianExactRange: [number, number]; jacobianBernsteinBound: [number, number] }>;
  foldover: { minJacobian: number; expectedCode: string };
}
const ffd = packData<FfdCases>('ffd_cases.json');

/** The unit-cube barrel of the pack: degrees [1, 1, 2], the middle layer of corners pushed out so the middle section scales by m. */
function barrel(m: number): LatticeLaw {
  const d = (m - 1) / 2;
  return {
    kind: 'lattice',
    box: { min: [0, 0, 0], max: [1, 1, 1] },
    degrees: [1, 1, 2],
    offsets: [
      { index: [0, 0, 1], delta: [-d, -d, 0] },
      { index: [1, 0, 1], delta: [d, -d, 0] },
      { index: [0, 1, 1], delta: [-d, d, 0] },
      { index: [1, 1, 1], delta: [d, d, 0] },
    ],
  };
}

describe('lattice law (VC-DEF-13, 14)', () => {
  it('is the identity without offsets and reproduces an affine map of the control points (Bernstein linear precision)', () => {
    const { box, degrees } = ffd.identity;
    const none: LatticeLaw = { kind: 'lattice', box, degrees, offsets: [] };
    const probes: Vec3[] = [
      [-5, -10, 0],
      [0, 0, 20],
      [3.3, 7.1, 39.9],
    ];
    for (const p of probes) latticeMap(none, p).forEach((value, a) => expect(Math.abs(value - (p[a] as number))).toBeLessThan(1e-12));
    const { matrix, translation } = ffd.affine;
    const offsets: LatticeLaw['offsets'][number][] = [];
    for (let i = 0; i <= degrees[0]; i++)
      for (let j = 0; j <= degrees[1]; j++)
        for (let k = 0; k <= degrees[2]; k++) {
          const p: Vec3 = [
            box.min[0] + ((box.max[0] - box.min[0]) * i) / degrees[0],
            box.min[1] + ((box.max[1] - box.min[1]) * j) / degrees[1],
            box.min[2] + ((box.max[2] - box.min[2]) * k) / degrees[2],
          ];
          const image = matrix.map((row, r) => row[0]! * p[0] + row[1]! * p[1] + row[2]! * p[2] + translation[r]!) as unknown as Vec3;
          offsets.push({ index: [i, j, k], delta: [image[0] - p[0], image[1] - p[1], image[2] - p[2]] });
        }
    const affine: LatticeLaw = { kind: 'lattice', box, degrees, offsets };
    for (const p of probes) {
      const image = matrix.map((row, r) => row[0]! * p[0] + row[1]! * p[1] + row[2]! * p[2] + translation[r]!);
      latticeMap(affine, p).forEach((value, a) => expect(Math.abs(value - (image[a] as number))).toBeLessThan(1e-9));
    }
    const rows = latticeJacobian(affine, [1, 2, 3]);
    expect(rows[0]![0]).toBeCloseTo(matrix[0]![0]!, 10);
  });

  it.each([1.5, 0.5, 2])('barrel m = %s: exact det J range inside the Bernstein bound', (m) => {
    const expected = ffd.barrel.find((entry) => entry.m === m)!;
    const bounds = determinantBounds(barrel(m));
    expect(bounds.sampledMin).toBeCloseTo(expected.jacobianExactRange[0], 9);
    expect(bounds.sampledMax).toBeCloseTo(expected.jacobianExactRange[1], 9);
    expect(bounds.boundMin).toBeLessThanOrEqual(expected.jacobianExactRange[0] + 1e-9);
    expect(bounds.boundMax).toBeGreaterThanOrEqual(expected.jacobianExactRange[1] - 1e-9);
    expect(bounds.boundMin).toBeGreaterThanOrEqual(expected.jacobianBernsteinBound[0] - 1e-9);
    expect(bounds.boundMax).toBeLessThanOrEqual(expected.jacobianBernsteinBound[1] + 1e-9);
  });

  it('points outside the box are not moved and the map is continuous there when the boundary layers are fixed', () => {
    const law = barrel(1.5);
    expect(latticeMap(law, [2, 0.5, 0.5])).toEqual([2, 0.5, 0.5]);
    expect(latticeMap(law, [0.5, 0.5, 0])).toEqual([0.5, 0.5, 0]);
    const outside: Vec3 = [0.5, 0.5, 1.5];
    expect(latticeJacobian(law, outside)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });
});

describe('point push law (VC-DEF-15, 16)', () => {
  const law: PointLaw = { kind: 'point', center: [0, 0, 0], direction: [0, 0, 1], distance: 2, radius: 10, falloff: 'smooth_c2' };

  it('moves the centre by the distance, nothing at the support boundary, and has the closed-form fold limit', () => {
    expect(pointMap(law, [0, 0, 0])).toEqual([0, 0, 2]);
    expect(pointMap(law, [10, 0, 0])).toEqual([10, 0, 0]);
    expect(pointMap(law, [0, 0, 11])).toEqual([0, 0, 11]);
    expect(foldLimit(law)).toBeCloseTo(5.82309369141, 9);
    expect(determinantRange({ ...law, distance: 5.88132 }).min).toBeLessThan(0);
    expect(determinantRange({ ...law, distance: 5.8 }).min).toBeGreaterThan(0);
    expect(foldLimit({ ...law, falloff: 'cubic' })).toBeCloseTo(10 / 1.5, 12);
  });

  it('det J agrees with central differences of the map', () => {
    for (const p of [
      [2, 1, 3],
      [0, 0, 0.5],
      [-4, 3, 1],
    ] as Vec3[]) {
      const h = 1e-6;
      const column = (axis: number): Vec3 => {
        const plus = [...p] as number[];
        const minus = [...p] as number[];
        plus[axis] = (plus[axis] as number) + h;
        minus[axis] = (minus[axis] as number) - h;
        const [a, b] = [pointMap(law, plus as unknown as Vec3), pointMap(law, minus as unknown as Vec3)];
        return [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h), (a[2] - b[2]) / (2 * h)];
      };
      const [x, y, z] = [column(0), column(1), column(2)];
      const det = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
      expect(Math.abs(det - pointDeterminant(law, p))).toBeLessThan(1e-6);
    }
  });
});

describe('flow along a circular arc is the bend (VC-DEF-18)', () => {
  it('maps every probe point of a bar to the bend image within 1e-5', async () => {
    await installKernel('none');
    const arc = execute(createEmptyDocument(), 'create_conic', {
      start: [0, 0, 0],
      apex: [0, 0, 50],
      end: [0, 50, 50],
      rho: Math.SQRT2 - 1,
    });
    const curve = arc.document.entities[arc.affected[0] as string];
    if (curve?.kind !== 'nurbs_curve') throw new Error('no curve');
    const flow = buildFlowLaw(curve.curve, {
      z0: 0,
      baseLength: (50 * Math.PI) / 2,
      stretch: false,
      orientation: 'minimal',
      tolerance: 1e-6,
      lateral: 6,
      initialNormal: [1, 0, 0],
    });
    if (typeof flow === 'string') throw new Error(flow);
    const bend = { kind: 'bend', radius: 50, symmetric: false } as const;
    const span = region(0, (50 * Math.PI) / 2, 'linear');
    let worst = 0;
    for (const q of [
      [0, 0, 10],
      [5, 5, 40],
      [-5, -5, 70],
      [3, -2, 0.1],
      [5, 5, (50 * Math.PI) / 2 - 0.01],
    ] as Vec3[]) {
      const [a, b] = [flowMap(flow, q), mapLocal(bend, span, q)];
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    expect(worst).toBeLessThan(1e-5);
    expect(localDeterminant(flow, span, [0, 4, 30])).toBeCloseTo((50 - 4) / 50, 5);
    expect(
      buildFlowLaw(curve.curve, {
        z0: 0,
        baseLength: 10,
        stretch: true,
        orientation: 'fixed_up',
        up: [1, 0, 0],
        tolerance: 1e-3,
        lateral: 1,
        initialNormal: [1, 0, 0],
      }),
    ).not.toBe('CURVE_DEGENERATE');
  });
});

const BOX = { size: [40, 40, 10] as Vec3 };
function slab(): { doc: CadDocument; id: string } {
  return addBox(BOX.size);
}

describe.each<KernelKind>(['none', 'manifold', 'warp'])('deform_lattice / deform_by_point / flow_along_curve, kernel: %s', (kind) => {
  it('deform_lattice builds the barrel with the pack volume and reports the Bernstein bound', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([1, 1, 1], 'base-center');
    const moves = [
      { index: [0, 0, 1], delta: [-0.25, -0.25, 0] },
      { index: [1, 0, 1], delta: [0.25, -0.25, 0] },
      { index: [0, 1, 1], delta: [-0.25, 0.25, 0] },
      { index: [1, 1, 1], delta: [0.25, 0.25, 0] },
    ];
    // base-center puts the cube at x, y in [-0.5, 0.5]: the corner moves are expressed in the same frame
    const result = execute(doc, 'deform_lattice', { id, degrees: [1, 1, 2], box: 'bounds', moves, output: { tolerance: 0.0005 } });
    expect(result.error).toBeUndefined();
    const next = result.affected[0] as string;
    expect(relative(volumeOf(result.document, next), 1.3666666667)).toBeLessThan(kind === 'warp' ? 5e-3 : 5e-3);
    const analysis = dataOf<AnalysisData & { jacobian: { bound: { min: number; max: number; method: string } } }>(
      execute(result.document, 'analyze_deformation', { id: next }),
    );
    expect(analysis.law.kind).toBe('lattice');
    expect(analysis.jacobian.min).toBeCloseTo(1, 4);
    expect(analysis.jacobian.max).toBeCloseTo(1.5625, 4);
    expect(analysis.jacobian.bound.max).toBeGreaterThanOrEqual(1.5625 - 1e-9);
    expect(analysis.volume.predicted).toBeCloseTo(1.3666666667, 5);
    expect(analysis.maxDisplacement).toBeCloseTo(0.125 * Math.SQRT2, 3);
    expect(result.summary).toContain('lattice');
    expectPure(doc, () => execute(doc, 'deform_lattice', { id, degrees: [1, 1, 2], moves, output: { tolerance: 0.0005 } }));
  });

  it('deform_lattice refuses bad lattices with their codes', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 10, 100], 'base-center');
    const refused = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'deform_lattice', { id, ...params });
      expectNoOp(result, doc);
      expect(result.error?.code, result.summary).toBe(code);
    };
    const move = { index: [1, 0, 0], delta: [1, 0, 0] };
    refused({ degrees: [0, 1, 1], moves: [move] }, 'DEF_LATTICE_DEGREE');
    refused({ degrees: [9, 1, 1], moves: [move] }, 'DEF_LATTICE_DEGREE');
    refused({ degrees: [1, 1, 1], moves: [{ index: [2, 0, 0], delta: [1, 0, 0] }] }, 'DEF_LATTICE_INDEX');
    refused({ degrees: [1, 1, 1], moves: [{ delta: [1, 0, 0] }] }, 'DEF_LATTICE_INDEX');
    refused({ degrees: [1, 1, 1], moves: [] }, 'DEF_NO_EFFECT');
    refused(
      {
        degrees: [1, 1, 1],
        moves: [
          { index: [1, 0, 0], delta: [-15, 0, 0] },
          { index: [1, 0, 1], delta: [-15, 0, 0] },
          { index: [1, 1, 0], delta: [-15, 0, 0] },
          { index: [1, 1, 1], delta: [-15, 0, 0] },
        ],
      },
      'DEF_FOLDOVER',
    );
    refused({ degrees: [1, 1, 1], box: { min: [100, 100, 100], max: [200, 200, 200] }, moves: [move] }, 'DEF_REGION_MISSES_BODY');
    refused({ degrees: [1, 1, 1], box: { min: [0, 0, 0], max: [-1, 1, 1] }, moves: [move] }, 'DEF_REGION_INVALID');
    // the box cuts the body at z = 50: the layer next to that face must stay
    refused(
      { degrees: [1, 1, 1], box: { min: [-6, -6, -1], max: [6, 6, 50] }, moves: [{ index: [0, 0, 1], delta: [0, 0, 1] }] },
      'DEF_LATTICE_FIXED_MOVED',
    );
  });

  it('deform_lattice names a control point by a nearby world point', async () => {
    await installKernel(kind);
    const { doc, id } = slab();
    const result = execute(doc, 'deform_lattice', {
      id,
      degrees: [2, 2, 1],
      box: { min: [-20, -20, 0], max: [20, 20, 10] },
      moves: [{ near: [19, 1, 9.5], delta: [0, 0, 1] }],
      output: { tolerance: 0.01 },
    });
    expect(result.error, result.summary).toBeUndefined();
    const law = (result.document.entities[result.affected[0] as string] as unknown as { brep: { law: LatticeLaw } }).brep.law;
    expect(law.offsets[0]?.index).toEqual([2, 1, 1]);
    expect(
      execute(doc, 'deform_lattice', { id, degrees: [2, 2, 1], moves: [{ index: [1, 1, 1], near: [0, 0, 0], delta: [0, 0, 1] }] }).error
        ?.code,
    ).toBe('DEF_LATTICE_INDEX');
  });

  it('deform_by_point raises the bump with the pack volume change and refuses past the fold limit', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([100, 100, 50], 'base-center');
    const params = { point: [0, 0, 50], direction: [0, 0, 1], radius: 10, falloff: 'smooth_c2' };
    const result = execute(doc, 'deform_by_point', { id, ...params, distance: 2, output: { tolerance: 0.002 } });
    expect(result.error, result.summary).toBeUndefined();
    const next = result.affected[0] as string;
    const delta = volumeOf(result.document, next) - 500000;
    expect(Math.abs(delta - 157.0796) / 157.0796).toBeLessThan(kind === 'warp' ? 0.05 : 0.02);
    const analysis = dataOf<AnalysisData>(execute(result.document, 'analyze_deformation', { id: next }));
    expect(analysis.maxDisplacement).toBeGreaterThan(1.9);
    expect(analysis.volume.predicted - analysis.volume.source).toBeCloseTo(157.0796, 1);
    const refused = execute(doc, 'deform_by_point', { id, ...params, distance: 5.88132 });
    expectNoOp(refused, doc, '5.823094');
    expect(refused.error?.code).toBe('DEF_FOLDOVER');
    expect(execute(doc, 'deform_by_point', { id, ...params, distance: 5.8 }).error).toBeUndefined();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ distance: 0 }, 'DEF_NO_EFFECT'],
      [{ distance: 1, radius: 0 }, 'DEF_REGION_INVALID'],
      [{ distance: 1, direction: [0, 0, 0] }, 'DEF_FRAME_DEGENERATE'],
      [{ distance: 1, point: [500, 500, 500] }, 'DEF_REGION_MISSES_BODY'],
    ];
    for (const [override, code] of refusals) expect(execute(doc, 'deform_by_point', { id, ...params, ...override }).error?.code).toBe(code);
  });

  it('flow_along_curve lays a straight bar on a quarter circle and refuses a missing, degenerate or too tight path', async () => {
    await installKernel(kind);
    const bar = addBox([10, 10, (50 * Math.PI) / 2], 'base-center');
    const arc = execute(bar.doc, 'create_conic', { start: [100, 0, 0], apex: [100, 0, 50], end: [100, 50, 50], rho: Math.SQRT2 - 1 });
    const curveId = arc.affected[0] as string;
    const frame = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] };
    const flowed = execute(arc.document, 'flow_along_curve', { id: bar.id, targetId: curveId, frame, output: { tolerance: 0.01 } });
    expect(flowed.error, flowed.summary).toBeUndefined();
    const next = flowed.affected[0] as string;
    const data = dataOf<RunData & { law: { kind: string } }>(flowed);
    expect(data.law).toMatchObject({ kind: 'flowCurve' });
    // R 50, half width 5: V = 10 * 10 * L * (1 - 0 / R) for a centred section (the neutral fibre through the centroid)
    expect(relative(volumeOf(flowed.document, next), 10 * 10 * ((50 * Math.PI) / 2))).toBeLessThan(5e-3);
    const analysis = dataOf<AnalysisData>(execute(flowed.document, 'analyze_deformation', { id: next }));
    expect(analysis.jacobian.min).toBeCloseTo(0.9, 2);
    expect(analysis.jacobian.max).toBeCloseTo(1.1, 2);
    expect(execute(arc.document, 'flow_along_curve', { id: bar.id, targetId: 'nope' }).error?.code).toBe('DEF_CURVE_NOT_FOUND');
    expect(execute(arc.document, 'flow_along_curve', { id: bar.id, targetId: bar.id }).error?.code).toBe('DEF_CURVE_NOT_FOUND');
    const tight = execute(bar.doc, 'create_conic', { start: [100, 0, 0], apex: [100, 0, 3], end: [100, 3, 3], rho: Math.SQRT2 - 1 });
    const folded = execute(tight.document, 'flow_along_curve', { id: bar.id, targetId: tight.affected[0] as string, frame });
    expectNoOp(folded, tight.document, 'radius of curvature');
    expect(folded.error?.code).toBe('DEF_FOLDOVER');
    const upParallel = execute(arc.document, 'flow_along_curve', {
      id: bar.id,
      targetId: curveId,
      frame,
      orientation: 'fixed_up',
      up: [0, 0, 1],
    });
    expect(upParallel.error?.code).toBe('DEF_CURVE_INVALID');
  });
});

describe('predicted volume of the local laws', () => {
  it('the lattice barrel integrates det J exactly (the divergence-theorem path)', () => {
    const created = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1], anchor: 'min' });
    const entity = created.document.entities[created.affected[0] as string];
    if (entity === undefined) throw new Error('no box');
    const cube = entityToTriangles(entity, created.document).flatMap((triangle) => triangle.flat());
    const mesh = { positions: cube, indices: Array.from({ length: cube.length / 3 }, (_, i) => i) };
    const predicted = predictedVolumeOf(mesh, { law: barrel(1.5), frame: WORLD_Z });
    expect(predicted?.predicted ?? 0).toBeCloseTo(1.3666666667, 6);
    expect(predictedVolumeOf({ positions: [], indices: [] }, { law: barrel(1.5), frame: WORLD_Z })).toBeNull();
  });
});
