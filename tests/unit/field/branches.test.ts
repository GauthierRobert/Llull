/** Branch coverage of the field interpreter, gradient and interval evaluators: every op on both sides of its conditions. */
import { describe, expect, it } from 'vitest';
import { FieldBuilder } from '@core/geometry/field/build';
import { evaluateWithGradient } from '@core/geometry/field/gradient';
import { evaluateAt, prepareProgram, scalarOp } from '@core/geometry/field/interpret';
import { evaluateInterval } from '@core/geometry/field/interval';
import type { FieldOp, FieldProgram } from '@core/geometry/field/program';

const META = { bounds: null, lipschitz: 1, quality: 'exact' } as const;
type Point = readonly [number, number, number];

/** Program op(x, y, z) over the point coordinates, using the first arity coordinates. */
function ternary(op: FieldOp, arity = 3): FieldProgram {
  const b = new FieldBuilder('mm');
  return b.finish(b.op(op, ...[b.x(), b.y(), b.z()].slice(0, arity)), META);
}

const gradientAt = (program: FieldProgram, p: Point): { value: number; gradient: readonly [number, number, number] } =>
  evaluateWithGradient(prepareProgram(program), p[0], p[1], p[2]);

const numeric = (program: FieldProgram, p: Point, axis: 0 | 1 | 2): number => {
  const prepared = prepareProgram(program);
  const registers = new Float64Array(program.instructions.length);
  const hi: [number, number, number] = [p[0], p[1], p[2]];
  const lo: [number, number, number] = [p[0], p[1], p[2]];
  hi[axis] += 1e-6;
  lo[axis] -= 1e-6;
  return (evaluateAt(prepared, registers, hi[0], hi[1], hi[2]) - evaluateAt(prepared, registers, lo[0], lo[1], lo[2])) / 2e-6;
};

const unknownOp = (): FieldProgram => ({ ...ternary('add', 2), instructions: [{ op: 'nope' as FieldOp, args: [] }], output: 0 });

describe('gradient on both sides of every condition', () => {
  const POINTS: readonly Point[] = [
    [0.7, -0.4, 1.3],
    [-0.9, 0.5, -1.1],
    [0.3, 0.9, 1.7],
  ];
  const OPS: Array<[FieldOp, number]> = [
    ['abs', 1],
    ['min', 2],
    ['max', 2],
    ['sqrt', 1],
    ['square', 1],
    ['sin', 1],
    ['cos', 1],
    ['atan2', 2],
    ['floor', 1],
    ['fract', 1],
    ['clamp', 3],
    ['select', 3],
    ['add', 2],
    ['sub', 2],
    ['mul', 2],
    ['div', 2],
    ['neg', 1],
  ];

  it.each(OPS)('%s matches finite differences wherever it is smooth', (op, arity) => {
    const b = new FieldBuilder('mm');
    const registers = [b.x(), b.y(), b.z()].slice(0, arity);
    const operands = op === 'sqrt' ? [b.add(b.square(registers[0] ?? 0), b.constant(0.5))] : registers;
    const program = b.finish(b.op(op, ...operands), META);
    for (const p of POINTS) {
      const dual = gradientAt(program, p);
      for (const axis of [0, 1, 2] as const) {
        const expected = numeric(program, p, axis);
        if (Number.isFinite(expected) && Math.abs(expected) < 1e6) expect(dual.gradient[axis]).toBeCloseTo(expected, 3);
      }
    }
  });

  it('handles the degenerate points: sqrt at 0, atan2 at the origin, clamp bounds, k <= 0 and wide blends', () => {
    expect(gradientAt(ternary('sqrt', 1), [0, 0, 0]).gradient).toEqual([0, 0, 0]);
    expect(gradientAt(ternary('atan2', 2), [0, 0, 0]).gradient).toEqual([0, 0, 0]);
    expect(gradientAt(ternary('abs', 1), [-1, 0, 0]).gradient[0]).toBe(-1);
    expect(gradientAt(ternary('clamp'), [5, 0, 1]).value).toBe(1);
    expect(gradientAt(ternary('clamp'), [-5, 0, 1]).value).toBe(0);
    for (const op of ['smin_quad', 'smin_exp', 'chamfer_min'] as const) {
      const program = ternary(op);
      const points: readonly Point[] = [
        [1, 5, 2],
        [5, 1, 2],
        [1, 1.2, 2],
        [1.2, 1, 2],
        [1, 1.2, -1],
        [1, 1.2, 0],
        [-3, 4, 0.5],
      ];
      for (const p of points) {
        const dual = gradientAt(program, p);
        for (const axis of [0, 1, 2] as const) {
          const expected = numeric(program, p, axis);
          if (Number.isFinite(expected)) expect(dual.gradient[axis]).toBeCloseTo(expected, 3);
        }
      }
    }
    const prepared = { ...prepareProgram(ternary('add', 2)), opcodes: Uint8Array.from([250]), program: unknownOp() };
    expect(Number.isNaN(evaluateWithGradient(prepared, 0, 0, 0).value)).toBe(true);
  });
});

