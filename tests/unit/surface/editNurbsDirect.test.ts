import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type NurbsCurveEntity, type NurbsSurfaceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { evaluateSurface } from '@lib/nurbs/surface';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

const curvePoles = [
  [0, 0, 0],
  [1, 1, 0],
  [2, -1, 0],
  [3, 1, 0],
  [4, -1, 0],
  [5, 1, 0],
  [6, 0, 0],
];
const curveDoc = run(empty, 'create_nurbs_curve', { degree: 3, poles: curvePoles, knots: [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1] });
const curveId = curveDoc.affected[0] as string;
const curveOf = (doc: CadDocument): NurbsCurveEntity => doc.entities[curveId] as NurbsCurveEntity;

const grid = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => [i, j, 0]));
const surfaceDoc = run(empty, 'create_nurbs_surface', { degreeU: 3, degreeV: 3, poles: grid });
const surfaceId = surfaceDoc.affected[0] as string;
const surfaceOf = (doc: CadDocument): NurbsSurfaceEntity => doc.entities[surfaceId] as NurbsSurfaceEntity;

describe('edit_nurbs drag_point (VC-DIR-12)', () => {
  it('moves C(0.4) by exactly the displacement and leaves far poles untouched', () => {
    const before = evaluateCurve(curveOf(curveDoc.document).curve, 0.4);
    const result = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 0.4, displacement: [0, 1, 0] });
    expect(result.affected).toEqual([curveId]);
    const after = evaluateCurve(curveOf(result.document).curve, 0.4);
    expect(after[0] - before[0]).toBeCloseTo(0, 12);
    expect(after[1] - before[1]).toBeCloseTo(1, 12);
    expect(after[2] - before[2]).toBeCloseTo(0, 12);
    const poles = curveOf(result.document).curve.poles;
    for (const k of [0, 5, 6]) expect(poles[k]).toEqual(curvePoles[k]);
    expect(poles[2]).not.toEqual(curvePoles[2]);
    expect(result.summary).toContain('exactly');
  });

  it('is exact on a rational curve', () => {
    const weighted = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'set_weight', index: 2, weight: 3 }).document;
    const before = evaluateCurve(curveOf(weighted).curve, 0.55);
    const dragged = run(weighted, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 0.55, displacement: [0.3, -0.2, 0.5] });
    const after = evaluateCurve(curveOf(dragged.document).curve, 0.55);
    expect(after[0] - before[0]).toBeCloseTo(0.3, 12);
    expect(after[1] - before[1]).toBeCloseTo(-0.2, 12);
    expect(after[2] - before[2]).toBeCloseTo(0.5, 12);
  });

  it('works at the domain end and is pure', () => {
    const result = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 1, displacement: [0, 0, 2] });
    expect(curveOf(result.document).curve.poles[6]).toEqual([6, 0, 2]);
    expectPure(curveDoc.document, () =>
      run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 0.4, displacement: [0, 1, 0] }),
    );
  });

  it('refuses u outside the domain and missing operands', () => {
    const outside = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 1.5, displacement: [0, 1, 0] });
    expectNoOp(outside, curveDoc.document);
    expect(code(outside)).toBe('DIR_POINT_OUTSIDE_DOMAIN');
    expect(code(run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'drag_point', u: 0.4 }))).toBe('DIR_OPERATION_PARAMS');
  });
});

describe('edit_nurbs move_poles', () => {
  it('moves selected poles by the delta, neighbours by the falloff weight', () => {
    const result = run(curveDoc.document, 'edit_nurbs', {
      id: curveId,
      operation: 'move_poles',
      indices: [3],
      delta: [0, 0, 2],
      falloff: { radius: 2, shape: 'linear' },
    });
    const poles = curveOf(result.document).curve.poles;
    expect(poles[3]?.[2]).toBe(2);
    expect(poles[2]?.[2]).toBeCloseTo(1, 12);
    expect(poles[4]?.[2]).toBeCloseTo(1, 12);
    expect(poles[1]?.[2]).toBe(0);
    expectPure(curveDoc.document, () =>
      run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'move_poles', indices: [3], delta: [0, 0, 2] }),
    );
  });

  it('without falloff moves only the selection; refuses range and missing delta', () => {
    const result = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'move_poles', indices: [1, 2], delta: [1, 0, 0] });
    const poles = curveOf(result.document).curve.poles;
    expect([poles[1]?.[0], poles[2]?.[0], poles[3]?.[0]]).toEqual([2, 3, 3]);
    const bad = run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'move_poles', indices: [1, 9], delta: [1, 0, 0] });
    expect(code(bad)).toBe('DIR_POLE_RANGE');
    expect(bad.error?.paths).toEqual(['params.indices.1']);
    expectNoOp(bad, curveDoc.document);
    expect(code(run(curveDoc.document, 'edit_nurbs', { id: curveId, operation: 'move_poles', indices: [1] }))).toBe('DIR_OPERATION_PARAMS');
  });
});

