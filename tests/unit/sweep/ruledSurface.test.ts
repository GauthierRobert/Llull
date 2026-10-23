/** SWG M6/M7: ruled_surface by parameter, arc length, developable pairing and to a point (validation VC-SWG-20, 24; target_network_ruled). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type NurbsSurfaceEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { surfaceSample } from '@lib/nurbs/surfaceCurvature';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { relError, runSwgPlan, swgPlan } from '../../helpers/swgPack';

const empty = createEmptyDocument();
const circle = (radius: number, z: number, position: [number, number, number] = [0, 0, 0]): Record<string, unknown> => {
  const q = radius * Math.SQRT1_2;
  const ring = [
    [radius, 0],
    [radius, radius],
    [0, radius],
    [-radius, radius],
    [-radius, 0],
    [-radius, -radius],
    [0, -radius],
    [radius, -radius],
    [radius, 0],
  ];
  void q;
  return {
    degree: 2,
    poles: ring.map(([x, y]) => [x, y, z]),
    weights: [1, q / radius, 1, q / radius, 1, q / radius, 1, q / radius, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
    position,
  };
};

function withCurves(...specs: Array<[string, string, Record<string, unknown>]>): { doc: CadDocument; ids: string[] } {
  let doc = empty;
  const ids: string[] = [];
  for (const [command, , params] of specs) {
    const result = execute(doc, command, params);
    expect(result.affected, result.summary).toHaveLength(1);
    doc = result.document;
    ids.push(result.affected[0] as string);
  }
  return { doc, ids };
}

const line = (a: number[], b: number[]): [string, string, Record<string, unknown>] => [
  'interpolate_curve',
  '',
  { points: [a, b], degree: 1 },
];
const conic = (radius: number, z: number): [string, string, Record<string, unknown>] => ['create_nurbs_curve', '', circle(radius, z)];

describe('ruled_surface — hyperbolic paraboloid (VC-SWG-24)', () => {
  const { doc, ids } = withCurves(line([0, 0, 0], [1, 0, 0]), line([0, 1, 0], [1, 1, 1]));
  const result = execute(doc, 'ruled_surface', { curveIds: ids });
  const data = result.data as Record<string, number | boolean | string>;
  it('creates one nurbs_surface of degree 1 across with the exact area and curvature', () => {
    expect(result.affected, result.summary).toHaveLength(1);
    const surface = result.document.entities[result.affected[0] as string] as NurbsSurfaceEntity;
    expect(surface.kind).toBe('nurbs_surface');
    expect(surface.surface.degreeV).toBe(1);
    expect(Math.abs((data['area'] as number) - 1.2807893)).toBeLessThan(1e-7);
    expect(Math.abs(surfaceSample(surface.surface, 0.5, 0.5).gaussian + 0.4444444)).toBeLessThan(1e-7);
    expect(data['developable']).toBe(false);
    expect(result.document.order.at(-1)).toBe(result.affected[0]);
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'ruled_surface', { curveIds: ids }));
  });
  it('reverse joins the second curve backwards (a twisted, larger sheet)', () => {
    const flipped = execute(doc, 'ruled_surface', { curveIds: ids, reverse: true });
    expect(flipped.data).toBeDefined();
    expect((flipped.data as { area: number }).area).not.toBeCloseTo(data['area'] as number, 3);
  });
});

describe('ruled_surface — frustum of two circles (VC-SWG-20)', () => {
  const { doc, ids } = withCurves(conic(10, 0), conic(5, 50));
  const slant = Math.hypot(50, 5);
  const lateral = Math.PI * 15 * slant;
  it('lateral area is pi (r1 + r2) s and the sheet is developable with K = 0', () => {
    for (const coupling of ['parameter', 'developable'] as const) {
      const result = execute(doc, 'ruled_surface', { curveIds: ids, coupling });
      expect(result.affected, result.summary).toHaveLength(1);
      const data = result.data as { area: number; maxAbsGaussianCurvature: number; developable: boolean };
      expect(relError(data.area, lateral), coupling).toBeLessThan(1e-5);
      expect(data.maxAbsGaussianCurvature, coupling).toBeLessThan(1e-9);
      expect(data.developable).toBe(true);
    }
  });
  it('arc-length pairing of coaxial circles gives the same sheet within the fit tolerance', () => {
    const result = execute(doc, 'ruled_surface', { curveIds: ids, coupling: 'arc_length' });
    expect(result.affected, result.summary).toHaveLength(1);
    const data = result.data as { area: number; fitDeviation: number };
    expect(relError(data.area, lateral)).toBeLessThan(1e-4);
    expect(data.fitDeviation).toBeLessThan(1e-4);
  });
  it('a loose fitTolerance of 1e-14 cannot be met: SWG_FIT_TOLERANCE', () => {
    const result = execute(doc, 'ruled_surface', { curveIds: ids, coupling: 'arc_length', fitTolerance: 1e-14 });
    expectNoOp(result, doc, 'SWG_FIT_TOLERANCE');
    expect(result.error?.code).toBe('SWG_FIT_TOLERANCE');
  });
  it('a curve and a point make a cone of area pi r s', () => {
    const result = execute(doc, 'ruled_surface', { curveId: ids[0], point: [0, 0, 40] });
    expect(result.affected, result.summary).toHaveLength(1);
    expect(relError((result.data as { area: number }).area, Math.PI * 10 * Math.hypot(40, 10))).toBeLessThan(1e-5);
  });
});

describe('ruled_surface — developable pairing of curves whose parameters do not match', () => {
  // an ellipse-like quarter arc and a straight segment: cylinders / cones between a line and a planar curve are developable (K = 0 along the pairing)
  it('pairs a parabola with a line by Newton continuation, or refuses with SWG_NOT_DEVELOPABLE', () => {
    const { doc, ids } = withCurves(
      [
        'interpolate_curve',
        '',
        {
          points: [
            [0, 0, 0],
            [1, 0.25, 0],
            [2, 1, 0],
            [3, 2.25, 0],
          ],
          degree: 3,
        },
      ],
      [
        'interpolate_curve',
        '',
        {
          points: [
            [0, 0, 5],
            [3, 0, 5],
          ],
          degree: 1,
        },
      ],
    );
    const result = execute(doc, 'ruled_surface', { curveIds: ids, coupling: 'developable' });
    if (result.affected.length === 1) {
      expect((result.data as { coupling: string }).coupling).toBe('developable');
      expect((result.data as { maxAbsGaussianCurvature: number }).maxAbsGaussianCurvature).toBeLessThan(1e-2);
    } else expect(result.error?.code).toBe('SWG_NOT_DEVELOPABLE');
  });
  it('two skew lines have no developable ruling set: SWG_NOT_DEVELOPABLE', () => {
    const { doc, ids } = withCurves(line([0, 0, 0], [1, 0, 0]), line([0, 1, 0], [1, 1, 1]));
    const result = execute(doc, 'ruled_surface', { curveIds: ids, coupling: 'developable' });
    expectNoOp(result, doc, 'SWG_NOT_DEVELOPABLE');
    expect(result.error?.code).toBe('SWG_NOT_DEVELOPABLE');
  });
});

describe('ruled_surface — failures', () => {
  const { doc, ids } = withCurves(line([0, 0, 0], [1, 0, 0]), line([0, 1, 0], [1, 1, 1]));
  it('one curve alone, three curves, or no point for a curveId: SWG_RULED_CURVES', () => {
    for (const params of [{ curveIds: [ids[0]] }, { curveIds: [...ids, ids[0]] }, { curveId: ids[0] }, {}]) {
      const result = execute(doc, 'ruled_surface', params);
      expectNoOp(result, doc, 'SWG_RULED_CURVES');
      expect(result.error?.code).toBe('SWG_RULED_CURVES');
    }
  });
  it('an unknown id is a coded no-op', () => {
    const result = execute(doc, 'ruled_surface', { curveIds: [ids[0], 'nope'] });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('SRF_ENTITY_NOT_FOUND');
  });
  it('a non-positive fitTolerance is refused', () => {
    const result = execute(doc, 'ruled_surface', { curveIds: ids, fitTolerance: -1 });
    expect(result.error?.code).toBe('SWG_PARAM_INVALID');
  });
});

describe('target_network_ruled — the ruled steps of the pack plan', () => {
  it('hypar and frustum sheet steps succeed', () => {
    const actions = swgPlan('target_network_ruled').filter((a, i) => i >= 10 && a.command !== 'check_sweep_loft');
    const { steps } = runSwgPlan(actions);
    expect(steps.filter((s) => !s.ok).map((s) => s.summary)).toEqual([]);
  });
});
