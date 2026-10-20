import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();

/** Degree (2, 1) strip over x in [x0, x0 + 1] of the parabolic cylinder z = x^2 / 2 (v along y in [0, 1]). */
const parabola = (x0: number): NurbsSurfaceData => {
  const slope = x0;
  const z = [(x0 * x0) / 2, (x0 * x0) / 2 + slope / 2, (x0 + 1) ** 2 / 2];
  return {
    degreeU: 2,
    degreeV: 1,
    poles: [0, 1, 2].map((i) => [
      [x0 + i / 2, 0, z[i]!],
      [x0 + i / 2, 1, z[i]!],
    ]),
    knotsU: [0, 1],
    multiplicitiesU: [3, 3],
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  } as NurbsSurfaceData;
};

const addSheet = (doc: CadDocument, surface: NurbsSurfaceData): { doc: CadDocument; id: string } => {
  const result = execute(doc, 'create_nurbs_surface', { ...surface });
  return { doc: result.document, id: result.affected[0]! };
};

type Joint = { side: string; g0Gap: number; g1AngleRad: number; g2Gap: number; order: string };
const blendData = (result: ReturnType<typeof execute>): { id: string; a: Joint; b: Joint; gap: { mean: number } } =>
  result.data as { id: string; a: Joint; b: Joint; gap: { mean: number } };

describe('blend_surfaces', () => {
  const first = addSheet(empty, parabola(0));
  const both = addSheet(first.doc, parabola(2));
  const ids = { a: { id: first.id, side: 'u1' }, b: { id: both.id, side: 'u0' } };

  it('G1: leaves both sheets tangentially (angle well below 0.01 rad, gap exact at the stations)', () => {
    const result = execute(both.doc, 'blend_surfaces', { ...ids, continuity: 'G1' });
    expect(result.affected).toHaveLength(1);
    const data = blendData(result);
    expect(result.document.entities[data.id]!.kind).toBe('nurbs_surface');
    expect(result.document.order).toEqual([first.id, both.id, data.id]);
    for (const joint of [data.a, data.b]) {
      expect(joint.g0Gap).toBeLessThan(1e-6);
      expect(joint.g1AngleRad).toBeLessThan(1e-4);
      expect(['G1', 'G2', 'G3']).toContain(joint.order);
    }
    expect(data.gap.mean).toBeGreaterThan(1);
    expect(result.summary).toContain('blend_surfaces');
  });

  it('G2: also matches the curvature across both edges, and detects the sides when omitted', () => {
    const result = execute(both.doc, 'blend_surfaces', { a: { id: first.id }, b: { id: both.id }, continuity: 'G2' });
    const data = blendData(result);
    expect([data.a.side, data.b.side]).toEqual(['u1', 'u0']);
    for (const joint of [data.a, data.b]) {
      expect(joint.g0Gap).toBeLessThan(1e-6);
      expect(['G2', 'G3']).toContain(joint.order);
      expect(joint.g2Gap).toBeLessThan(2e-2);
    }
    const checked = execute(result.document, 'check_continuity', {
      pairs: [{ a: { id: first.id, side: 'u1' }, b: { id: data.id, side: 'v0' } }],
      require: 'G2',
    });
    expect((checked.data as { pass: boolean }).pass).toBe(true);
  });

  it('refuses sheets that face away, touching edges, bad parameters and bad ids; is pure', () => {
    // the same two sheets seen from the other sides: the edges at x = 0 and x = 3 leave away from each other
    expectNoOp(
      execute(both.doc, 'blend_surfaces', { a: { id: first.id, side: 'u0' }, b: { id: both.id, side: 'u1' } }),
      both.doc,
      'SRF_BLEND_FOLD',
    );
    const touching = addSheet(first.doc, parabola(1));
    expectNoOp(
      execute(touching.doc, 'blend_surfaces', { a: { id: first.id, side: 'u1' }, b: { id: touching.id, side: 'u0' } }),
      touching.doc,
      'SRF_BLEND_DEGENERATE',
    );
    expectNoOp(execute(both.doc, 'blend_surfaces', { ...ids, factor: 9 }), both.doc, 'SRF_PARAM_INVALID');
    expectNoOp(execute(both.doc, 'blend_surfaces', { ...ids, stations: 3 }), both.doc, 'SRF_PARAM_INVALID');
    expectNoOp(
      execute(both.doc, 'blend_surfaces', { a: { id: first.id, side: 'u1' }, b: { id: first.id, side: 'u1' } }),
      both.doc,
      'SRF_PARAM_INVALID',
    );
    expectNoOp(execute(both.doc, 'blend_surfaces', { a: { id: 'nope' }, b: ids.b }), both.doc, 'SRF_ENTITY_NOT_FOUND');
    const curve = execute(both.doc, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expectNoOp(execute(curve.document, 'blend_surfaces', { a: { id: curve.affected[0]! }, b: ids.b }), curve.document, 'SRF_NOT_SURFACE');
    expectPure(both.doc, () => execute(both.doc, 'blend_surfaces', ids));
  });
});
