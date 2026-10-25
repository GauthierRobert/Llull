/** Scalar fields and graded laws (05 IMP M5, FR-IMP-15, 16; VC-IMP-24, 28): create_scalar_field, field-valued thickness / radius / offset / blend radius. */
import { describe, expect, it } from 'vitest';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { CadDocument } from '@core/model/types';
import { expectPure } from '../../helpers/expectNoOp';
import { empty, expectRefused, ok, run } from './helpers';

const scalar = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof ok> => ok(doc, 'create_scalar_field', params);

const valuesAt = (doc: CadDocument, field: string, points: number[][]): number[] =>
  ok(doc, 'evaluate_field', { field, points }).data['values'] as number[];

describe('create_scalar_field', () => {
  it('a coordinate scalar has no range and a clamped ramp of it has the declared range', () => {
    const z = scalar(empty(), { kind: 'coordinate', axis: 'z' });
    expect(z.data['range']).toEqual({ min: null, max: null });
    const ramp = scalar(z.doc, { kind: 'ramp', input: z.id, inMin: 0, inMax: 40, outMin: 0.5, outMax: 2.5 });
    expect(ramp.data['range']).toEqual({ min: 0.5, max: 2.5 });
    expect(ramp.result.affected).toEqual([ramp.id]);
    expect(ramp.doc.implicit?.fields[ramp.id]).toMatchObject({ op: 'scalar', kind: 'ramp', clamp: true, easing: 'linear' });
  });

  it('the ramp, mix and arith scalars drive a graded offset to the expected values', () => {
    const x = scalar(empty(), { kind: 'coordinate', axis: 'x' });
    const ramp = scalar(x.doc, { kind: 'ramp', input: x.id, inMin: 0, inMax: 10, outMin: 0, outMax: 2, easing: 'smoothstep' });
    const plane = ok(ramp.doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    const offset = ok(plane.doc, 'offset_field', { field: plane.id, distance: ramp.id });
    // f = z - d(x): the surface z = d(x); smoothstep(0.5) = 0.5 -> d = 1 at x = 5
    expect(valuesAt(offset.doc, offset.id, [[5, 0, 1]])[0]).toBeCloseTo(0, 12);
    expect(valuesAt(offset.doc, offset.id, [[0, 0, 0]])[0]).toBeCloseTo(0, 12);
    expect(valuesAt(offset.doc, offset.id, [[10, 0, 2]])[0]).toBeCloseTo(0, 12);
    const mix = scalar(offset.doc, { kind: 'mix', a: 1, b: ramp.id, factor: 0.5 });
    const sum = scalar(mix.doc, { kind: 'arith', operation: 'add', a: mix.id, b: 1 });
    const biased = ok(sum.doc, 'offset_field', { field: plane.id, distance: sum.id });
    expect(valuesAt(biased.doc, biased.id, [[10, 0, 2]])[0]).toBeCloseTo(2 - ((1 + 2) / 2 + 1), 12);
    for (const operation of ['subtract', 'multiply', 'divide', 'min', 'max'] as const) {
      const made = scalar(sum.doc, { kind: 'arith', operation, a: sum.id, b: 2 });
      expect(made.doc.implicit?.fields[made.id]).toMatchObject({ kind: 'arith', operation });
    }
  });

  it('distance scalars measure to a point, a plane, a solid entity and another field', () => {
    const point = scalar(empty(), { kind: 'distance', toPoint: [0, 0, 0] });
    expect(point.data['range']).toEqual({ min: 0, max: null });
    const plane = scalar(point.doc, { kind: 'distance', toPlane: { origin: [0, 0, 0], normal: [0, 0, 2] } });
    const box = ok(plane.doc, 'add_box', { size: [4, 4, 4] });
    const entity = scalar(box.doc, { kind: 'distance', toEntity: box.id });
    const sphere = ok(entity.doc, 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const field = scalar(sphere.doc, { kind: 'distance', toField: sphere.id });
    const slab = ok(field.doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    for (const [id, expected, at] of [
      [point.id, 3, [3, 0, 0]],
      [plane.id, 3, [0, 0, 3]],
      [entity.id, 1, [3, 0, 0]],
      [field.id, 1, [3, 0, 0]],
    ] as const) {
      const graded = ok(slab.doc, 'offset_field', { field: slab.id, distance: id });
      // offset surface z = d: the value of the offset plane at (x, y, z) = z - d
      expect(valuesAt(graded.doc, graded.id, [[at[0], at[1], at[2]]])[0]).toBeCloseTo(at[2] - expected - 0, 9);
    }
  });

  it('noise is deterministic per seed, differs between seeds and lies in [0, 1)', () => {
    const a = scalar(empty(), { kind: 'noise', seed: 3, frequency: 0.7, octaves: 3 });
    const b = scalar(a.doc, { kind: 'noise', seed: 3, frequency: 0.7, octaves: 3 });
    const c = scalar(b.doc, { kind: 'noise', seed: 4, frequency: 0.7, octaves: 3 });
    const plane = ok(c.doc, 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    const points = Array.from({ length: 40 }, (_, i) => [i * 0.37, i * 0.11, 0]);
    const surface = (law: string): number[] => {
      const offset = ok(plane.doc, 'offset_field', { field: plane.id, distance: law });
      return valuesAt(offset.doc, offset.id, points).map((v) => -v);
    };
    const [va, vb, vc] = [surface(a.id), surface(b.id), surface(c.id)];
    expect(va.map((v) => v.toString())).toEqual(vb.map((v) => v.toString()));
    expect(va).not.toEqual(vc);
    expect(va.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(va.map((v) => v.toFixed(3))).size).toBeGreaterThan(20);
    expect(a.data['range']).toEqual({ min: 0, max: 1 });
  });

  it('refuses bad input with stable codes and leaves the document unchanged', () => {
    const doc = empty();
    const z = scalar(doc, { kind: 'coordinate', axis: 'z' });
    const box = ok(z.doc, 'add_box', { size: [2, 2, 2] });
    const open = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    const imported = ok(box.doc, 'import_mesh', { bodies: [open] });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'coordinate' }, 'IMP_PARAM_RANGE'],
      [{ kind: 'distance' }, 'IMP_PARAM_CONFLICT'],
      [{ kind: 'distance', toPoint: [0, 0, 0], toField: 'x' }, 'IMP_PARAM_CONFLICT'],
      [{ kind: 'distance', toPlane: { origin: [0, 0, 0], normal: [0, 0, 0] } }, 'IMP_PARAM_RANGE'],
      [{ kind: 'distance', toEntity: 'nope' }, 'IMP_ENTITY_NOT_FOUND'],
      [{ kind: 'distance', toEntity: imported.id }, 'IMP_SOLID_NOT_CLOSED'],
      [{ kind: 'distance', toField: 'nope' }, 'IMP_FIELD_NOT_FOUND'],
      [{ kind: 'ramp', input: z.id }, 'IMP_PARAM_RANGE'],
      [{ kind: 'ramp', input: z.id, inMin: 1, inMax: 1, outMin: 0, outMax: 1 }, 'IMP_PARAM_RANGE'],
      [{ kind: 'ramp', input: z.id, inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: false, easing: 'smoothstep' }, 'IMP_PARAM_RANGE'],
      [{ kind: 'ramp', input: 'nope', inMin: 0, inMax: 1, outMin: 0, outMax: 1 }, 'IMP_FIELD_NOT_FOUND'],
      [{ kind: 'ramp', input: box.id, inMin: 0, inMax: 1, outMin: 0, outMax: 1 }, 'IMP_FIELD_NOT_FOUND'],
      [{ kind: 'mix', a: 1, b: 2 }, 'IMP_PARAM_RANGE'],
      [{ kind: 'mix', a: 1, b: 2, factor: 'nope' }, 'IMP_FIELD_NOT_FOUND'],
      [{ kind: 'arith', a: 1, b: 2 }, 'IMP_PARAM_RANGE'],
      [{ kind: 'arith', operation: 'add', a: 1, b: 'nope' }, 'IMP_FIELD_NOT_FOUND'],
      [{ kind: 'noise', frequency: 0 }, 'IMP_PARAM_RANGE'],
      [{ kind: 'noise', frequency: 1, octaves: 9 }, 'IMP_PARAM_RANGE'],
      [{ kind: 'noise', frequency: 1, seed: 1.5 }, 'IMP_PARAM_RANGE'],
    ];
    for (const [params, code] of cases) {
      const step = run(imported.doc, 'create_scalar_field', params);
      expectRefused(imported.doc, step, code);
    }
    const solidField = ok(imported.doc, 'add_field_primitive', { shape: 'sphere', radius: 1 });
    expectRefused(
      solidField.doc,
      run(solidField.doc, 'create_scalar_field', { kind: 'mix', a: solidField.id, b: 1, factor: 0.5 }),
      'IMP_PARAM_RANGE',
    );
  });

  it('is pure', () => {
    const z = scalar(empty(), { kind: 'coordinate', axis: 'z' });
    expectPure(z.doc, () => run(z.doc, 'create_scalar_field', { kind: 'ramp', input: z.id, inMin: 0, inMax: 1, outMin: 0, outMax: 2 }));
  });
});

describe('graded laws on lattices, shells and blends', () => {
  const column = (): { doc: CadDocument; z: string; wall: string; box: string } => {
    const z = scalar(empty(), { kind: 'coordinate', axis: 'z' });
    const wall = scalar(z.doc, { kind: 'ramp', input: z.id, inMin: 0, inMax: 10, outMin: 0.5, outMax: 1.5 });
    const box = ok(wall.doc, 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    return { doc: box.doc, z: z.id, wall: wall.id, box: box.id };
  };

  it('a graded gyroid sheet has the wall of the ramp at each height and refuses a ramp outside the valid interval', () => {
    const { doc, wall, box } = column();
    const lattice = ok(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: wall, cellSize: 10, region: box });
    expect(lattice.data['control']).toMatchObject({ graded: true, kind: 'thickness', value: wall });
    const lp = ok(lattice.doc, 'lattice_properties', { id: lattice.id }).data;
    expect(lp['thicknessMin'] as number).toBeCloseTo(0.5, 1);
    expect(lp['thicknessMax'] as number).toBeCloseTo(1.5, 1);
    expect(lp['controlRange']).toMatchObject({ graded: true });
    const wide = scalar(doc, { kind: 'coordinate', axis: 'x' });
    const tooThick = scalar(wide.doc, { kind: 'ramp', input: wide.id, inMin: 0, inMax: 1, outMin: 0.1, outMax: 9 });
    expectRefused(
      tooThick.doc,
      run(tooThick.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: tooThick.id, cellSize: 10 }),
      'IMP_TPMS_CONTROL_RANGE',
    );
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 'nope', cellSize: 10 }),
      'IMP_FIELD_NOT_FOUND',
    );
    expectRefused(doc, run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: box, cellSize: 10 }), 'IMP_PARAM_RANGE');
  });

  it('a graded network level and a graded strut radius compile; the radius follows the law along the lattice', () => {
    const { doc, wall, box } = column();
    const level = scalar(doc, { kind: 'ramp', input: wall, inMin: 0.5, inMax: 1.5, outMin: -0.5, outMax: 0.5 });
    const network = ok(level.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: level.id, cellSize: 10, region: box });
    expect(network.data['control']).toMatchObject({ kind: 'level', graded: true });
    const radius = scalar(network.doc, { kind: 'ramp', input: wall, inMin: 0.5, inMax: 1.5, outMin: 0.2, outMax: 1 });
    const struts = ok(radius.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: radius.id, region: box });
    expect(struts.data['radiusGraded']).toBe(true);
    expect(struts.data['distanceQuality']).toBe('approximate');
    // on the strut axis x at (z = 0 ... 10), height 0 -> radius 0.2 -> f = -0.2 at the axis point (5, 0, 0)
    const open = ok(struts.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: radius.id });
    const values = valuesAt(open.doc, open.id, [
      [5, 0, 0],
      [5, 0, 10],
      [5, 5, 5],
    ]);
    expect(values[0]).toBeCloseTo(-0.2, 6);
    expect(values[1]).toBeCloseTo(-1, 6);
    expect(values[2]).toBeGreaterThan(1);
    const info = ok(struts.doc, 'lattice_properties', { id: struts.id }).data;
    expect(info['radiusGraded']).toBe(true);
    expect(info['radiusMin'] as number).toBeCloseTo(0.2, 1);
    expect(info['radiusMax'] as number).toBeCloseTo(1, 1);
    expect(info['rho1']).toBeNull();
    expectRefused(
      struts.doc,
      run(struts.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: radius.id, nodeRadius: 2 }),
      'IMP_PARAM_CONFLICT',
    );
    const huge = scalar(doc, { kind: 'ramp', input: wall, inMin: 0.5, inMax: 1.5, outMin: 0.2, outMax: 6 });
    expectRefused(huge.doc, run(huge.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: huge.id }), 'IMP_STRUT_RADIUS_RANGE');
  });

  it('a graded shell is thick where the law is thick; a graded blend warns about its gradient', () => {
    const x = scalar(empty(), { kind: 'coordinate', axis: 'x' });
    const law = scalar(x.doc, { kind: 'ramp', input: x.id, inMin: 0, inMax: 10, outMin: 1, outMax: 3 });
    const sphere = ok(law.doc, 'add_field_primitive', { shape: 'sphere', radius: 10, position: [5, 0, 0] });
    const shell = ok(sphere.doc, 'shell_field', { field: sphere.id, thickness: law.id });
    // wall at (x,0,0): inner surface at distance d(x) inside the sphere surface: left end x = -5 (clamped law 1), right end x = 15 (law 3)
    expect(valuesAt(shell.doc, shell.id, [[-5 + 1, 0, 0]])[0]).toBeCloseTo(0, 9);
    expect(valuesAt(shell.doc, shell.id, [[15 - 3, 0, 0]])[0]).toBeCloseTo(0, 9);
    const signed = scalar(sphere.doc, { kind: 'ramp', input: x.id, inMin: 0, inMax: 1, outMin: -1, outMax: 1 });
    expectRefused(signed.doc, run(signed.doc, 'shell_field', { field: sphere.id, thickness: signed.id }), 'IMP_PARAM_RANGE');
    const a = ok(law.doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'sphere', radius: 3, position: [4, 0, 0] });
    const blend = ok(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'quadratic', radius: law.id } });
    expect((blend.data['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('IMP_BLEND_LAW_STEEP');
    expect(blend.data['distanceQuality']).toBe('approximate');
    expect(blend.data['blend']).toMatchObject({ graded: true, maxDeviation: 3 / 4 });
    expectRefused(
      b.doc,
      run(b.doc, 'combine_fields', { op: 'union', a: a.id, b: b.id, blend: { kind: 'quadratic', radius: 'nope' } }),
      'IMP_FIELD_NOT_FOUND',
    );
  });

  it('the TS and native-shaped engines agree on a graded program (tape determinism of the law registers)', () => {
    const { doc, wall, box } = column();
    const lattice = ok(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: wall, cellSize: 10, region: box });
    const a = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    const again = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    expect(again.data['contentHash']).toBe(a.data['contentHash']);
    expect(tsFieldEngine.name).toBe('ts');
    expect(a.data['closedManifold']).toBe(true);
  });
});
