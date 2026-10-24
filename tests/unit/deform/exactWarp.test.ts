import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { DeformReport } from '@core/geometry/kernelPorts';
import { maxDeviation, referenceDistance } from '@core/geometry/deform/referenceShape';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type AnalysisData, type RunData, WORLD_Z, addBox, addCylinder, dataOf, installKernel, stubReport } from './harness';

afterEach(() => {
  setGeometryKernel(null);
  stubReport.current = null;
  stubReport.refuse = false;
});

const REPORT: DeformReport = {
  ok: true,
  code: '',
  message: '',
  maxError: 4e-6,
  surfaceError: 4e-6,
  curveError: 1e-6,
  faces: 6,
  edges: 12,
  splitFaces: 2,
  ring: false,
  minDeterminant: 1,
  volume: 10000,
};

describe('the exact warp of the native kernel (01 DEF M2), through a stub that builds every law', () => {
  const twist = { angleDeg: 90, frame: WORLD_Z, region: { start: 0, end: 100, falloff: 'linear' }, output: { tolerance: 0.01 } };

  it('builds every axis law on the exact path and says so', async () => {
    await installKernel('warp');
    const { doc, id } = addBox();
    const result = execute(doc, 'twist_body', { id, ...twist });
    expect(dataOf<RunData>(result)).toMatchObject({ path: 'exact', kernel: 'occt', volume: { method: 'exact' } });
    expect(result.summary).toContain('exact path');
    expect(result.summary).not.toContain('faceted');
    for (const [name, params] of [
      ['taper_body', { scaleEnd: 0.5 }],
      ['stretch_body', { factor: 1.5 }],
      ['bend_body', { radius: 60, angleDeg: 45 }],
    ] as const) {
      const built = execute(doc, name, { id, frame: name === 'bend_body' ? { ...WORLD_Z, reference: [0, 1, 0] } : WORLD_Z, ...params });
      expect(dataOf<RunData>(built).path).toBe('exact');
    }
    expectPure(doc, () => execute(doc, 'twist_body', { id, ...twist }));
  });

  it('mode "exact" is honoured and the mesh mode still forces the faceted path', async () => {
    await installKernel('warp');
    const { doc, id } = addBox();
    expect(dataOf<RunData>(execute(doc, 'twist_body', { id, ...twist, output: { mode: 'exact', tolerance: 0.01 } })).path).toBe('exact');
    expect(dataOf<RunData>(execute(doc, 'twist_body', { id, ...twist, output: { mode: 'mesh', tolerance: 0.01 } })).path).toBe('mesh');
  });

  it('a kernel refusal carries the code the kernel reports, else a generic one', async () => {
    await installKernel('warp');
    const { doc, id } = addBox();
    stubReport.refuse = true;
    const exact = { ...twist, output: { mode: 'exact', tolerance: 0.01 } };
    const generic = execute(doc, 'twist_body', { id, ...exact });
    expectNoOp(generic, doc, 'refused');
    expect(generic.error?.code).toBe('DEF_KERNEL_REFUSED');
    stubReport.current = {
      ...REPORT,
      ok: false,
      code: 'DEF_APPROX_TOLERANCE',
      message: 'a face approximation reaches 0.1 against the allowed 0.005',
    };
    const fit = execute(doc, 'twist_body', { id, ...exact });
    expectNoOp(fit, doc, 'a face approximation reaches 0.1');
    expect(fit.error?.code).toBe('DEF_APPROX_TOLERANCE');
    stubReport.current = { ...REPORT, ok: false, code: 'DEF_FOLDOVER', message: 'the map folds the body' };
    expect(execute(doc, 'twist_body', { id, ...twist }).error?.code).toBe('DEF_FOLDOVER');
  });

  it('mode "auto" answers a refusal of the exact warp with the faceted path and says why; folds stay refused', async () => {
    await installKernel('warp');
    const { doc, id } = addBox();
    stubReport.refuse = true;
    stubReport.current = { ...REPORT, ok: false, code: 'DEF_APPROX_TOLERANCE', message: 'a face approximation reaches 0.1' };
    const fallen = execute(doc, 'twist_body', { id, ...twist });
    expect(fallen.error, fallen.summary).toBeUndefined();
    expect(fallen.summary).toContain('The exact warp refused (DEF_APPROX_TOLERANCE)');
    expect(dataOf<RunData & { exactRefused: string }>(fallen)).toMatchObject({ path: 'mesh', exactRefused: 'DEF_APPROX_TOLERANCE' });
    stubReport.current = null;
    const generic = execute(doc, 'twist_body', { id, ...twist });
    expect(dataOf<RunData & { exactRefused: string }>(generic)).toMatchObject({ path: 'mesh', exactRefused: 'DEF_KERNEL_REFUSED' });
    expect(execute(doc, 'twist_body', { id, ...twist, output: { mode: 'exact', tolerance: 0.01 } }).error?.code).toBe('DEF_KERNEL_REFUSED');
    stubReport.current = { ...REPORT, ok: false, code: 'DEF_FOLDOVER', message: 'the map folds the body' };
    expect(execute(doc, 'twist_body', { id, ...twist }).error?.code).toBe('DEF_FOLDOVER');
    expectPure(doc, () => execute(doc, 'twist_body', { id, ...twist }));
  });

  it('analyze_deformation reports the fit of the exact path and the topology before and after', async () => {
    await installKernel('warp');
    stubReport.current = REPORT;
    const { doc, id } = addBox();
    const built = execute(doc, 'twist_body', { id, ...twist });
    const analysis = dataOf<AnalysisData & { approximation: { facesConverted: number; facesSplit: number; maxError: number } }>(
      execute(built.document, 'analyze_deformation', { id: built.affected[0] }),
    );
    expect(analysis.path).toBe('exact');
    expect(analysis.approximation).toMatchObject({ maxError: 4e-6, facesConverted: 6, facesSplit: 2 });
    expect((analysis as unknown as { topology: unknown }).topology).toEqual({
      before: { faces: 0, edges: 0, vertices: 0 },
      after: { faces: 0, edges: 0, vertices: 0 },
    });
  });
});

