/** SWG M5/M7: loft coupling (arc length, vertices), loft_surface v2, and the loft / sheet checks (validation VC-SWG-37, 28). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type LoftEntity, type NurbsSurfaceEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { loftFacesVolume } from '../../helpers/loftVolume';
import { relError, swgValue } from '../../helpers/swgPack';

const empty = createEmptyDocument();

const circlePoles = (r: number, z: number): number[][] => [
  [r, 0, z],
  [r, r, z],
  [0, r, z],
  [-r, r, z],
  [-r, 0, z],
  [-r, -r, z],
  [0, -r, z],
  [r, -r, z],
  [r, 0, z],
];

/** square 20 (start corner (10, -10), counter-clockwise) at z = 0 and circle r 10 at z = 50 (start at angle 0), as nurbs curves. */
function squareAndCircle(): { doc: CadDocument; ids: [string, string] } {
  const square = execute(empty, 'create_nurbs_curve', {
    degree: 1,
    poles: [
      [10, -10, 0],
      [10, 10, 0],
      [-10, 10, 0],
      [-10, -10, 0],
      [10, -10, 0],
    ],
  });
  const circle = execute(square.document, 'create_nurbs_curve', {
    degree: 2,
    poles: circlePoles(10, 50),
    weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  });
  return { doc: circle.document, ids: [square.affected[0] as string, circle.affected[0] as string] };
}

function loft(
  doc: CadDocument,
  params: Record<string, unknown>,
): { entity: LoftEntity; data: Record<string, number | null>; doc: CadDocument } {
  const result = execute(doc, 'loft_sections', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return {
    entity: result.document.entities[result.affected[0] as string] as LoftEntity,
    data: result.data as Record<string, number | null>,
    doc: result.document,
  };
}

describe('loft_sections coupling (VC-SWG-37)', () => {
  const { doc, ids } = squareAndCircle();
  it('arc-length coupling of a square to a circle (ruled, seams aligned): 17 904.763, corners kept as 4 faces', () => {
    const { entity, data } = loft(doc, { sectionIds: ids, ruled: true, alignment: 'auto', coupling: 'arc_length' });
    expect(relError(loftFacesVolume(entity), swgValue('VC-SWG-37', 'ruled_square20_to_circle10_arc_length'))).toBeLessThan(1e-5);
    expect(data['faces']).toBe(4);
    expect(data['fitDeviation']).toBeLessThan(1e-4);
  });
  it('vertex coupling pairs the square corners with the circle points at the same angles: the same volume', () => {
    const { entity, data } = loft(doc, {
      sectionIds: ids,
      ruled: true,
      alignment: 'none',
      coupling: 'vertices',
      vertexPairs: [
        [0, 0.25, 0.5, 0.75],
        [0.875, 0.125, 0.375, 0.625],
      ],
    });
    expect(data['faces']).toBe(4);
    expect(entity.faces).toHaveLength(4);
    // each face is a ruled patch between a straight edge and a quarter arc paired by parameter: the lateral area is right to the arc's rational parametrisation
    expect(relError(loftFacesVolume(entity), swgValue('VC-SWG-37', 'ruled_square20_to_circle10_arc_length'))).toBeLessThan(0.005);
  });
  it('mismatched or malformed vertex lists are SWG_LOFT_COUPLING_MISMATCH', () => {
    for (const vertexPairs of [
      undefined,
      [[0, 0.5]],
      [[0, 0.5], [0]],
      [
        [0, 2],
        [0, 0.5],
      ],
      [
        [0.25, 0.25],
        [0, 0.5],
      ],
    ]) {
      const result = execute(doc, 'loft_sections', { sectionIds: ids, ruled: true, coupling: 'vertices', vertexPairs });
      expectNoOp(result, doc, 'SWG_LOFT_COUPLING_MISMATCH');
      expect(result.error?.code).toBe('SWG_LOFT_COUPLING_MISMATCH');
    }
  });
  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'loft_sections', { sectionIds: ids, ruled: true, coupling: 'arc_length' }));
  });
});

