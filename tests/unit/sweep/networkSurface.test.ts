/** SWG M7: network_surface (Gordon through an unordered net, edge matching) — validation VC-SWG-23, 26; target_network_ruled. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type NurbsSurfaceEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateSurface, surfaceDomain } from '@lib/nurbs/surface';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { runSwgPlan, swgPlan } from '../../helpers/swgPack';

const empty = createEmptyDocument();

function curve(doc: CadDocument, points: number[][], degree = 3): { doc: CadDocument; id: string } {
  const result = execute(doc, 'interpolate_curve', { points, degree, parameterization: 'uniform' });
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
}

/** 3 curves along x (y = 0, 0.5, 1) and 3 along y (x = 0, 0.5, 1) of z = f(x, y). */
function net(f: (x: number, y: number) => number): { doc: CadDocument; ids: string[] } {
  let doc = empty;
  const ids: string[] = [];
  for (const v of [0, 0.5, 1]) {
    const along = Array.from({ length: 21 }, (_, k) => [k / 20, v, f(k / 20, v)]);
    const made = curve(doc, along);
    doc = made.doc;
    ids.push(made.id);
  }
  for (const u of [0, 0.5, 1]) {
    const across = Array.from({ length: 9 }, (_, k) => [u, k / 8, f(u, k / 8)]);
    const made = curve(doc, across);
    doc = made.doc;
    ids.push(made.id);
  }
  return { doc, ids };
}

describe('target_network_ruled — network step (VC-SWG-23)', () => {
  const actions = swgPlan('target_network_ruled');
  const { steps } = runSwgPlan(actions);
  it('every step of the pack plan succeeds', () => {
    expect(steps.filter((s) => !s.ok).map((s) => `${s.command}: ${s.summary}`)).toEqual([]);
  });
  it('the unordered 3 + 3 net of z = sin(pi x) + y^3 reproduces the surface within 1e-5 (Gordon exactness)', () => {
    const deviation = steps.find((s) => s.command === 'measure_deviation')?.data as { max: number } | undefined;
    expect(deviation?.max).toBeLessThan(1e-5);
    const network = steps.find((s) => s.command === 'network_surface')?.data as {
      families: { sections: string[]; guides: string[] };
      crossingGap: number;
    };
    expect(network.families.sections).toHaveLength(3);
    expect(network.families.guides).toHaveLength(3);
    expect(network.crossingGap).toBeLessThan(1e-6);
  });
  it('the sorted result equals the loft_surface guide result (the two Gordon routes agree)', () => {
    const gordon = steps.find((s) => s.command === 'loft_surface');
    expect(gordon?.ok).toBe(true);
  });
});