describe('scalar semantics', () => {
  it('evaluates every arithmetic op', () => {
    const table: Array<[FieldOp, number, number, number, number]> = [
      ['add', 1, 2, 0, 3],
      ['sub', 1, 2, 0, -1],
      ['mul', 3, 2, 0, 6],
      ['div', 3, 2, 0, 1.5],
      ['neg', 3, 0, 0, -3],
      ['abs', -3, 0, 0, 3],
      ['min', 3, 2, 0, 2],
      ['max', 3, 2, 0, 3],
      ['sqrt', 9, 0, 0, 3],
      ['square', 3, 0, 0, 9],
      ['floor', 1.7, 0, 0, 1],
      ['fract', 1.75, 0, 0, 0.75],
      ['clamp', 0.5, 0, 1, 0.5],
      ['select', 1, 7, 9, 9],
    ];
    for (const [op, a, b, c, expected] of table) expect(scalarOp(op, a, b, c)).toBeCloseTo(expected, 12);
    expect(scalarOp('sin', 0, 0, 0)).toBe(0);
    expect(scalarOp('cos', 0, 0, 0)).toBe(1);
    expect(scalarOp('smin_quad', 1, 1.2, 1)).toBeLessThan(1);
    expect(scalarOp('smin_exp', 1, 5, 1)).toBeCloseTo(1 - Math.log(1 + Math.exp(-4)), 12);
    expect(scalarOp('chamfer_min', 3, 3, 0)).toBe(3);
  });
});

describe('interval evaluator branches', () => {
  const over = (program: FieldProgram, min: Point, max: Point): [number, number] => evaluateInterval(prepareProgram(program), { min, max });

  it('covers neg / abs / square / min / max / floor / fract / clamp / select / blends on both sides of their conditions', () => {
    const b = new FieldBuilder('mm');
    const [x, y] = [b.x(), b.y()];
    const cases: Array<[FieldProgram, Point, Point]> = [
      [b.finish(b.neg(x), META), [1, 0, 0], [2, 0, 0]],
      [b.finish(b.abs(x), META), [-2, 0, 0], [1, 0, 0]],
      [b.finish(b.abs(x), META), [1, 0, 0], [3, 0, 0]],
      [b.finish(b.square(x), META), [-2, 0, 0], [1, 0, 0]],
      [b.finish(b.square(x), META), [2, 0, 0], [3, 0, 0]],
      [b.finish(b.min(x, y), META), [0, 1, 0], [2, 3, 0]],
      [b.finish(b.max(x, y), META), [0, 1, 0], [2, 3, 0]],
      [b.finish(b.op('floor', x), META), [0.2, 0, 0], [3.4, 0, 0]],
      [b.finish(b.op('fract', x), META), [0.2, 0, 0], [0.7, 0, 0]],
      [b.finish(b.op('fract', x), META), [0.2, 0, 0], [1.7, 0, 0]],
      [b.finish(b.op('clamp', x, b.constant(0), b.constant(1)), META), [-1, 0, 0], [3, 0, 0]],
      [b.finish(b.op('select', x, y, b.neg(y)), META), [-3, 1, 0], [-1, 2, 0]],
      [b.finish(b.op('select', x, y, b.neg(y)), META), [1, 1, 0], [3, 2, 0]],
      [b.finish(b.op('select', x, y, b.neg(y)), META), [-1, 1, 0], [1, 2, 0]],
      [b.finish(b.op('sqrt', x), META), [1, 0, 0], [4, 0, 0]],
      [b.finish(b.op('sqrt', x), META), [-1, 0, 0], [4, 0, 0]],
      [b.finish(b.div(x, y), META), [1, 2, 0], [3, 4, 0]],
      [b.finish(b.op('sin', x), META), [0, 0, 0], [0.5, 0, 0]],
      [b.finish(b.op('sin', x), META), [0, 0, 0], [7, 0, 0]],
      [b.finish(b.op('cos', x), META), [3, 0, 0], [3.3, 0, 0]],
      [b.finish(b.op('atan2', y, x), META), [1, 1, 0], [2, 2, 0]],
      [b.finish(b.op('chamfer_min', x, y, b.constant(1)), META), [0, 0, 0], [1, 1, 0]],
      [b.finish(b.op('smin_exp', x, y, b.constant(1)), META), [0, 0, 0], [1, 1, 0]],
    ];
    for (const [program, min, max] of cases) {
      const [low, high] = over(program, min, max);
      expect(low).toBeLessThanOrEqual(high);
      const prepared = prepareProgram(program);
      const registers = new Float64Array(program.instructions.length);
      for (const t of [0, 0.37, 1]) {
        const x0 = min[0] + t * (max[0] - min[0]);
        const y0 = min[1] + t * (max[1] - min[1]);
        const value = evaluateAt(prepared, registers, x0, y0, 0);
        if (Number.isFinite(value)) {
          expect(value).toBeGreaterThanOrEqual(low - 1e-9);
          expect(value).toBeLessThanOrEqual(high + 1e-9);
        }
      }
    }
    expect(over(b.finish(b.abs(x), META), [1, 0, 0], [3, 0, 0])).toEqual([1, 3]);
    expect(over(b.finish(b.op('sin', x), META), [0, 0, 0], [7, 0, 0])).toEqual([-1, 1]);
    const prepared = { ...prepareProgram(ternary('add', 2)), opcodes: Uint8Array.from([250]), program: unknownOp() };
    expect(evaluateInterval(prepared, { min: [0, 0, 0], max: [1, 1, 1] })).toEqual([-Infinity, Infinity]);
  });
});