describe('loft_surface v2 — conditions, alignment, coupling, closed', () => {
  const { doc, ids } = squareAndCircle();
  it('a smooth sheet with normal ends reports its end angles', () => {
    const circle = (r: number, z: number): Record<string, unknown> => ({
      degree: 2,
      poles: circlePoles(r, z),
      weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
      knots: [0, 0.25, 0.5, 0.75, 1],
      multiplicities: [3, 2, 2, 2, 3],
    });
    const a = execute(empty, 'create_nurbs_curve', circle(10, 0));
    const b = execute(a.document, 'create_nurbs_curve', circle(5, 50));
    const result = execute(b.document, 'loft_surface', {
      sectionIds: [a.affected[0], b.affected[0]],
      startCondition: { type: 'normal' },
      endCondition: { type: 'normal' },
    });
    expect(result.affected, result.summary).toHaveLength(1);
    expect((result.data as { startAngleRad: number }).startAngleRad).toBeLessThan(1e-6);
    expect(result.document.entities[result.affected[0] as string]?.kind).toBe('nurbs_surface');
  });
  it('coupling makes one sheet per face', () => {
    const result = execute(doc, 'loft_surface', { sectionIds: ids, degreeV: 1, coupling: 'arc_length', alignment: 'auto' });
    expect(result.affected, result.summary).toHaveLength(4);
    for (const id of result.affected) expect((result.document.entities[id] as NurbsSurfaceEntity).kind).toBe('nurbs_surface');
  });
  it('a bad condition is a coded no-op', () => {
    const result = execute(doc, 'loft_surface', { sectionIds: ids, startCondition: { type: 'direction' } });
    expectNoOp(result, doc, 'SWG_LOFT_END_CONDITION_INVALID');
  });
});

describe('check_sweep_loft over lofts and sheets (VC-SWG-28)', () => {
  const { doc, ids } = squareAndCircle();
  it('flags a twisted loft and passes an aligned one', () => {
    const twisted = loft(doc, { sectionIds: ids, ruled: true, alignment: 'none' });
    const aligned = loft(twisted.doc, { sectionIds: ids, ruled: true, alignment: 'auto' });
    const result = execute(aligned.doc, 'check_sweep_loft', { ids: [twisted.entity.id, aligned.entity.id] });
    const data = result.data as {
      status: string;
      findings: Array<{ code: string; entityId: string }>;
      tolerances: Record<string, { defaulted: boolean; source: string }>;
    };
    expect(data.status).toBe('warn');
    expect(data.findings.filter((f) => f.code === 'SWG_CHECK_LOFT_TWIST').map((f) => f.entityId)).toEqual([twisted.entity.id]);
    expect(data.tolerances['endAngleRad']?.defaulted).toBe(true);
    expect(data.tolerances['endAngleRad']?.source).toContain('TolAngular');
  });
  it('checks a swept sheet by id and omits sheets when no ids are given', () => {
    const swept = execute(empty, 'sweep_surface', {
      path: [
        [0, 0, 0],
        [0, 0, 20],
      ],
      section: {
        line: [
          [0, 0],
          [5, 0],
        ],
      },
    });
    const sheetId = swept.affected[0] as string;
    const named = execute(swept.document, 'check_sweep_loft', { ids: [sheetId] });
    expect((named.data as { status: string }).status).toBe('pass');
    const all = execute(swept.document, 'check_sweep_loft', {});
    expect((all.data as { checked: string[] }).checked).toEqual([]);
  });
  it('a pinched skin fails SWG_CHECK_SURFACE_DEGENERATE; unknown ids and bad tolerances are refused', () => {
    const cone = execute(empty, 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        [
          [10, 0, 0],
          [10, 0, 0],
        ],
      ],
    });
    const id = cone.affected[0] as string;
    const result = execute(cone.document, 'check_sweep_loft', { ids: [id] });
    expect((result.data as { status: string }).status).toBe('fail');
    expectNoOp(execute(cone.document, 'check_sweep_loft', { ids: ['nope'] }), cone.document, 'SWG_ENTITY_NOT_FOUND');
    expectNoOp(execute(cone.document, 'check_sweep_loft', { endAngleRad: -1 }), cone.document, 'SWG_PARAM_INVALID');
  });
});
