/**
 * 05 IMP 14.x GPU preview: the compiler FieldProgram -> GLSL and the read-only command `implicit_gpu_program`. The emitted shader text is run on the CPU
 * (`tests/helpers/glslToJs`) and compared with the TS interpreter at sample points; unsupported fields are named; a parameter drag keeps the shader key.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { compileFieldToGlsl, MAX_GLSL_INSTRUCTIONS } from '@core/geometry/field/glsl';
import { evaluateAt, prepareProgram } from '@core/geometry/field/interpret';
import type { FieldProgram } from '@core/geometry/field/program';
import { compileField } from '@implicit/compile';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { glslToJs } from '../../helpers/glslToJs';
import { empty, lowDiscrepancyPoints, ok } from './helpers';

function programOf(doc: Parameters<typeof compileField>[0], field: string): FieldProgram {
  const compiled = compileField(doc, field);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.program;
}

/** Max |GLSL twin - interpreter| over deterministic points, relative to 1 + |value|. */
function agreement(program: FieldProgram, half: number, center: readonly number[] = [0, 0, 0]): number {
  const glsl = compileFieldToGlsl(program);
  if (!glsl.ok) throw new Error(`unsupported: ${glsl.unsupported.join(', ')}`);
  const twin = glslToJs(glsl.source, glsl.constants);
  const prepared = prepareProgram(program);
  const registers = new Float64Array(program.instructions.length);
  let worst = 0;
  for (const [x, y, z] of lowDiscrepancyPoints(400, half)) {
    const p = [x + (center[0] ?? 0), y + (center[1] ?? 0), z + (center[2] ?? 0)] as const;
    const reference = evaluateAt(prepared, registers, p[0], p[1], p[2]);
    const emitted = twin(p[0], p[1], p[2]);
    worst = Math.max(worst, Math.abs(emitted - reference) / (1 + Math.abs(reference)));
  }
  return worst;
}

function gyroidInBox(): { doc: ReturnType<typeof empty>; field: string } {
  const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
  const gyroid = ok(box.doc, 'add_tpms_lattice', {
    kind: 'gyroid',
    form: 'network',
    level: 0,
    cellSize: 8,
    origin: [0, 0, 0],
    region: box.id,
  });
  return { doc: gyroid.doc, field: gyroid.id };
}

