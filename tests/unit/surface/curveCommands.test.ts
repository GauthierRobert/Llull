import { describe, expect, it } from 'vitest';
import { createEmptyDocument, is3D, type CadDocument, type Entity, type NurbsCurveEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { isCurve3D } from '@core/model/curveKinds';
import { entityBounds } from '@core/geometry/bounds';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const empty = createEmptyDocument();
const curveOf = (doc: CadDocument, id: string): NurbsCurveEntity => doc.entities[id] as NurbsCurveEntity;
const errorCode = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

const cubicPoles = [
  [0, 0, 0],
  [1, 2, 0],
  [3, 2, 0],
  [4, 0, 0],
  [6, -1, 1],
];

describe('create_nurbs_curve', () => {
  it('creates a clamped uniform cubic with default knots', () => {
    const result = execute(empty, 'create_nurbs_curve', { degree: 3, poles: cubicPoles, position: [1, 2, 3], name: 'rail' });
    expect(result.affected).toHaveLength(1);
    const entity = curveOf(result.document, result.affected[0]!);
    expect(entity.kind).toBe('nurbs_curve');
    expect(entity.position).toEqual([1, 2, 3]);
    expect(entity.name).toBe('rail');
    expect(entity.curve.knots).toEqual([0, 0.5, 1]);
    expect(entity.curve.multiplicities).toEqual([4, 1, 4]);
    expect(entity.curve.weights).toBeUndefined();
    expect(result.document.order).toEqual([entity.id]);
    expect([is3D(entity), isCurve3D(entity)]).toEqual([false, true]);
    expect(result.summary).toContain(entity.id);
    expect(result.summary).toContain('5 poles');
  });

  it('accepts a full knot vector, or distinct knots with multiplicities, and weights', () => {
    const full = execute(empty, 'create_nurbs_curve', { degree: 2, poles: cubicPoles.slice(0, 4), knots: [0, 0, 0, 0.4, 1, 1, 1] });
    expect(curveOf(full.document, full.affected[0]!).curve.knots).toEqual([0, 0.4, 1]);
    const distinct = execute(empty, 'create_nurbs_curve', {
      degree: 2,
      poles: cubicPoles.slice(0, 4),
      knots: [0, 0.4, 1],
      multiplicities: [3, 1, 3],
      weights: [1, 2, 1, 1],
    });
    expect(curveOf(distinct.document, distinct.affected[0]!).curve.weights).toEqual([1, 2, 1, 1]);
    expect(distinct.summary).toContain('rational');
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'create_nurbs_curve', { degree: 3, poles: cubicPoles }));
  });

  it.each([
    ['degree above the maximum', { degree: 26, poles: cubicPoles }, 'params.degree'],
    ['too few poles', { degree: 3, poles: cubicPoles.slice(0, 3) }, 'params.poles'],
    ['non-integer degree', { degree: 2.5, poles: cubicPoles }, 'params.degree'],
    ['negative weight', { degree: 3, poles: cubicPoles, weights: [1, 1, -1, 1, 1] }, 'params.weights.2'],
    ['unclamped knots', { degree: 3, poles: cubicPoles, knots: [0, 0, 1, 1] }, 'params.multiplicities'],
    ['non-increasing knots', { degree: 3, poles: cubicPoles, knots: [0, 1, 0.5], multiplicities: [4, 1, 4] }, 'params.knots'],
    ['bad multiplicities', { degree: 3, poles: cubicPoles, knots: [0, 1], multiplicities: [4, 3] }, 'params.multiplicities'],
  ])('%s is refused with SRF_NURBS_INVALID', (_label, params, path) => {
    const result = execute(empty, 'create_nurbs_curve', params);
    expectNoOp(result, empty);
    expect(errorCode(result)).toBe('SRF_NURBS_INVALID');
    expect(result.error?.paths).toEqual([path]);
  });

  it('refuses more than 10000 poles', () => {
    const poles = Array.from({ length: 10_001 }, (_, i) => [i, 0, 0]);
    expect(errorCode(execute(empty, 'create_nurbs_curve', { degree: 1, poles }))).toBe('SRF_NURBS_INVALID');
  });
});

