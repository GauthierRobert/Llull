import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateSurface } from '@lib/nurbs/surface';
import { extractSubSurface } from '@lib/nurbs/surfaceEdit';
import { closestOnSurface } from '@lib/nurbs/closest';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { sphereSurface } from '../../helpers/revolvedSurfaces';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

const empty = createEmptyDocument();
const S = Math.SQRT1_2;

/** Rational 9-pole circle of `radius` at height `z`. */
const circle = (radius: number, z: number): Record<string, unknown> => ({
  degree: 2,
  poles: [
    [radius, 0, z],
    [radius, radius, z],
    [0, radius, z],
    [-radius, radius, z],
    [-radius, 0, z],
    [-radius, -radius, z],
    [0, -radius, z],
    [radius, -radius, z],
    [radius, 0, z],
  ],
  weights: [1, S, 1, S, 1, S, 1, S, 1],
  knots: [0, 0.25, 0.5, 0.75, 1],
  multiplicities: [3, 2, 2, 2, 3],
});

const line = (from: number[], to: number[]): Record<string, unknown> => ({ degree: 1, poles: [from, to] });

function addCurves(curves: Array<Record<string, unknown>>): { doc: CadDocument; ids: string[] } {
  let doc = empty;
  const ids: string[] = [];
  for (const params of curves) {
    const result = execute(doc, 'create_nurbs_curve', params);
    expect(result.affected).toHaveLength(1);
    doc = result.document;
    ids.push(result.affected[0]!);
  }
  return { doc, ids };
}

const surfaceOf = (doc: CadDocument, id: string): NurbsSurfaceData => (doc.entities[id] as NurbsSurfaceEntity).surface;

describe('loft_surface', () => {
  const { doc, ids } = addCurves([circle(1, 0), circle(2, 2), circle(1.5, 5)]);

  it('skins rational sections exactly (no resampling)', () => {
    const result = execute(doc, 'loft_surface', { sectionIds: ids });
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!);
    for (const [v, radius, z] of [
      [0, 1, 0],
      [1, 1.5, 5],
    ] as const)
      for (const u of [0, 0.17, 0.5, 0.83]) {
        const point = evaluateSurface(surface, u, v);
        expect(Math.hypot(point[0], point[1])).toBeCloseTo(radius, 9);
        expect(point[2]).toBeCloseTo(z, 9);
      }
    expect(result.summary).toMatch(/max section deviation/);
    expectPure(doc, () => execute(doc, 'loft_surface', { sectionIds: ids }));
  });

  it('degreeV 1 gives a ruled skin', () => {
    const result = execute(doc, 'loft_surface', { sectionIds: ids.slice(0, 2), degreeV: 1 });
    const mid = evaluateSurface(surfaceOf(result.document, result.affected[0]!), 0, 0.5);
    expect(mid[0]).toBeCloseTo(1.5, 9);
    expect(mid[2]).toBeCloseTo(1, 9);
  });

  it('refuses too few sections, unknown ids and non-curves', () => {
    expect(execute(doc, 'loft_surface', { sectionIds: [ids[0]!] }).error?.code).toBe('SRF_LOFT_SECTIONS_TOO_FEW');
    expect(execute(doc, 'loft_surface', { sectionIds: [ids[0]!, 'nope'] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    const box = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    expectNoOp(execute(box, 'loft_surface', { sectionIds: [ids[0]!, box.order[box.order.length - 1]!] }), box);
  });

  it('with guides builds a Gordon surface through sections and guides (VC guide network)', () => {
    const network = addCurves([circle(1, 0), circle(1, 1), circle(1, 2), line([1, 0, 0], [1, 0, 2]), line([-1, 0, 0], [-1, 0, 2])]);
    const result = execute(network.doc, 'loft_surface', { sectionIds: network.ids.slice(0, 3), guideIds: network.ids.slice(3) });
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!);
    for (const point of [
      [1, 0, 1.3],
      [-1, 0, 0.4],
      [0, 1, 2],
      [0.6, 0.8, 1],
    ] as const)
      expect(closestOnSurface(surface, [...point]).distance).toBeLessThan(2e-3);
    expect(result.summary).toMatch(/Gordon/);
  });

  it('refuses a guide that misses a section', () => {
    const network = addCurves([circle(1, 0), circle(1, 1), line([3, 0, 0], [3, 0, 1])]);
    const result = execute(network.doc, 'loft_surface', { sectionIds: network.ids.slice(0, 2), guideIds: [network.ids[2]!] });
    expectNoOp(result, network.doc);
    expect(result.error?.code).toBe('SRF_LOFT_GUIDE_MISSES_SECTION');
  });
});

describe('fill_surface', () => {
  const square = [line([0, 0, 0], [4, 0, 0]), line([4, 0, 0], [4, 3, 1]), line([4, 3, 1], [0, 3, 1]), line([0, 3, 1], [0, 0, 0])];

  it('fills 4 boundary curves given in any order and orientation, containing each of them', () => {
    const { doc, ids } = addCurves([square[2]!, line([4, 3, 1], [4, 0, 0]), square[0]!, square[3]!]);
    const result = execute(doc, 'fill_surface', { boundaryIds: ids });
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!);
    for (const point of [
      [2, 0, 0],
      [4, 1.5, 0.5],
      [2, 3, 1],
      [0, 1.5, 0.5],
      [2, 1.5, 0.5],
    ] as const)
      expect(closestOnSurface(surface, [...point]).distance).toBeLessThan(1e-9);
    expectPure(doc, () => execute(doc, 'fill_surface', { boundaryIds: ids }));
  });

  it('fills a triangle (one collapsed side)', () => {
    const { doc, ids } = addCurves([line([0, 0, 0], [4, 0, 0]), line([4, 0, 0], [0, 4, 0]), line([0, 4, 0], [0, 0, 0])]);
    const result = execute(doc, 'fill_surface', { boundaryIds: ids });
    expect(result.affected).toHaveLength(1);
    const surface = surfaceOf(result.document, result.affected[0]!);
    expect(closestOnSurface(surface, [2, 2, 0]).distance).toBeLessThan(1e-9);
    expect(closestOnSurface(surface, [1, 0, 0]).distance).toBeLessThan(1e-9);
  });

  it('refuses an open loop, a wrong count and rational curves', () => {
    const open = addCurves([square[0]!, square[1]!, square[2]!, line([0, 5, 1], [0, 0, 0])]);
    const gap = execute(open.doc, 'fill_surface', { boundaryIds: open.ids });
    expectNoOp(gap, open.doc);
    expect(gap.error?.code).toBe('SRF_FILL_LOOP_OPEN');
    expect(execute(open.doc, 'fill_surface', { boundaryIds: open.ids.slice(0, 2) }).error?.code).toBe('SRF_FILL_UNSUPPORTED');
    const round = addCurves([circle(1, 0), circle(1, 0), circle(1, 0)]);
    expect(execute(round.doc, 'fill_surface', { boundaryIds: round.ids }).error?.code).toBe('SRF_FILL_UNSUPPORTED');
  });
});