describe('a full-turn bend closes into a ring (exact kernel only)', () => {
  const rod = { radius: 5, height: 2 * Math.PI * 50 };
  const ring = { radius: 50, angleDeg: 360, frame: { ...WORLD_Z, reference: [0, 1, 0] } };

  it('is built on the exact path and flagged as a ring in the recipe', async () => {
    await installKernel('warp');
    stubReport.current = { ...REPORT, ring: true };
    const { doc, id } = addCylinder(rod.radius, rod.height);
    const result = execute(doc, 'bend_body', { id, ...ring });
    expect(result.error).toBeUndefined();
    expect(dataOf<RunData>(result).path).toBe('exact');
  });

  it('is refused when the kernel did not close a ring (the ends would coincide) and does not fall back to the faceted path', async () => {
    await installKernel('warp');
    stubReport.current = { ...REPORT, ring: false };
    const { doc, id } = addCylinder(rod.radius, rod.height);
    const result = execute(doc, 'bend_body', { id, ...ring });
    expectNoOp(result, doc, 'full-turn');
    expect(result.error?.code).toBe('DEF_SELF_INTERSECTION');
    await installKernel('warp');
    stubReport.refuse = true;
    stubReport.current = {
      ...REPORT,
      ok: false,
      code: 'DEF_SELF_INTERSECTION',
      message: 'a full-turn bend needs exactly two planar end faces',
    };
    const refused = execute(doc, 'bend_body', { id, ...ring });
    expect(refused.error?.code).toBe('DEF_SELF_INTERSECTION');
    expect(refused.summary).toContain('exactly two planar end faces');
  });

  it.each(['none', 'manifold'] as const)('is refused without the exact kernel (%s)', async (kind) => {
    await installKernel(kind);
    const { doc, id } = addCylinder(rod.radius, rod.height);
    const result = execute(doc, 'bend_body', { id, ...ring });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('DEF_SELF_INTERSECTION');
  });

  it('is refused in mesh mode, with a straight tail left, or past a full turn', async () => {
    await installKernel('warp');
    const { doc, id } = addCylinder(rod.radius, rod.height);
    expect(execute(doc, 'bend_body', { id, ...ring, output: { mode: 'mesh' } }).error?.code).toBe('DEF_SELF_INTERSECTION');
    const longer = addCylinder(rod.radius, rod.height + 30);
    expect(execute(longer.doc, 'bend_body', { id: longer.id, ...ring }).error?.code).toBe('DEF_SELF_INTERSECTION');
    expect(execute(doc, 'bend_body', { id, radius: 50, angleDeg: 400, frame: ring.frame }).error?.code).toBe('DEF_SELF_INTERSECTION');
  });
});

