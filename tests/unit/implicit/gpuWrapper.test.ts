/**
 * 05 IMP 14.x GPU preview, review of the first build: the emitted float literals, the single-precision error, the one rule for a negative square root,
 * the constant budget, and the marching policy (distances in document units, never a step over a sign change) on a high-Lipschitz thin gyroid.
 */
import { describe, expect, it } from 'vitest';
import { compileFieldToGlsl, MAX_GLSL_CONSTANT_SLOTS } from '@core/geometry/field/glsl';
import { evaluateAt, prepareProgram } from '@core/geometry/field/interpret';
import type { FieldProgram } from '@core/geometry/field/program';
import { compileField } from '@implicit/compile';
import { STEP_CAP_FACTOR, stepScaleOf } from '@ui/viewport/3d/implicitPreview/gpuProgram';
import { glslToJs } from '../../helpers/glslToJs';
import { trace } from '../../helpers/sphereTraceTwin';
import { empty, lowDiscrepancyPoints, ok } from './helpers';

function gyroid(cellSize: number, thickness: number, size: number): FieldProgram {
  const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [size, size, size], position: [size / 2, size / 2, size / 2] });
  const lattice = ok(box.doc, 'add_tpms_lattice', {
    kind: 'gyroid',
    form: 'sheet',
    thickness,
    cellSize,
    origin: [0, 0, 0],
    region: box.id,
  });
  const compiled = compileField(lattice.doc, lattice.id);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.program;
}

const glslOf = (program: FieldProgram): ReturnType<typeof compileFieldToGlsl> & { ok: true } => {
  const glsl = compileFieldToGlsl(program);
  if (!glsl.ok) throw new Error(`unsupported: ${glsl.unsupported.join(', ')}`);
  return glsl;
};

describe('emitted GLSL text and precision', () => {
  it('every numeric literal is a float (a decimal point or an exponent): an integer literal would not compile on a strict driver', () => {
    const { source } = glslOf(gyroid(10, 1, 20));
    const stripped = source.replace(/\[\d+\]/g, '[]');
    const bare = [...stripped.matchAll(/(?<![\w.])\d+(?![\w.])/g)].map((match) => match[0]);
    expect(bare).toEqual([]);
    expect(source).not.toMatch(/\(\s*\)/);
  });

  it('single precision costs under 1e-3 relative on a gyroid in a 20 mm box, and more than double precision does', () => {
    const program = gyroid(10, 1, 20);
    const glsl = glslOf(program);
    const [double, single] = [glslToJs(glsl.source, glsl.constants), glslToJs(glsl.source, glsl.constants, { float32: true })];
    const prepared = prepareProgram(program);
    const registers = new Float64Array(program.instructions.length);
    let [worstDouble, worstSingle] = [0, 0];
    for (const [x, y, z] of lowDiscrepancyPoints(400, 10)) {
      const p = [x + 10, y + 10, z + 10] as const;
      const reference = evaluateAt(prepared, registers, ...p);
      worstDouble = Math.max(worstDouble, Math.abs(double(...p) - reference) / (1 + Math.abs(reference)));
      worstSingle = Math.max(worstSingle, Math.abs(single(...p) - reference) / (1 + Math.abs(reference)));
    }
    expect(worstSingle).toBeLessThan(1e-3);
    expect(worstSingle).toBeGreaterThan(worstDouble);
  });

  it('the square root of a negative number is OUTSIDE in both engines: NaN in the interpreter (counted outside), +1e30 in the shader', () => {
    const program: FieldProgram = {
      version: 1,
      instructions: [
        { op: 'x', args: [] },
        { op: 'sqrt', args: [0] },
      ],
      output: 1,
      constants: [],
      meshes: [],
      strutSets: [],
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      lipschitz: 1,
      quality: 'exact',
      unit: 'mm',
    };
    const glsl = glslOf(program);
    const twin = glslToJs(glsl.source, glsl.constants);
    const prepared = prepareProgram(program);
    const registers = new Float64Array(2);
    expect(Number.isNaN(evaluateAt(prepared, registers, -1, 0, 0))).toBe(true);
    expect(twin(-1, 0, 0)).toBeGreaterThan(1e29);
    expect(twin(4, 0, 0)).toBe(2);
    expect(evaluateAt(prepared, registers, 4, 0, 0)).toBe(2);
  });

  it('a tape with more constants than the uniform budget is refused by name', () => {
    const limit = 4 * MAX_GLSL_CONSTANT_SLOTS;
    const make = (count: number): FieldProgram => ({
      version: 1,
      instructions: [{ op: 'const', args: [0] }],
      output: 0,
      constants: Array.from({ length: count }, (_, i) => i + 1),
      meshes: [],
      strutSets: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      lipschitz: 1,
      quality: 'exact',
      unit: 'mm',
    });
    expect(compileFieldToGlsl(make(limit)).ok).toBe(true);
    expect(compileFieldToGlsl(make(limit + 1))).toEqual({ ok: false, unsupported: ['too_many_constants'] });
  });
});