describe('sew_surfaces', () => {
  const plane = (x0: number, x1: number): Record<string, unknown> => ({
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [x0, 0, 0],
        [x0, 2, 0.5 * x0],
      ],
      [
        [x1, 0, 0],
        [x1, 2, 0.5 * x1],
      ],
    ],
  });

  it('joins two patches along a shared edge into one multi-span patch', () => {
    const a = execute(empty, 'create_nurbs_surface', plane(0, 3));
    const b = execute(a.document, 'create_nurbs_surface', plane(3, 5));
    const [first, second] = [a.affected[0]!, b.affected[0]!];
    const result = execute(b.document, 'sew_surfaces', { ids: [first, second] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toEqual(result.affected);
    const sewn = surfaceOf(result.document, result.affected[0]!);
    expect(sewn.poles).toHaveLength(3);
    const [lo, hi] = [sewn.knotsU[0]!, sewn.knotsU[sewn.knotsU.length - 1]!];
    expect(evaluateSurface(sewn, lo, 1)[0]).toBeCloseTo(0, 9);
    expect(evaluateSurface(sewn, hi, 1)[0]).toBeCloseTo(5, 9);
    expect(evaluateSurface(sewn, hi, 1)[2]).toBeCloseTo(2.5, 9);
    expect(evaluateSurface(sewn, (lo + hi) / 2, 0.5)[0]).toBeGreaterThan(2);
    expectPure(b.document, () => execute(b.document, 'sew_surfaces', { ids: [first, second] }));
  });

  it('refuses patches that share no edge, the same id twice, and non-surfaces', () => {
    const a = execute(empty, 'create_nurbs_surface', plane(0, 3));
    const b = execute(a.document, 'create_nurbs_surface', plane(10, 12));
    const apart = execute(b.document, 'sew_surfaces', { ids: [a.affected[0]!, b.affected[0]!] });
    expectNoOp(apart, b.document);
    expect(apart.error?.code).toBe('SRF_SEW_NOT_MERGEABLE');
    expect(execute(b.document, 'sew_surfaces', { ids: [a.affected[0]!, a.affected[0]!] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(b.document, 'sew_surfaces', { ids: [a.affected[0]!] }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(b.document, 'sew_surfaces', { ids: [a.affected[0]!, 'x'] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
  });
});

describe('thicken_surface (VC-SRF-24)', () => {
  const hemisphere = extractSubSurface(sphereSurface(10), [0, 1], [0.5, 1]) as NurbsSurfaceData;
  const params = {
    degreeU: hemisphere.degreeU,
    degreeV: hemisphere.degreeV,
    poles: hemisphere.poles,
    weights: hemisphere.weights,
    knotsU: hemisphere.knotsU,
    multiplicitiesU: hemisphere.multiplicitiesU,
    knotsV: hemisphere.knotsV,
    multiplicitiesV: hemisphere.multiplicitiesV,
  };
  const base = execute(empty, 'create_nurbs_surface', params);
  const id = base.affected[0]!;
  const volumeOf = (doc: CadDocument, solid: string): number =>
    (execute(doc, 'mass_properties', { entityId: solid }).data as { volume: number }).volume;

  it('a hemisphere sheet thickened by 1 has the volume of the shell on one side', () => {
    const outward = ((2 / 3) * Math.PI * (11 ** 3 - 10 ** 3)) as number;
    const inward = (2 / 3) * Math.PI * (10 ** 3 - 9 ** 3);
    const volumes = (['normal', 'reverse'] as const).map((side) => {
      const result = execute(base.document, 'thicken_surface', { id, thickness: 1, side });
      expect(result.affected).toHaveLength(1);
      expect(result.document.entities[result.affected[0]!]!.kind).toBe('mesh');
      expect(result.document.order).toContain(id);
      return volumeOf(result.document, result.affected[0]!);
    });
    const [near, far] = volumes[0]! > volumes[1]! ? [volumes[0]!, volumes[1]!] : [volumes[1]!, volumes[0]!];
    expect(Math.abs(near / outward - 1)).toBeLessThan(0.02);
    expect(Math.abs(far / inward - 1)).toBeLessThan(0.02);
    const both = execute(base.document, 'thicken_surface', { id, thickness: 1, side: 'both' });
    expect(Math.abs(volumeOf(both.document, both.affected[0]!) / ((2 / 3) * Math.PI * (10.5 ** 3 - 9.5 ** 3)) - 1)).toBeLessThan(0.02);
  });

  it('the thickened u-closed hemisphere is a manifold solid a kernel boolean accepts (no seam fins)', async () => {
    const kernel = await createManifoldKernel();
    setGeometryKernel(kernel);
    try {
      const shell = execute(base.document, 'thicken_surface', { id, thickness: 1, side: 'both' });
      const solidId = shell.affected[0]!;
      const withTool = execute(shell.document, 'add_box', { size: [4, 4, 4], position: [0, 0, 10] });
      const cut = execute(withTool.document, 'boolean', { op: 'subtract', a: solidId, b: withTool.affected[0]! });
      expect(cut.affected).toHaveLength(1);
      const remaining = volumeOf(cut.document, cut.affected[0]!);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(volumeOf(shell.document, solidId));
    } finally {
      setGeometryKernel(null);
    }
  });

  it('refuses an offset past the centre of curvature, bad thickness and non-surfaces', () => {
    const sides = (['normal', 'reverse'] as const).map((side) => execute(base.document, 'thicken_surface', { id, thickness: 11, side }));
    const blocked = sides.filter((result) => result.error?.code === 'SRF_THICKEN_SELF_INTERSECT');
    expect(blocked).toHaveLength(1);
    expectNoOp(blocked[0]!, base.document);
    expect(execute(base.document, 'thicken_surface', { id, thickness: 0 }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(base.document, 'thicken_surface', { id, thickness: 1, quality: 1 }).error?.code).toBe('SRF_PARAM_INVALID');
    expect(execute(base.document, 'thicken_surface', { id: 'x', thickness: 1 }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expectPure(base.document, () => execute(base.document, 'thicken_surface', { id, thickness: 1 }));
  });
});