describe('edit_nurbs_surface', () => {
  it('drag_point moves S(0.3, 0.6) by exactly (0, 0, 1) (VC-DIR-13)', () => {
    const before = evaluateSurface(surfaceOf(surfaceDoc.document).surface, 0.3, 0.6);
    const result = run(surfaceDoc.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'drag_point',
      u: 0.3,
      v: 0.6,
      displacement: [0, 0, 1],
    });
    const after = evaluateSurface(surfaceOf(result.document).surface, 0.3, 0.6);
    expect([after[0] - before[0], after[1] - before[1], after[2] - before[2]].map((x) => Math.abs(x))).toEqual([
      expect.closeTo(0, 12),
      expect.closeTo(0, 12),
      expect.closeTo(1, 12),
    ]);
    expect(result.affected).toEqual([surfaceId]);
    expectPure(surfaceDoc.document, () =>
      run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'drag_point', u: 0.3, v: 0.6, displacement: [0, 0, 1] }),
    );
  });

  it('drag_point on a rational patch is exact', () => {
    const weighted = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'set_weight', i: 2, j: 2, weight: 4 });
    expect(weighted.affected).toEqual([surfaceId]);
    const before = evaluateSurface(surfaceOf(weighted.document).surface, 0.45, 0.5);
    const result = run(weighted.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'drag_point',
      u: 0.45,
      v: 0.5,
      displacement: [0.5, 0, 0.25],
    });
    const after = evaluateSurface(surfaceOf(result.document).surface, 0.45, 0.5);
    expect(after[0] - before[0]).toBeCloseTo(0.5, 12);
    expect(after[2] - before[2]).toBeCloseTo(0.25, 12);
  });

  it('insert_knot and elevate_degree keep the shape (VC-DIR-14)', () => {
    const inserted = run(surfaceDoc.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'insert_knot',
      direction: 'u',
      u: 0.25,
      times: 1,
    });
    expect(surfaceOf(inserted.document).surface.poles).toHaveLength(6);
    expect(inserted.summary).toMatch(/shape change \d(\.\d)?e-1\d/);
    const insertedV = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'insert_knot', direction: 'v', v: 0.3 });
    expect(surfaceOf(insertedV.document).surface.poles[0]).toHaveLength(6);
    const elevated = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'elevate_degree', direction: 'v', by: 1 });
    expect(surfaceOf(elevated.document).surface.degreeV).toBe(4);
    expect(elevated.summary).toContain('shape change');
  });

  it('move_poles with rows, cols, rect, poles and a U/V falloff', () => {
    const rows = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'move_poles', rows: [0], delta: [0, 0, 1] });
    expect(surfaceOf(rows.document).surface.poles[0]?.every((p) => p[2] === 1)).toBe(true);
    expect(surfaceOf(rows.document).surface.poles[1]?.every((p) => p[2] === 0)).toBe(true);
    const cols = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'move_poles', cols: [4], delta: [0, 0, 1] });
    expect(surfaceOf(cols.document).surface.poles.every((row) => row[4]?.[2] === 1)).toBe(true);
    const rect = run(surfaceDoc.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'move_poles',
      rect: { i0: 1, i1: 2, j0: 1, j1: 2 },
      delta: [0, 0, 1],
    });
    expect(rect.summary).toContain('4 selected');
    const soft = run(surfaceDoc.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'move_poles',
      poles: [[2, 2]],
      delta: [0, 0, 1],
      falloff: { radiusU: 2, radiusV: 2, shape: 'linear' },
    });
    const poles = surfaceOf(soft.document).surface.poles;
    expect(poles[2]?.[2]?.[2]).toBe(1);
    expect(poles[3]?.[2]?.[2]).toBeCloseTo(0.5, 12);
    expect(poles[3]?.[3]?.[2]).toBeCloseTo(0.5, 12);
    expect(poles[4]?.[2]?.[2]).toBe(0);
    expect(poles[0]?.[0]?.[2]).toBe(0);
    const asymmetric = run(surfaceDoc.document, 'edit_nurbs_surface', {
      id: surfaceId,
      operation: 'move_poles',
      poles: [[2, 2]],
      delta: [0, 0, 1],
      falloff: { radiusU: 0, radiusV: 2 },
    });
    const flat = surfaceOf(asymmetric.document).surface.poles;
    expect(flat[1]?.[2]?.[2]).toBe(0);
    expect(flat[2]?.[3]?.[2]).toBeGreaterThan(0);
  });

  it('reverse and transpose keep the surface set; refuse on a trimmed sheet', () => {
    const reversed = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'reverse', direction: 'u' });
    expect(surfaceOf(reversed.document).surface.poles[0]?.[0]).toEqual([4, 0, 0]);
    const transposed = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'transpose' });
    expect(surfaceOf(transposed.document).surface.poles[1]?.[0]).toEqual([0, 1, 0]);
    const trimmedDoc: CadDocument = {
      ...surfaceDoc.document,
      entities: {
        ...surfaceDoc.document.entities,
        [surfaceId]: {
          ...surfaceOf(surfaceDoc.document),
          trims: [
            {
              outer: true,
              polygon: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            },
          ],
        },
      },
    };
    const refused = run(trimmedDoc, 'edit_nurbs_surface', { id: surfaceId, operation: 'transpose' });
    expect(code(refused)).toBe('DIR_TRIMS_BLOCK');
    expectNoOp(refused, trimmedDoc);
  });

  it('refuses a curve id', () => {
    const result = run(curveDoc.document, 'edit_nurbs_surface', { id: curveId, operation: 'transpose' });
    expect(code(result)).toBe('SRF_NOT_SURFACE');
    expectNoOp(result, curveDoc.document);
  });

  it('set_weight makes the sheet rational', () => {
    const result = run(surfaceDoc.document, 'edit_nurbs_surface', { id: surfaceId, operation: 'set_weight', i: 1, j: 3, weight: 2 });
    expect(surfaceOf(result.document).surface.weights?.[1]?.[3]).toBe(2);
    expect(surfaceOf(result.document).surface.weights?.[0]?.[0]).toBe(1);
  });

  it.each([
    ['unknown id', { id: 'nope', operation: 'transpose' }, 'SRF_ENTITY_NOT_FOUND'],
    ['pole outside the grid', { id: surfaceId, operation: 'move_poles', poles: [[5, 0]], delta: [0, 0, 1] }, 'DIR_POLE_RANGE'],
    ['row outside', { id: surfaceId, operation: 'move_poles', rows: [7], delta: [0, 0, 1] }, 'DIR_POLE_RANGE'],
    ['column outside', { id: surfaceId, operation: 'move_poles', cols: [-1], delta: [0, 0, 1] }, 'DIR_POLE_RANGE'],
    ['rect rows', { id: surfaceId, operation: 'move_poles', rect: { i0: 3, i1: 9, j0: 0, j1: 1 }, delta: [0, 0, 1] }, 'DIR_POLE_RANGE'],
    ['rect columns', { id: surfaceId, operation: 'move_poles', rect: { i0: 0, i1: 1, j0: 3, j1: 2 }, delta: [0, 0, 1] }, 'DIR_POLE_RANGE'],
    ['empty selection', { id: surfaceId, operation: 'move_poles', delta: [0, 0, 1] }, 'DIR_OPERATION_PARAMS'],
    ['no delta', { id: surfaceId, operation: 'move_poles', rows: [0] }, 'DIR_OPERATION_PARAMS'],
    ['weight pole outside', { id: surfaceId, operation: 'set_weight', i: 9, j: 0, weight: 1 }, 'DIR_POLE_RANGE'],
    ['weight not positive', { id: surfaceId, operation: 'set_weight', i: 0, j: 0, weight: 0 }, 'SRF_NURBS_INVALID'],
    ['set_weight operands', { id: surfaceId, operation: 'set_weight' }, 'DIR_OPERATION_PARAMS'],
    [
      'drag outside the domain',
      { id: surfaceId, operation: 'drag_point', u: 2, v: 0.5, displacement: [0, 0, 1] },
      'DIR_POINT_OUTSIDE_DOMAIN',
    ],
    ['drag v outside', { id: surfaceId, operation: 'drag_point', u: 0.5, v: -1, displacement: [0, 0, 1] }, 'DIR_POINT_OUTSIDE_DOMAIN'],
    ['drag operands', { id: surfaceId, operation: 'drag_point', u: 0.5 }, 'DIR_OPERATION_PARAMS'],
    ['knot on the boundary', { id: surfaceId, operation: 'insert_knot', direction: 'u', u: 0 }, 'DIR_POINT_OUTSIDE_DOMAIN'],
    ['knot operands', { id: surfaceId, operation: 'insert_knot' }, 'DIR_OPERATION_PARAMS'],
    ['knot multiplicity', { id: surfaceId, operation: 'insert_knot', direction: 'u', u: 0.5, times: 9 }, 'SRF_NURBS_INVALID'],
    ['elevate direction', { id: surfaceId, operation: 'elevate_degree' }, 'DIR_OPERATION_PARAMS'],
    ['reverse direction', { id: surfaceId, operation: 'reverse' }, 'DIR_OPERATION_PARAMS'],
  ])('refuses %s', (_name, params, expected) => {
    const result = run(surfaceDoc.document, 'edit_nurbs_surface', params);
    expect(code(result)).toBe(expected);
    expectNoOp(result, surfaceDoc.document);
  });
});