describe('network_surface — families, refusals and purity', () => {
  const { doc, ids } = net((x, y) => x * x + y);
  it('sorts curves given shuffled and reversed into the same surface', () => {
    const shuffled = [ids[4], ids[0], ids[5], ids[2], ids[3], ids[1]];
    const first = execute(doc, 'network_surface', { curveIds: ids });
    const second = execute(doc, 'network_surface', { curveIds: shuffled });
    expect(first.affected, first.summary).toHaveLength(1);
    expect(second.affected, second.summary).toHaveLength(1);
    const surface = (result: ReturnType<typeof execute>): NurbsSurfaceEntity =>
      result.document.entities[result.affected[0] as string] as NurbsSurfaceEntity;
    // the surface is z = x^2 + y wherever it is sampled
    const worst = (entity: NurbsSurfaceEntity): number => {
      const [[u0, u1], [v0, v1]] = surfaceDomain(entity.surface);
      let miss = 0;
      for (let i = 0; i <= 6; i++)
        for (let j = 0; j <= 6; j++) {
          const [x, y, z] = evaluateSurface(entity.surface, u0 + ((u1 - u0) * i) / 6, v0 + ((v1 - v0) * j) / 6);
          miss = Math.max(miss, Math.abs(z - (x * x + y)));
        }
      return miss;
    };
    expect(worst(surface(first))).toBeLessThan(1e-5);
    expect(worst(surface(second))).toBeLessThan(1e-5);
  });
  it('two curves of one family that cross are SWG_NETWORK_UNSORTABLE', () => {
    const extra = curve(
      doc,
      [
        [0, 0.25, 0.1],
        [1, 0.75, 0.9],
      ],
      1,
    );
    const result = execute(extra.doc, 'network_surface', { curveIds: [...ids, extra.id] });
    expectNoOp(result, extra.doc, 'SWG_NETWORK_UNSORTABLE');
    expect(result.error?.code).toBe('SWG_NETWORK_UNSORTABLE');
  });
  it('an isolated curve is SWG_NETWORK_UNSORTABLE; a cross pair that misses is SWG_NETWORK_NOT_INTERSECTING', () => {
    const far = curve(
      doc,
      [
        [5, 5, 5],
        [6, 6, 6],
      ],
      1,
    );
    expect(execute(far.doc, 'network_surface', { curveIds: [...ids, far.id] }).error?.code).toBe('SWG_NETWORK_UNSORTABLE');
    const lifted = net((x, y) => x * x + y);
    const apart = curve(
      lifted.doc,
      Array.from({ length: 9 }, (_, k) => [0.75, (0.25 * k) / 8, 0.75 * 0.75 + (0.25 * k) / 8]),
      3,
    );
    const swapped = [...lifted.ids.slice(0, 5), apart.id];
    const result = execute(apart.doc, 'network_surface', { curveIds: swapped });
    expectNoOp(result, apart.doc, 'SWG_NETWORK_NOT_INTERSECTING');
    expect(result.error?.code).toBe('SWG_NETWORK_NOT_INTERSECTING');
  });
  it('fewer than 6 curves, unknown ids and a bad tolerance are coded no-ops', () => {
    expectNoOp(execute(doc, 'network_surface', { curveIds: ids.slice(0, 5) }), doc, 'SWG_NETWORK_UNSORTABLE');
    expect(execute(doc, 'network_surface', { curveIds: [...ids.slice(0, 5), 'nope'] }).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expect(execute(doc, 'network_surface', { curveIds: ids, tolerance: -1 }).error?.code).toBe('SWG_PARAM_INVALID');
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'network_surface', { curveIds: ids }));
  });
});

describe('network_surface — edge matching (VC-SWG-26)', () => {
  it('G1 along u0 leaves a flat neighbour tangent (measured angle below 0.01 rad); G0 only measures; a stranger edge is refused', () => {
    const { doc, ids } = net((x) => x);
    const plane = execute(doc, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [-1, 0, 0],
          [-1, 1, 0],
        ],
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
      ],
    });
    const neighbourId = plane.affected[0] as string;
    const g1 = execute(plane.document, 'network_surface', {
      curveIds: ids,
      edgeMatch: [{ boundary: 'u0', neighbourId, continuity: 'G1' }],
    });
    expect(g1.affected, g1.summary).toHaveLength(1);
    const boundary = (g1.data as { boundaries: Array<{ g0Gap: number; g1AngleRad: number; requested: string }> }).boundaries[0];
    expect(boundary?.requested).toBe('G1');
    expect(boundary?.g0Gap).toBeLessThan(1e-4);
    expect(boundary?.g1AngleRad).toBeLessThan(0.01);
    const g0 = execute(plane.document, 'network_surface', {
      curveIds: ids,
      edgeMatch: [{ boundary: 'u0', neighbourId, continuity: 'G0' }],
    });
    expect((g0.data as { boundaries: Array<{ g1AngleRad: number }> }).boundaries[0]?.g1AngleRad).toBeGreaterThan(0.1);
    const stranger = execute(plane.document, 'network_surface', {
      curveIds: ids,
      edgeMatch: [{ boundary: 'u1', neighbourId, continuity: 'G1' }],
    });
    expectNoOp(stranger, plane.document, 'SRF_FILL_NEIGHBOUR_MISMATCH');
    expect(
      execute(plane.document, 'network_surface', { curveIds: ids, edgeMatch: [{ boundary: 'u0', neighbourId: 'nope', continuity: 'G1' }] })
        .error?.code,
    ).toBe('SRF_ENTITY_NOT_FOUND');
  });
});