describe('interpolate_curve', () => {
  const points = [
    [0, 0, 0],
    [1, 1, 0],
    [2, 0.5, 1],
    [3, -1, 0],
    [4, 0, 2],
  ];

  it('creates a cubic through the points and reports the residual', () => {
    const result = execute(empty, 'interpolate_curve', { points, parameterization: 'centripetal' });
    const entity = curveOf(result.document, result.affected[0]!);
    expect(entity.curve.degree).toBe(3);
    expect(entity.curve.poles).toHaveLength(5);
    expect(result.summary).toContain('through 5 points');
    expect(result.summary).toMatch(/residual \d\.\d\de-\d+/);
  });

  it('takes end tangents and a degree', () => {
    const result = execute(empty, 'interpolate_curve', {
      points,
      degree: 4,
      startTangent: [0, 1, 0],
      endTangent: [1, 0, 0],
      color: '#ff0000',
    });
    const entity = curveOf(result.document, result.affected[0]!);
    expect(entity.curve.degree).toBe(4);
    expect(entity.curve.poles).toHaveLength(7);
    expect(entity.color).toBe('#ff0000');
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'interpolate_curve', { points }));
  });

  it.each([
    ['too few points', { points: points.slice(0, 2) }, 'SRF_POINTS_INSUFFICIENT'],
    ['coincident points', { points: [points[0], points[0], points[1], points[2]] }, 'SRF_POINTS_COINCIDENT'],
    ['degree out of range', { points, degree: 40 }, 'SRF_NURBS_INVALID'],
    ['zero tangent', { points, startTangent: [0, 0, 0] }, 'SRF_NURBS_INVALID'],
    ['tangent on a linear curve', { points, degree: 1, endTangent: [1, 0, 0] }, 'SRF_NURBS_INVALID'],
  ])('%s is refused', (_label, params, code) => {
    const result = execute(empty, 'interpolate_curve', params);
    expectNoOp(result, empty);
    expect(errorCode(result)).toBe(code);
  });

  it('refuses more than 10000 points and names the coincident index', () => {
    const many = Array.from({ length: 10_001 }, (_, i) => [i, 0, 0]);
    expect(errorCode(execute(empty, 'interpolate_curve', { points: many }))).toBe('SRF_POINTS_INSUFFICIENT');
    const duplicate = execute(empty, 'interpolate_curve', { points: [points[0], points[0], points[1], points[2]] });
    expect(duplicate.error?.paths).toEqual(['params.points.1']);
  });
});