describe('the marching policy on a thin, high-Lipschitz gyroid', () => {
  const program = gyroid(4, 0.4, 20);
  const glsl = glslOf(program);
  const field = glslToJs(glsl.source, glsl.constants);
  const f = (p: readonly [number, number, number]): number => field(p[0], p[1], p[2]);
  const minFeature = 0.2;
  const stepScale = stepScaleOf(glsl);
  const rays = lowDiscrepancyPoints(60, 1).map(([a, b, c]) => {
    const direction = [0.3 + 0.4 * a, 0.3 + 0.4 * b, 1 + 0.2 * c] as const;
    const length = Math.hypot(...direction);
    return {
      origin: [10 + 8 * a, 10 + 8 * b, -4] as const,
      direction: [direction[0] / length, direction[1] / length, direction[2] / length] as const,
    };
  });
  const setup = { stepScale, maxStep: STEP_CAP_FACTOR * minFeature, pixel: 2e-3, minEps: 1e-5 * 35 };

  it('the stored Lipschitz bound of an approximate field is not a bound: the measured gradient of the normalised gyroid is far above it', () => {
    let steepest = 0;
    for (const [x, y, z] of lowDiscrepancyPoints(3000, 10)) {
      const [px, py, pz] = [x + 10, y + 10, z + 10];
      const h = 1e-4;
      steepest = Math.max(
        steepest,
        Math.hypot(
          f([px + h, py, pz]) - f([px - h, py, pz]),
          f([px, py + h, pz]) - f([px, py - h, pz]),
          f([px, py, pz + h]) - f([px, py, pz - h]),
        ) /
          (2 * h),
      );
    }
    expect(steepest).toBeGreaterThan(10 * glsl.lipschitz);
  });

  it('with distances in document units no step ever jumps over a sign change of the field', () => {
    let crossings = 0;
    let hits = 0;
    for (const ray of rays) {
      const result = trace(f, ray.origin, ray.direction, 4, 40, setup);
      crossings += result.crossings;
      hits += result.hit ? 1 : 0;
    }
    expect(crossings).toBe(0);
    expect(hits).toBeGreaterThan(30);
  });

  it('without the cap the same rays do step over the thin wall (the Lipschitz step alone is not enough for an approximate field): the test can fail', () => {
    let crossings = 0;
    for (const ray of rays) crossings += trace(f, ray.origin, ray.direction, 4, 40, { ...setup, maxStep: undefined }).crossings;
    expect(crossings).toBeGreaterThan(0);
  });

  it('a hit is refined onto the surface: |f| after the bisection is far below the footprint', () => {
    for (const ray of rays.slice(0, 20)) {
      const result = trace(f, ray.origin, ray.direction, 4, 40, setup);
      if (!result.hit) continue;
      const p = [0, 1, 2].map((k) => (ray.origin[k] as number) + (ray.direction[k] as number) * result.t) as [number, number, number];
      expect(Math.abs(f(p) * stepScale)).toBeLessThan(setup.pixel * result.t + setup.minEps);
    }
  });
});