describe('analyze_deformation compareTo (analytic reference shapes)', () => {
  it('measures a bent cylinder against the torus it should be, and refuses an incomplete reference', async () => {
    await installKernel('manifold');
    const { doc, id } = addCylinder(5, 50 * Math.PI);
    const bent = execute(doc, 'bend_body', {
      id,
      radius: 50,
      angleDeg: 180,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] },
      output: { tolerance: 0.002 },
    });
    const next = bent.affected[0] as string;
    const torus = { kind: 'torus', majorRadius: 50, minorRadius: 5, center: [0, 50, 0], axis: [1, 0, 0] };
    const result = execute(bent.document, 'analyze_deformation', { id: next, compareTo: torus });
    const deviation = (result.data as { compareTo: { maxDeviation: number; samples: number } }).compareTo;
    expect(deviation.maxDeviation).toBeLessThan(0.1);
    expect(deviation.samples).toBeGreaterThan(100);
    expect(result.summary).toContain('Deviation from the torus');
    const wrong = execute(bent.document, 'analyze_deformation', { id: next, compareTo: { kind: 'torus', majorRadius: 50 } });
    expectNoOp(wrong, bent.document, 'compareTo.minorRadius');
    expect(wrong.error?.code).toBe('DEF_COMPARE_INVALID');
  });
});

describe('reference shape distances', () => {
  it('is zero on the surface and the offset elsewhere, for each kind', () => {
    const distance = (shape: Parameters<typeof referenceDistance>[0]): ((p: [number, number, number]) => number) => {
      const result = referenceDistance(shape);
      if ('missing' in result) throw new Error(result.missing);
      return result;
    };
    const torus = distance({ kind: 'torus', majorRadius: 50, minorRadius: 5, center: [0, 0, 0], axis: [0, 0, 1] });
    expect(torus([55, 0, 0])).toBeCloseTo(0, 12);
    expect(torus([50, 0, 7])).toBeCloseTo(2, 12);
    const cylinder = distance({ kind: 'cylinder', radius: 3, point: [0, 0, 0], axis: [0, 0, 2] });
    expect(cylinder([3, 0, 9])).toBeCloseTo(0, 12);
    expect(cylinder([0, 5, -4])).toBeCloseTo(2, 12);
    const cone = distance({ kind: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], halfAngleDeg: 45 });
    expect(cone([2, 0, 2])).toBeCloseTo(0, 12);
    expect(cone([4, 0, 2])).toBeCloseTo(Math.SQRT2, 12);
    const spheroid = distance({ kind: 'spheroid', center: [0, 0, 0], semiAxes: [1, 1, 2] });
    expect(spheroid([0, 0, 2])).toBeCloseTo(0, 12);
    expect(spheroid([0, 0, 1])).toBeGreaterThan(0.5);
  });

  it('names the first missing field and takes a stride over large point sets', () => {
    expect(referenceDistance({ kind: 'cylinder', point: [0, 0, 0], axis: [0, 0, 1] })).toEqual({ missing: 'radius' });
    expect(referenceDistance({ kind: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], halfAngleDeg: 95 })).toEqual({ missing: 'halfAngleDeg' });
    expect(referenceDistance({ kind: 'spheroid', center: [0, 0, 0], semiAxes: [1, 0, 1] })).toEqual({ missing: 'semiAxes' });
    expect(referenceDistance({ kind: 'torus', majorRadius: 1, minorRadius: 1, center: [0, 0, 0], axis: [0, 0, 0] })).toEqual({
      missing: 'axis',
    });
    const unit = referenceDistance({ kind: 'cylinder', radius: 2, point: [0, 0, 0], axis: [0, 0, 1] });
    if ('missing' in unit) throw new Error('unreachable');
    const positions = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    expect(maxDeviation(unit, positions, 4)).toEqual({ max: 1, samples: 4 });
  });
});