describe('create_conic', () => {
  const quarter = { start: [1, 0, 0], apex: [1, 1, 0], end: [0, 1, 0] };

  it('makes the exact unit quarter circle for rho = sqrt(2) - 1', () => {
    const result = execute(empty, 'create_conic', { ...quarter, rho: Math.SQRT2 - 1 });
    const entity = curveOf(result.document, result.affected[0]!);
    expect(entity.curve.degree).toBe(2);
    expect(entity.curve.weights![1]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(result.summary).toContain('elliptic');
  });

  it('classifies parabolic and hyperbolic arcs and accepts tangents and a shoulder point', () => {
    expect(execute(empty, 'create_conic', { ...quarter, rho: 0.5 }).summary).toContain('parabolic');
    expect(execute(empty, 'create_conic', { ...quarter, rho: 0.7 }).summary).toContain('hyperbolic');
    const tangents = execute(empty, 'create_conic', {
      start: [1, 0, 0],
      end: [0, 1, 0],
      startTangent: [0, 1, 0],
      endTangent: [1, 0, 0],
      rho: 0.3,
    });
    expect(curveOf(tangents.document, tangents.affected[0]!).curve.poles[1]).toEqual([1, 1, 0]);
    const shoulder = execute(empty, 'create_conic', { ...quarter, shoulder: [Math.SQRT1_2, Math.SQRT1_2, 0] });
    expect(curveOf(shoulder.document, shoulder.affected[0]!).curve.weights![1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('is pure', () => {
    expectPure(empty, () => execute(empty, 'create_conic', { ...quarter, rho: 0.4 }));
  });

  it.each([
    ['rho 0', { ...quarter, rho: 0 }, 'SRF_CONIC_RHO_RANGE'],
    ['rho 1', { ...quarter, rho: 1 }, 'SRF_CONIC_RHO_RANGE'],
    ['collinear', { start: [0, 0, 0], apex: [1, 0, 0], end: [2, 0, 0], rho: 0.4 }, 'SRF_CONIC_COLLINEAR'],
    [
      'parallel tangents',
      { start: [0, 0, 0], end: [0, 1, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], rho: 0.4 },
      'SRF_CONIC_COLLINEAR',
    ],
    ['apex and tangents', { ...quarter, startTangent: [0, 1, 0], endTangent: [1, 0, 0], rho: 0.4 }, 'SRF_PARAM_INVALID'],
    ['no apex nor tangents', { start: [1, 0, 0], end: [0, 1, 0], rho: 0.4 }, 'SRF_PARAM_INVALID'],
    ['rho and shoulder', { ...quarter, rho: 0.4, shoulder: [0.7, 0.7, 0] }, 'SRF_PARAM_INVALID'],
    ['neither rho nor shoulder', quarter, 'SRF_PARAM_INVALID'],
    ['shoulder off the axis', { ...quarter, shoulder: [0.5, 0.5, 3] }, 'SRF_PARAM_INVALID'],
  ])('%s is refused', (_label, params, code) => {
    const result = execute(empty, 'create_conic', params);
    expectNoOp(result, empty);
    expect(errorCode(result)).toBe(code);
  });
});

describe('edit_nurbs', () => {
  const base = execute(empty, 'create_nurbs_curve', { degree: 3, poles: cubicPoles });
  const id = base.affected[0]!;

  it('inserts a knot and elevates the degree without changing the shape', () => {
    const inserted = execute(base.document, 'edit_nurbs', { id, operation: 'insert_knot', u: 0.25, times: 2 });
    expect(inserted.affected).toEqual([id]);
    expect(curveOf(inserted.document, id).curve.poles).toHaveLength(7);
    expect(inserted.summary).toMatch(/shape change \d\.\de-1\d/);
    const raised = execute(inserted.document, 'edit_nurbs', { id, operation: 'elevate_degree', by: 2 });
    expect(curveOf(raised.document, id).curve.degree).toBe(5);
    expect(raised.summary).toMatch(/shape change/);
  });

  it('moves a pole, sets a weight and reverses', () => {
    const moved = execute(base.document, 'edit_nurbs', { id, operation: 'move_pole', index: 2, to: [9, 9, 9] });
    expect(curveOf(moved.document, id).curve.poles[2]).toEqual([9, 9, 9]);
    const weighted = execute(base.document, 'edit_nurbs', { id, operation: 'set_weight', index: 1, weight: 3 });
    expect(curveOf(weighted.document, id).curve.weights).toEqual([1, 3, 1, 1, 1]);
    const reversed = execute(base.document, 'edit_nurbs', { id, operation: 'reverse' });
    expect(curveOf(reversed.document, id).curve.poles[0]).toEqual(cubicPoles[4]);
    expect(reversed.document.order).toEqual(base.document.order);
  });

  it('is pure', () => {
    expectPure(base.document, () => execute(base.document, 'edit_nurbs', { id, operation: 'insert_knot', u: 0.3 }));
  });

  it.each([
    ['unknown id', { id: 'nope', operation: 'reverse' }, 'SRF_ENTITY_NOT_FOUND'],
    ['move without operands', { id, operation: 'move_pole' }, 'SRF_NURBS_INVALID'],
    ['weight without operands', { id, operation: 'set_weight', index: 1 }, 'SRF_NURBS_INVALID'],
    ['insert without u', { id, operation: 'insert_knot' }, 'SRF_NURBS_INVALID'],
    ['pole out of range', { id, operation: 'move_pole', index: 9, to: [0, 0, 0] }, 'SRF_NURBS_INVALID'],
    ['knot at the end', { id, operation: 'insert_knot', u: 1 }, 'SRF_NURBS_INVALID'],
    ['too high a degree', { id, operation: 'elevate_degree', by: 30 }, 'SRF_NURBS_INVALID'],
  ])('%s is refused', (_label, params, code) => {
    const result = execute(base.document, 'edit_nurbs', params);
    expectNoOp(result, base.document);
    expect(errorCode(result)).toBe(code);
  });

  it('refuses an entity that is not a nurbs_curve', () => {
    const box = execute(empty, 'add_box', { size: [1, 1, 1] });
    const result = execute(box.document, 'edit_nurbs', { id: box.affected[0]!, operation: 'reverse' });
    expect(errorCode(result)).toBe('SRF_NOT_NURBS');
  });
});

describe('inspect_nurbs', () => {
  it('reports degree, knots, continuity at interior knots, closed flag and length', () => {
    const made = execute(empty, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
        [4, 0, 0],
      ],
      knots: [0, 0, 0, 0.5, 0.5, 1, 1, 1],
    });
    const id = made.affected[0]!;
    const result = execute(made.document, 'inspect_nurbs', { id });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(made.document);
    const data = result.data as Record<string, unknown>;
    expect(data).toMatchObject({
      id,
      type: 'nurbs_curve',
      degree: 2,
      poleCount: 5,
      rational: false,
      closed: false,
      unit: 'mm',
      unverified: false,
    });
    expect(data['interiorContinuity']).toEqual([{ knot: 0.5, multiplicity: 2, continuity: 'C0' }]);
    expect(data['length']).toBeCloseTo(4, 9);
    expect(data['poles']).toHaveLength(5);
  });

  it('flags a closed rational curve and omits poles above the listing cap', () => {
    const ring = execute(empty, 'create_nurbs_curve', {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 0, 0],
      ],
      weights: [1, 1, 1, 1],
    });
    expect((execute(ring.document, 'inspect_nurbs', { id: ring.affected[0]! }).data as { closed: boolean; rational: boolean }).closed).toBe(
      true,
    );
    const points = Array.from({ length: 300 }, (_, i) => [i, Math.sin(i), 0]);
    const long = execute(empty, 'interpolate_curve', { points, degree: 3 });
    const data = execute(long.document, 'inspect_nurbs', { id: long.affected[0]! }).data as Record<string, unknown>;
    expect(data['poleCount']).toBe(300);
    expect(data['poles']).toBeUndefined();
  });

  it('refuses unknown ids and other kinds', () => {
    expect(errorCode(execute(empty, 'inspect_nurbs', { id: 'x' }))).toBe('SRF_ENTITY_NOT_FOUND');
    const line = execute(empty, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(errorCode(execute(line.document, 'inspect_nurbs', { id: line.affected[0]! }))).toBe('SRF_NOT_NURBS');
  });
});

describe('analyze_curve_curvature', () => {
  const circle = execute(empty, 'create_conic', { start: [5, 0, 0], apex: [5, 5, 0], end: [0, 5, 0], rho: Math.SQRT2 - 1 });
  const id = circle.affected[0]!;

  it('returns curvature 1/R, radius, arc length and the comb on a circle', () => {
    const result = execute(circle.document, 'analyze_curve_curvature', { id, samples: 5, combScale: 10 });
    expect(result.document).toBe(circle.document);
    const data = result.data as {
      planar: boolean;
      samples: Array<{ t: number; s: number; curvature: number; radius: number; signedCurvature: number; comb: number[]; point: number[] }>;
      length: number;
      inflections: number;
      maxCurvature: number;
      curvatureUnit: string;
    };
    expect(data.planar).toBe(true);
    expect(data.samples).toHaveLength(5);
    for (const sample of data.samples) {
      expect(sample.curvature).toBeCloseTo(0.2, 8);
      expect(sample.radius).toBeCloseTo(5, 6);
      expect(sample.signedCurvature).toBeGreaterThan(0);
      // comb tooth points away from the centre (origin): |comb| = |point| + curvature * scale
      expect(Math.hypot(sample.comb[0]!, sample.comb[1]!)).toBeCloseTo(5 + 0.2 * 10, 6);
    }
    expect(data.samples[0]!.s).toBe(0);
    expect(data.samples[4]!.s).toBeCloseTo((5 * Math.PI) / 2, 8);
    expect(data.length).toBeCloseTo((5 * Math.PI) / 2, 8);
    expect(data.inflections).toBe(0);
    expect(data.curvatureUnit).toBe('1/mm');
    expect(result.summary).toContain('5 samples');
  });

  it('counts the inflection of an S-curve and samples explicit parameters', () => {
    const s = execute(empty, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 0],
        [3, -1, 0],
        [4, 0, 0],
      ],
    });
    const result = execute(s.document, 'analyze_curve_curvature', { id: s.affected[0]!, samples: 101 });
    expect((result.data as { inflections: number }).inflections).toBeGreaterThanOrEqual(1);
    const picked = execute(circle.document, 'analyze_curve_curvature', { id, parameters: [0.9, 0.1] });
    const rows = (picked.data as { samples: Array<{ t: number; s: number }> }).samples;
    expect(rows.map((row) => row.t)).toEqual([0.9, 0.1]);
    expect(rows[0]!.s).toBeGreaterThan(rows[1]!.s);
  });

  it('flags degenerate samples of a curve with a zero-speed point', () => {
    const cusp = execute(empty, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [0, 0, 0],
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    const data = execute(cusp.document, 'analyze_curve_curvature', { id: cusp.affected[0]!, parameters: [0] }).data as {
      degenerateSamples: number;
    };
    expect(data.degenerateSamples).toBe(1);
  });

  it('works for a non-planar curve (no signed curvature)', () => {
    const helix = execute(empty, 'interpolate_curve', {
      points: Array.from({ length: 40 }, (_, i) => [Math.cos(i / 6), Math.sin(i / 6), i / 30]),
      degree: 5,
    });
    const data = execute(helix.document, 'analyze_curve_curvature', { id: helix.affected[0]!, samples: 7 }).data as {
      planar: boolean;
      inflections?: number;
      samples: Array<Record<string, unknown>>;
    };
    expect(data.planar).toBe(false);
    expect(data.inflections).toBeUndefined();
    expect(data.samples[3]!['signedCurvature']).toBeUndefined();
  });

  it('is pure and read-only', () => {
    expectPure(circle.document, () => execute(circle.document, 'analyze_curve_curvature', { id }));
  });

  it.each([
    ['too few samples', { id, samples: 1 }],
    ['too many samples', { id, samples: 1001 }],
    ['parameter outside the domain', { id, parameters: [2] }],
    ['empty parameters', { id, parameters: [] }],
  ])('%s is refused with SRF_PARAM_INVALID', (_label, params) => {
    const result = execute(circle.document, 'analyze_curve_curvature', params);
    expect(result.affected).toEqual([]);
    expect(errorCode(result)).toBe('SRF_PARAM_INVALID');
  });

  it('refuses unknown ids', () => {
    expect(errorCode(execute(circle.document, 'analyze_curve_curvature', { id: 'nope' }))).toBe('SRF_ENTITY_NOT_FOUND');
  });
});