describe('FieldProgram -> GLSL', () => {
  it('a gyroid lattice in a box: the emitted shader, run on the CPU, equals the interpreter (single precision constants) at 400 points', () => {
    const { doc, field } = gyroidInBox();
    expect(agreement(programOf(doc, field), 6, [4, 4, 4])).toBeLessThan(2e-5);
  });

  it('booleans and the three blends, offsets and shells: the same agreement', () => {
    const a = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 3, position: [-1, 0, 0] });
    const b = ok(a.doc, 'add_field_primitive', { shape: 'box', size: [4, 4, 4], position: [1.5, 0.5, 0] });
    for (const blend of [
      undefined,
      { kind: 'quadratic', radius: 1 },
      { kind: 'exponential', radius: 0.7 },
      { kind: 'chamfer', radius: 0.8 },
    ]) {
      for (const op of ['union', 'intersect', 'subtract'] as const) {
        const combined = ok(b.doc, 'combine_fields', { op, a: a.id, b: b.id, ...(blend === undefined ? {} : { blend }) });
        expect(agreement(programOf(combined.doc, combined.id), 5), `${op} ${blend?.kind ?? 'sharp'}`).toBeLessThan(2e-5);
        const shelled = ok(combined.doc, 'shell_field', { field: combined.id, thickness: 0.5 });
        expect(agreement(programOf(shelled.doc, shelled.id), 5), `shell of ${op}`).toBeLessThan(2e-5);
      }
    }
  });

  it('emits one straight-line function over a uniform array: helpers declared, the lipschitz bound and the support box carried', () => {
    const { doc, field } = gyroidInBox();
    const glsl = compileFieldToGlsl(programOf(doc, field));
    if (!glsl.ok) throw new Error('compiles');
    expect(glsl.source).toMatch(/uniform vec4 uC\[\d+\];/);
    expect(glsl.source).toContain('float fieldAt(float x, float y, float z) {');
    expect(glsl.source).toContain('float smin_quad(');
    expect(glsl.constants.length % 4).toBe(0);
    expect(glsl.lipschitz).toBeGreaterThanOrEqual(1);
    expect(glsl.bounds.max[0]).toBeGreaterThan(glsl.bounds.min[0]);
    expect(glsl.instructionCount).toBeGreaterThan(10);
  });

  it('a parameter drag that keeps the tape keeps the key and the source and changes only the constants; a structural edit changes the key', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
    const make = (cellSize: number, kind = 'gyroid'): ReturnType<typeof compileFieldToGlsl> => {
      const lattice = ok(box.doc, 'add_tpms_lattice', { kind, form: 'network', level: 0, cellSize, origin: [0, 0, 0], region: box.id });
      return compileFieldToGlsl(programOf(lattice.doc, lattice.id));
    };
    const [a, b, other] = [make(8), make(5), make(8, 'diamond')];
    if (!a.ok || !b.ok || !other.ok) throw new Error('compiles');
    expect(b.key).toBe(a.key);
    expect(b.source).toBe(a.source);
    expect(b.constants).not.toEqual(a.constants);
    expect(other.key).not.toBe(a.key);
  });

  it('names what has no GPU path: strut sets, an unbounded field, a tape over the limit, a malformed tape', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
    const struts = ok(box.doc, 'add_strut_lattice', { cell: 'bcc', cellSize: 4, radius: 0.3, region: box.id });
    expect(compileFieldToGlsl(programOf(struts.doc, struts.id))).toEqual({ ok: false, unsupported: ['strut_set'] });
    const plane = ok(empty(), 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    expect(compileFieldToGlsl(programOf(plane.doc, plane.id))).toEqual({ ok: false, unsupported: ['unbounded'] });
    const long: FieldProgram = {
      version: 1,
      instructions: [
        { op: 'x', args: [] },
        ...Array.from({ length: MAX_GLSL_INSTRUCTIONS }, (_, i) => ({ op: 'add' as const, args: [i, 0] })),
      ],
      output: MAX_GLSL_INSTRUCTIONS,
      constants: [],
      meshes: [],
      strutSets: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      lipschitz: 1,
      quality: 'exact',
      unit: 'mm',
    };
    expect(compileFieldToGlsl(long)).toEqual({ ok: false, unsupported: ['tape_too_long'] });
    expect(compileFieldToGlsl({ ...long, instructions: [{ op: 'add', args: [5, 6] }], output: 0 })).toEqual({
      ok: false,
      unsupported: ['invalid_program'],
    });
  });
});

describe('implicit_gpu_program', () => {
  it('answers the GLSL of a body and of a field, pure and read-only', () => {
    const { doc, field } = gyroidInBox();
    const body = ok(doc, 'create_implicit_body', { field, voxel: 1 });
    expectPure(body.doc, () => execute(body.doc, 'implicit_gpu_program', { id: body.id }));
    const answer = execute(body.doc, 'implicit_gpu_program', { id: body.id });
    expect(answer.error, answer.summary).toBeUndefined();
    expect(answer.document).toBe(body.doc);
    const data = answer.data as { gpu: boolean; field: string; glsl: { source: string; constants: number[]; key: string } };
    expect(data.gpu).toBe(true);
    expect(data.field).toBe(field);
    expect(data.glsl.source).toContain('fieldAt');
    expect(data.glsl.key).toMatch(/^[0-9a-f]{8}$/);
    const byField = execute(body.doc, 'implicit_gpu_program', { id: field }).data as { glsl: { key: string } };
    expect(byField.glsl.key).toBe(data.glsl.key);
  });

  it('a strut lattice answers gpu false with the blocking op named; a plane too; an unknown id is a refusal that changes nothing', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [8, 8, 8], position: [4, 4, 4] });
    const struts = ok(box.doc, 'add_strut_lattice', { cell: 'bcc', cellSize: 4, radius: 0.3, region: box.id });
    const blocked = execute(struts.doc, 'implicit_gpu_program', { id: struts.id });
    expect(blocked.data).toMatchObject({ gpu: false, unsupported: ['strut_set'] });
    expect(blocked.summary).toContain('strut_set');
    const plane = ok(empty(), 'add_field_primitive', { shape: 'plane', normal: [0, 0, 1], offset: 0 });
    expect(execute(plane.doc, 'implicit_gpu_program', { id: plane.id }).data).toMatchObject({ gpu: false, unsupported: ['unbounded'] });
    const refused = execute(plane.doc, 'implicit_gpu_program', { id: 'nope' });
    expect(refused.error?.code).toBe('IMP_FIELD_NOT_FOUND');
    expectNoOp(refused, plane.doc);
  });
});
