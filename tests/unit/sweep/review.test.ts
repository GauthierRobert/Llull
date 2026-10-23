/** SWG review fixes: mitre with rails, mitre reach per leg, unit-free developability, mitre with laws. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sweepAnalyticVolume } from '@core/geometry/sweepEval/volume';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();

function create(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
}

describe('mitre corners', () => {
  const L = [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ];
  it('rails and a mitre are exclusive (a mitre ring cannot follow rails)', () => {
    const rail = create(empty, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 6, 0],
        [100, 6, 0],
      ],
    });
    const result = execute(rail.doc, 'sweep_profile', { path: L, radius: 5, corners: 'miter', guideIds: [rail.id] });
    expectNoOp(result, rail.doc, 'SWG_LAW_EXCLUSIVE');
  });
  it('a short middle leg must hold the mitre reach of BOTH its joints (a Z path)', () => {
    const z = (middle: number[]): number[][] => [[0, 0, 0], [100, 0, 0], middle, [(middle[0] as number) + 100, middle[1] as number, 0]];
    const short = execute(empty, 'sweep_profile', { path: z([90, 10, 0]), radius: 5, corners: 'miter' });
    expectNoOp(short, empty, 'SWG_SELF_INTERSECTION_LOCAL');
    expect(short.summary).toContain('leg 1');
    const long = execute(empty, 'sweep_profile', { path: z([60, 40, 0]), radius: 5, corners: 'miter' });
    expect(long.affected, long.summary).toHaveLength(1);
  });
  it('a mitre with a scale or area law has no closed-form volume; a constant section keeps A (L1 + L2)', () => {
    const volumeOf = (extra: Record<string, unknown>): number | null => {
      const made = execute(empty, 'sweep_profile', { path: L, radius: 5, corners: 'miter', ...extra });
      expect(made.affected, made.summary).toHaveLength(1);
      return sweepAnalyticVolume(made.document.entities[made.affected[0] as string] as SweepEntity);
    };
    expect(volumeOf({})).toBeCloseTo(Math.PI * 25 * 200, 6);
    expect(volumeOf({ scale: { type: 'linear', start: 1, end: 0.5 } })).toBeNull();
    expect(volumeOf({ area: { type: 'linear', start: 78.5, end: 40 } })).toBeNull();
  });
  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'sweep_profile', { path: L, radius: 5, corners: 'miter', guideIds: ['nope'] }));
  });
});

describe('ruled_surface developable flag is unit free (K L^2)', () => {
  const line = (doc: CadDocument, a: number[], b: number[]): { doc: CadDocument; id: string } =>
    create(doc, 'create_nurbs_curve', { degree: 1, poles: [a, b] });
  it('a hypar z = x y / 1000 over 1000 mm is not developable although |K| = 1e-6 per mm^2', () => {
    const a = line(empty, [0, 0, 0], [1000, 0, 0]);
    const b = line(a.doc, [0, 1000, 0], [1000, 1000, 1000]);
    const made = execute(b.doc, 'ruled_surface', { curveIds: [a.id, b.id] });
    expect(made.affected, made.summary).toHaveLength(1);
    const data = made.data as { developable: boolean; maxAbsGaussianCurvature: number; scaledGaussianCurvature: number };
    expect(data.maxAbsGaussianCurvature).toBeLessThan(1.1e-6);
    expect(data.scaledGaussianCurvature).toBeGreaterThan(1);
    expect(data.developable).toBe(false);
  });
  it('a 5 m strake between two skew lines is not developable either', () => {
    const a = line(empty, [0, 0, 0], [5000, 0, 0]);
    const b = line(a.doc, [0, 1200, 400], [5000, 1200, 1400]);
    const made = execute(b.doc, 'ruled_surface', { curveIds: [a.id, b.id] });
    expect((made.data as { developable: boolean }).developable).toBe(false);
  });
  it('a cone frustum sheet is developable at 10 m scale exactly as at 10 mm', () => {
    const circle = (doc: CadDocument, radius: number, z: number): { doc: CadDocument; id: string } => {
      const w = Math.SQRT1_2;
      const ring = [
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
        [1, 0],
      ];
      return create(doc, 'create_nurbs_curve', {
        degree: 2,
        poles: ring.map(([x, y]) => [(x as number) * radius, (y as number) * radius, z]),
        weights: ring.map((_, i) => (i % 2 === 0 ? 1 : w)),
        knots: [0, 0.25, 0.5, 0.75, 1],
        multiplicities: [3, 2, 2, 2, 3],
      });
    };
    for (const scale of [1, 1000]) {
      const a = circle(empty, 10 * scale, 0);
      const b = circle(a.doc, 5 * scale, 8 * scale);
      const made = execute(b.doc, 'ruled_surface', { curveIds: [a.id, b.id] });
      expect((made.data as { developable: boolean }).developable, `scale ${scale}`).toBe(true);
    }
  });
});