describe('nurbs_curve as an entity', () => {
  const made = execute(empty, 'create_nurbs_curve', { degree: 3, poles: cubicPoles, position: [10, 0, 0] });
  const id = made.affected[0]!;
  const entity = made.document.entities[id] as Entity;

  it('has bounds from its poles in the entity frame, and no triangles', () => {
    const bounds = entityBounds(entity);
    expect(bounds.min).toEqual([10, -1, 0]);
    expect(bounds.max).toEqual([16, 2, 1]);
    expect(solidTriangles(entity)).toEqual([]);
  });

  it('scales its poles with scale_entity', () => {
    const scaled = execute(made.document, 'scale_entity', { id, factor: 2 });
    expect(curveOf(scaled.document, id).curve.poles[4]).toEqual([12, -2, 2]);
    expect(scaled.summary).toContain('5 poles');
  });

  it('draws in render_view and is found by find_entities', () => {
    const rendered = execute(made.document, 'render_view', { view: 'top', showGrid: false }).data as { svg: string };
    expect(rendered.svg).toContain('<polyline');
    const found = execute(made.document, 'find_entities', { kind: 'nurbs_curve' });
    expect((found.data as { count: number }).count).toBe(1);
  });

  it('validates stored curves on load', () => {
    expect(validateEntityValue(JSON.parse(JSON.stringify(entity)))).toBeNull();
    const broken = JSON.parse(JSON.stringify(entity)) as { curve: { multiplicities: number[] } };
    broken.curve.multiplicities = [4, 1, 1];
    expect(validateEntityValue(broken)).toMatch(/curve\.multiplicities/);
    expect(validateEntityValue({ ...JSON.parse(JSON.stringify(entity)), curve: 5 })).toMatch(/curve must be an object/);
    expect(validateEntityValue({ ...JSON.parse(JSON.stringify(entity)), curve: { degree: 'x' } })).toMatch(/degree/);
    expect(validateEntityValue({ ...JSON.parse(JSON.stringify(entity)), curve: { degree: 3, poles: 4 } })).toMatch(/poles/);
    expect(
      validateEntityValue({ ...JSON.parse(JSON.stringify(entity)), curve: { degree: 3, poles: cubicPoles, knots: 3, multiplicities: [] } }),
    ).toMatch(/knots/);
    expect(
      validateEntityValue({
        ...JSON.parse(JSON.stringify(entity)),
        curve: { degree: 3, poles: cubicPoles, weights: ['a'], knots: [0, 1], multiplicities: [4, 4] },
      }),
    ).toMatch(/weights/);
  });

  it('survives a save and load round trip', () => {
    expect(deserializeDocument(serializeDocument(made.document)).entities[id]).toEqual(entity);
  });
});
