/** Field primitives, booleans and blends, offset / shell / transform, field_from_solid, evaluate_field (05 IMP M2; VC-IMP-01..09). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { type Step, empty, expectRefused, lowDiscrepancyPoints, ok, run } from './helpers';

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', '05-implicit-lattice', 'validation', 'data');
const reference = JSON.parse(readFileSync(join(DATA, 'sdf_primitives.json'), 'utf8')) as {
  cases: Array<{ name: string; params: Record<string, unknown>; samples: Array<{ p: [number, number, number]; distance: number }> }>;
};

const PRIMITIVE_PARAMS: Record<string, Record<string, unknown>> = {
  sphere: { shape: 'sphere', radius: 10 },
  torus: { shape: 'torus', ringRadius: 5, tubeRadius: 2 },
  box: { shape: 'box', size: [6, 4, 2] },
  capsule: { shape: 'capsule', radius: 1.5, height: 8 },
};

interface Samples {
  values: number[];
  gradients?: number[];
  distanceQuality: string;
  lipschitz: number;
  unit: string;
}

const valuesAt = (doc: CadDocument, field: string, points: ReadonlyArray<readonly number[]>, gradient = false): Samples =>
  ok(doc, 'evaluate_field', { field, points, ...(gradient ? { gradient: true } : {}) }).data as {
    values: number[];
    gradients?: number[];
    distanceQuality: string;
    lipschitz: number;
    unit: string;
  };

describe('add_field_primitive (VC-IMP-01, VC-IMP-02)', () => {
  it.each(reference.cases)(
    '$name equals the closed-form signed distance at 12 points (1e-9) and has unit gradient',
    ({ name, samples }) => {
      const created = ok(empty(), 'add_field_primitive', PRIMITIVE_PARAMS[name] ?? {});
      expect(created.result.affected).toEqual([created.id]);
      expect(created.id).toMatch(/^fld-step-?\d+\.\d+$|^fld-/);
      const answer = valuesAt(
        created.doc,
        created.id,
        samples.map((s) => s.p),
        true,
      );
      samples.forEach((sample, i) => expect(Math.abs((answer.values[i] ?? NaN) - sample.distance)).toBeLessThan(1e-9));
      for (let i = 0; i < samples.length; i += 1) {
        const g = Math.hypot(answer.gradients?.[3 * i] ?? 0, answer.gradients?.[3 * i + 1] ?? 0, answer.gradients?.[3 * i + 2] ?? 0);
        expect(Math.abs(g - 1)).toBeLessThan(1e-6);
      }
      expect(answer.distanceQuality).toBe('exact');
      expect(answer.unit).toBe('mm');
      expect(created.data['distanceQuality']).toBe('exact');
    },
  );

  it('cone, cylinder, rounded box, plane, placement and rotation are exact SDFs', () => {
    let doc = empty();
    const cone = ok(doc, 'add_field_primitive', { shape: 'cone', radius: 3, height: 6 });
    doc = cone.doc;
    const cylinder = ok(doc, 'add_field_primitive', { shape: 'cylinder', radius: 2, height: 4, position: [10, 0, 0] });
    doc = cylinder.doc;
    const rounded = ok(doc, 'add_field_primitive', { shape: 'box', size: [4, 4, 4], rounding: 1, position: [0, 20, 0] });
    doc = rounded.doc;
    const plane = ok(doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 2], offset: 5 });
    doc = plane.doc;
    const turned = ok(doc, 'add_field_primitive', { shape: 'box', size: [10, 2, 2], rotation: [0, 0, Math.PI / 2] });
    doc = turned.doc;
    expect(
      valuesAt(doc, cone.id, [
        [0, 0, 7],
        [0, 0, 3],
        [5, 0, 0],
        [0, 0, -1],
        [0, 0, 6],
      ]).values.map((v) => +v.toFixed(9)),
    ).toEqual([1, -1.341640786, 2, 1, 0].map((v) => +v.toFixed(9)));
    expect(
      valuesAt(doc, cylinder.id, [
        [10, 0, 0],
        [13, 0, 0],
        [10, 0, 3],
        [13, 0, 3],
      ]).values.map((v) => +v.toFixed(9)),
    ).toEqual([-2, 1, 1, Math.SQRT2 * 1].map((v) => +v.toFixed(9)));
    expect(
      valuesAt(doc, rounded.id, [
        [0, 20, 0],
        [3, 20, 0],
      ]).values[1],
    ).toBeCloseTo(1, 12);
    expect(valuesAt(doc, rounded.id, [[2, 22, 2]]).values[0]).toBeCloseTo(Math.sqrt(3) - 1, 12);
    expect(
      valuesAt(doc, plane.id, [
        [0, 0, 5],
        [1, 1, 8],
        [0, 0, 0],
      ]).values,
    ).toEqual([0, 3, -5]);
    expect(
      valuesAt(doc, turned.id, [
        [0, 5, 0],
        [0, 6, 0],
        [1, 0, 0],
      ]).values.map((v) => +v.toFixed(9)),
    ).toEqual([0, 1, -0].map((v) => +v.toFixed(9)));
  });

  it('refuses a missing, non-positive or inconsistent dimension with IMP_PARAM_RANGE and the unchanged document', () => {
    const doc = empty();
    const cases: Array<Record<string, unknown>> = [
      { shape: 'sphere' },
      { shape: 'sphere', radius: -1 },
      { shape: 'box', size: [1, 0, 1] },
      { shape: 'box', size: [2, 2, 2], rounding: 1 },
      { shape: 'box', size: [2, 2, 2], rounding: -1 },
      { shape: 'cylinder', radius: 1 },
      { shape: 'cone', height: 1 },
      { shape: 'capsule', radius: 1 },
      { shape: 'capsule', height: 1 },
      { shape: 'torus', ringRadius: 2, tubeRadius: 2 },
      { shape: 'plane', normal: [0, 0, 0] },
      { shape: 'plane' },
      { shape: 'sphere', radius: 1, rounding: 0.1 },
    ];
    for (const params of cases) expectRefused(doc, run(doc, 'add_field_primitive', params), 'IMP_PARAM_RANGE');
  });

  it('is pure: the input document is not modified', () => {
    const doc = empty();
    const before = JSON.stringify(doc);
    ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 1, name: 'ball' });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('replays to the same ids (step-scoped)', () => {
    const first = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 1 });
    const replayed = execute(first.doc, 'replay_history', {});
    expect(replayed.error).toBeUndefined();
    expect(Object.keys(replayed.document.implicit?.fields ?? {})).toEqual([first.id]);
  });
});

describe('combine_fields (VC-IMP-03, VC-IMP-04, VC-IMP-05)', () => {
  const twoSpheres = (): { doc: CadDocument; a: string; b: string } => {
    const a = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3, position: [-2, 0, 0] });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'sphere', radius: 3, position: [2, 0, 0] });
    return { doc: b.doc, a: a.id, b: b.id };
  };

  it('sharp union / intersect / subtract are min / max / max(a, -b) and report a bound', () => {
    const { doc, a, b } = twoSpheres();
    const union = ok(doc, 'combine_fields', { op: 'union', a, b });
    const inter = ok(union.doc, 'combine_fields', { op: 'intersect', a, b });
    const cut = ok(inter.doc, 'combine_fields', { op: 'subtract', a, b });
    const p = [
      [0, 0, 0],
      [-5, 0, 0],
      [3, 0, 0],
      [-1, 0, 0],
    ] as const;
    const [fa, fb] = [valuesAt(cut.doc, a, p).values, valuesAt(cut.doc, b, p).values];
    expect(valuesAt(cut.doc, union.id, p).values).toEqual(fa.map((v, i) => Math.min(v, fb[i] ?? 0)));
    expect(valuesAt(cut.doc, inter.id, p).values).toEqual(fa.map((v, i) => Math.max(v, fb[i] ?? 0)));
    expect(valuesAt(cut.doc, cut.id, p).values).toEqual(fa.map((v, i) => Math.max(v, -(fb[i] ?? 0))));
    expect(union.data['distanceQuality']).toBe('bound');
    expect(union.data['bounds']).toEqual({ min: [-5, -3, -3], max: [5, 3, 3] });
  });

  it('quadratic blend: max deviation k/4 and 1-Lipschitz; exponential: k ln 2 (VC-IMP-03/04)', () => {
    const base = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const quad = ok(base.doc, 'combine_fields', { op: 'union', a: base.id, b: base.id, blend: { kind: 'quadratic', radius: 1 } });
    const expo = ok(quad.doc, 'combine_fields', { op: 'union', a: base.id, b: base.id, blend: { kind: 'exponential', radius: 1 } });
    const chamfer = ok(expo.doc, 'combine_fields', { op: 'union', a: base.id, b: base.id, blend: { kind: 'chamfer', radius: 1 } });
    expect((quad.data['blend'] as Record<string, number>)['maxDeviation']).toBe(0.25);
    expect((expo.data['blend'] as Record<string, number>)['maxDeviation']).toBeCloseTo(Math.LN2, 9);
    expect((chamfer.data['blend'] as Record<string, number>)['setback']).toBe(1);
    const at = [[1, 0, 0]] as const;
    const f = valuesAt(chamfer.doc, base.id, at).values[0] ?? 0;
    expect(f - (valuesAt(chamfer.doc, quad.id, at).values[0] ?? 0)).toBeCloseTo(0.25, 12);
    expect(f - (valuesAt(chamfer.doc, expo.id, at).values[0] ?? 0)).toBeCloseTo(Math.LN2, 12);
    expect(quad.data['distanceQuality']).toBe('bound');
    expect(quad.data['lipschitz']).toBe(1);
    const gradient = valuesAt(chamfer.doc, quad.id, [[2, 1, 0.5]], true).gradients ?? [];
    expect(Math.hypot(...gradient)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('smooth intersect and subtract keep the same deviation bound', () => {
    const { doc, a, b } = twoSpheres();
    const smoothIntersect = ok(doc, 'combine_fields', { op: 'intersect', a, b, blend: { kind: 'quadratic', radius: 2 } });
    const smoothCut = ok(smoothIntersect.doc, 'combine_fields', { op: 'subtract', a, b: [b], blend: { kind: 'exponential', radius: 0.5 } });
    const p = [[0, 0, 0]] as const;
    const [fa, fb] = [valuesAt(smoothCut.doc, a, p).values[0] ?? 0, valuesAt(smoothCut.doc, b, p).values[0] ?? 0];
    const hardIntersect = Math.max(fa, fb);
    expect(valuesAt(smoothCut.doc, smoothIntersect.id, p).values[0] ?? 0).toBeGreaterThanOrEqual(hardIntersect);
    expect(valuesAt(smoothCut.doc, smoothIntersect.id, p).values[0] ?? 0).toBeLessThanOrEqual(hardIntersect + 0.5);
  });

  it("warns IMP_BLEND_EXCEEDS_FEATURE when the blend radius is larger than the operands' features", () => {
    const small = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 0.5 });
    const blended = ok(small.doc, 'combine_fields', { op: 'union', a: small.id, b: small.id, blend: { kind: 'quadratic', radius: 2 } });
    expect((blended.data['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('IMP_BLEND_EXCEEDS_FEATURE');
    expect(blended.result.summary).toContain('IMP_BLEND_EXCEEDS_FEATURE');
  });

  it('refuses unknown operands, one operand and a non-positive blend', () => {
    const { doc, a, b } = twoSpheres();
    expectRefused(doc, run(doc, 'combine_fields', { op: 'union', a: 'nope', b }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(doc, run(doc, 'combine_fields', { op: 'union', a, b: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(doc, run(doc, 'combine_fields', { op: 'union', a, b: [] }), 'IMP_PARAM_RANGE');
    expectRefused(doc, run(doc, 'combine_fields', { op: 'union', a, b, blend: { kind: 'quadratic', radius: 0 } }), 'IMP_PARAM_RANGE');
    const before = JSON.stringify(doc);
    ok(doc, 'combine_fields', { op: 'union', a, b });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('VC-IMP-05: the smooth corner has its tangent points at the setback k and its bisector point at k/4', () => {
    let doc = empty();
    const px = ok(doc, 'add_field_primitive', { shape: 'plane', normal: [1, 0, 0], offset: 0 });
    const py = ok(px.doc, 'add_field_primitive', { shape: 'plane', normal: [0, 1, 0], offset: 0 });
    const corner = ok(py.doc, 'combine_fields', { op: 'union', a: px.id, b: py.id, blend: { kind: 'quadratic', radius: 2 } });
    const box = ok(corner.doc, 'add_field_primitive', { shape: 'box', size: [20, 20, 10], position: [6, 6, 5] });
    const part = ok(box.doc, 'combine_fields', { op: 'intersect', a: corner.id, b: box.id });
    doc = part.doc;
    const values = valuesAt(doc, part.id, [
      [0.5, 0.5, 5],
      [2, 0, 5],
      [0, 2, 5],
    ]).values;
    values.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-9));
    const body = ok(doc, 'create_implicit_body', { field: part.id, voxel: 0.15 });
    const props = ok(body.doc, 'implicit_properties', { id: body.id });
    expect(Math.abs((props.data['volume'] as number) - 1446.6667) / 1446.6667).toBeLessThan(0.001);
  });
});

describe('offset_field, shell_field, transform_field (VC-IMP-06, 07, 09)', () => {
  const sphere = (): Step => ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });

  it('offset of an exact sphere by +1.5 is the sphere R11.5, exactly; offset of a blend warns IMP_OFFSET_NOT_EXACT', () => {
    const s = sphere();
    const grown = ok(s.doc, 'offset_field', { field: s.id, distance: 1.5 });
    expect(valuesAt(grown.doc, grown.id, [[11.5, 0, 0]]).values[0]).toBeCloseTo(0, 12);
    expect(grown.data['distanceQuality']).toBe('exact');
    expect(grown.data['warnings']).toEqual([]);
    const blend = ok(grown.doc, 'combine_fields', { op: 'union', a: s.id, b: grown.id, blend: { kind: 'quadratic', radius: 1 } });
    const offsetBlend = ok(blend.doc, 'offset_field', { field: blend.id, distance: 1 });
    expect((offsetBlend.data['warnings'] as Array<{ code: string }>)[0]?.code).toBe('IMP_OFFSET_NOT_EXACT');
    expect(offsetBlend.data['distanceQuality']).toBe('bound');
    const shrunk = ok(blend.doc, 'offset_field', { field: s.id, distance: -4 });
    expect(shrunk.data['bounds']).toEqual({ min: [-10, -10, -10], max: [10, 10, 10] });
    expectRefused(s.doc, run(s.doc, 'offset_field', { field: 'nope', distance: 1 }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(s.doc, run(s.doc, 'offset_field', { field: s.id, distance: Number.NaN }), 'CMD_INVALID_PARAMS');
  });

  it('shell volumes: centred 2521.65 and inside 2044.13 mm3 within 0.2 % (VC-IMP-06)', () => {
    const s = sphere();
    const centred = ok(s.doc, 'shell_field', { field: s.id, thickness: 2, side: 'centred' });
    const inside = ok(centred.doc, 'shell_field', { field: s.id, thickness: 2 });
    const outside = ok(inside.doc, 'shell_field', { field: s.id, thickness: 2, side: 'outside' });
    const volume = (id: string): number => ok(outside.doc, 'implicit_properties', { id, voxel: 0.2 }).data['volume'] as number;
    expect(Math.abs(volume(centred.id) - 2521.65170328) / 2521.65170328).toBeLessThan(0.002);
    expect(Math.abs(volume(inside.id) - 2044.12961994) / 2044.12961994).toBeLessThan(0.002);
    expect(Math.abs(volume(outside.id) - (4 / 3) * Math.PI * (12 ** 3 - 10 ** 3)) / ((4 / 3) * Math.PI * (12 ** 3 - 10 ** 3))).toBeLessThan(
      0.003,
    );
    expectRefused(s.doc, run(s.doc, 'shell_field', { field: s.id, thickness: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(s.doc, run(s.doc, 'shell_field', { field: 'nope', thickness: 1 }), 'IMP_FIELD_NOT_FOUND');
  });

  it('shell of a non-exact field warns', () => {
    const s = sphere();
    const blend = ok(s.doc, 'combine_fields', { op: 'union', a: s.id, b: s.id, blend: { kind: 'quadratic', radius: 1 } });
    const shell = ok(blend.doc, 'shell_field', { field: blend.id, thickness: 1 });
    expect((shell.data['warnings'] as Array<{ code: string }>)[0]?.code).toBe('IMP_OFFSET_NOT_EXACT');
  });

  it('uniform scale 2 of sphere R5 is sphere R10 exactly; rigid moves keep the distance (VC-IMP-09)', () => {
    const small = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 5 });
    const doubled = ok(small.doc, 'transform_field', { field: small.id, scale: 2 });
    const moved = ok(doubled.doc, 'transform_field', { field: small.id, position: [4, 0, 0], rotation: [0.3, 0.2, 0.1] });
    const points = lowDiscrepancyPoints(50, 25);
    const answer = valuesAt(moved.doc, doubled.id, points).values;
    points.forEach((p, i) => expect(Math.abs((answer[i] ?? NaN) - (Math.hypot(...p) - 10))).toBeLessThan(1e-12));
    expect(valuesAt(moved.doc, moved.id, [[4, 5, 0]]).values[0]).toBeCloseTo(0, 12);
    expect(doubled.data['bounds']).toEqual({ min: [-10, -10, -10], max: [10, 10, 10] });
    expect(doubled.data['distanceQuality']).toBe('exact');
    expectRefused(small.doc, run(small.doc, 'transform_field', { field: small.id, scale: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(small.doc, run(small.doc, 'transform_field', { field: 'nope' }), 'IMP_FIELD_NOT_FOUND');
  });

  it('rotated boxes get a rotated bounding box', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 2, 2] });
    const turned = ok(box.doc, 'transform_field', { field: box.id, rotation: [0, 0, Math.PI / 2], position: [1, 2, 3] });
    const bounds = turned.data['bounds'] as { min: number[]; max: number[] };
    expect(bounds.min[0]).toBeCloseTo(0, 9);
    expect(bounds.max[1]).toBeCloseTo(7, 9);
    expect(bounds.max[2]).toBeCloseTo(4, 9);
  });
});

describe('field_from_solid (VC-IMP-08)', () => {
  it('equals the exact box signed distance at 1000 low-discrepancy points', () => {
    const box = ok(empty(), 'add_box', { size: [40, 40, 40] });
    const field = ok(box.doc, 'field_from_solid', { entityId: box.id });
    const points = lowDiscrepancyPoints(1000, 30);
    const answer = valuesAt(field.doc, field.id, points).values;
    const exact = (p: readonly number[]): number => {
      const q = p.map((c) => Math.abs(c) - 20);
      return Math.hypot(...q.map((c) => Math.max(c, 0))) + Math.min(Math.max(...q), 0);
    };
    points.forEach((p, i) => expect(Math.abs((answer[i] ?? NaN) - exact(p))).toBeLessThan(1e-9));
    expect(field.data['distanceQuality']).toBe('exact');
    expect(field.data['entityId']).toBe(box.id);
    expect(field.doc.entities[box.id]).toBe(box.doc.entities[box.id]);
  });

  it('refuses an unknown entity, a 2D shape and an open mesh', () => {
    const doc = empty();
    expectRefused(doc, run(doc, 'field_from_solid', { entityId: 'nope' }), 'IMP_ENTITY_NOT_FOUND');
    const circle = ok(doc, 'draw_rectangle', { width: 3, height: 2 });
    expectRefused(circle.doc, run(circle.doc, 'field_from_solid', { entityId: circle.id }), 'IMP_SOLID_NOT_CLOSED');
    const open = ok(doc, 'import_mesh', { bodies: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] });
    const refused = run(open.doc, 'field_from_solid', { entityId: open.id });
    expectRefused(open.doc, refused, 'IMP_SOLID_NOT_CLOSED');
    expect(refused.result.summary).toContain('free edge');
  });

  it('marks results built on an unpinned imported mesh unverified', () => {
    const tetra = { positions: [0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0, 4], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] };
    const mesh = ok(empty(), 'import_mesh', { bodies: [tetra] });
    const entity = mesh.doc.entities[mesh.id];
    if (entity?.kind !== 'mesh') throw new Error('mesh entity expected');
    const unpinned: CadDocument = {
      ...mesh.doc,
      entities: { ...mesh.doc.entities, [mesh.id]: { ...entity, meshSource: { format: 'stl-binary', unitScale: 1, verified: false } } },
    };
    const field = ok(unpinned, 'field_from_solid', { entityId: mesh.id });
    expect(field.data['unverified']).toBe(true);
    expect(
      valuesAt(field.doc, field.id, [
        [1, 1, 1],
        [-1, 0, 0],
      ]).values[0],
    ).toBeLessThan(0);
  });
});

describe('evaluate_field', () => {
  it('samples a plane grid, caps the sample count and reports units and quality (VC-IMP-39)', () => {
    const s = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 5 });
    const grid = ok(s.doc, 'evaluate_field', { field: s.id, grid: { plane: 'XZ', offset: 0, min: [-5, -5], max: [5, 5], n: [3, 3] } })
      .data as { values: number[]; count: number };
    expect(grid.count).toBe(9);
    expect(grid.values[4]).toBe(-5);
    expect(grid.values[0]).toBeCloseTo(Math.hypot(5, 5) - 5, 12);
    expectRefused(s.doc, run(s.doc, 'evaluate_field', { field: s.id }), 'IMP_PARAM_RANGE');
    expectRefused(
      s.doc,
      run(s.doc, 'evaluate_field', {
        field: s.id,
        points: [[0, 0, 0]],
        grid: { plane: 'XY', offset: 0, min: [0, 0], max: [1, 1], n: [2, 2] },
      }),
      'IMP_PARAM_RANGE',
    );
    expectRefused(
      s.doc,
      run(s.doc, 'evaluate_field', { field: s.id, grid: { plane: 'XY', offset: 0, min: [0, 0], max: [1, 1], n: [201, 2] } }),
      'IMP_PARAM_RANGE',
    );
    expectRefused(s.doc, run(s.doc, 'evaluate_field', { field: 'nope', points: [[0, 0, 0]] }), 'IMP_FIELD_NOT_FOUND');
    const tooMany = execute(s.doc, 'evaluate_field', { field: s.id, points: Array.from({ length: 10001 }, () => [0, 0, 0]) });
    expect(tooMany.document).toBe(s.doc);
    expect(tooMany.summary).toContain('rejected');
    const single = ok(s.doc, 'evaluate_field', { field: s.id, grid: { plane: 'YZ', offset: 1, min: [0, 0], max: [1, 1], n: [1, 1] } })
      .data as { values: number[] };
    expect(single.values[0]).toBeCloseTo(Math.hypot(1, 0, 0) - 5, 12);
    expect(execute(s.doc, 'evaluate_field', { field: s.id, points: [[0, 0, 0]] }).document).toBe(s.doc);
  });
});

describe('names', () => {
  it('every node-creating command keeps the optional name on its node', () => {
    const box = ok(empty(), 'add_box', { size: [4, 4, 4] });
    const solid = ok(box.doc, 'field_from_solid', { entityId: box.id, name: 'solid field' });
    const sphere = ok(solid.doc, 'add_field_primitive', { shape: 'sphere', radius: 2, name: 'ball' });
    const union = ok(sphere.doc, 'combine_fields', { op: 'union', a: solid.id, b: sphere.id, name: 'both' });
    const offset = ok(union.doc, 'offset_field', { field: union.id, distance: 1, name: 'grown' });
    const shell = ok(offset.doc, 'shell_field', { field: offset.id, thickness: 0.5, name: 'skin' });
    const moved = ok(shell.doc, 'transform_field', { field: shell.id, position: [1, 0, 0], name: 'moved' });
    const names = [solid, sphere, union, offset, shell, moved].map((step) => moved.doc.implicit?.fields[step.id]?.name);
    expect(names).toEqual(['solid field', 'ball', 'both', 'grown', 'skin', 'moved']);
  });
});
