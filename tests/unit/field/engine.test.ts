/** geometry/field (05 IMP TR-IMP-01/02/10): tape builder, interpreter, gradient, interval soundness, TS engine mesh / measures / budgets. */
import { describe, expect, it } from 'vitest';
import { FieldBuilder } from '@core/geometry/field/build';
import { getFieldEngine, resolveFieldEngine, setFieldEngine } from '@core/geometry/field/engine';
import { gridCells, gridNodeCount } from '@core/geometry/field/engineTypes';
import { evaluateWithGradient } from '@core/geometry/field/gradient';
import { evaluateAt, evaluatePoints, prepareProgram, scalarOp } from '@core/geometry/field/interpret';
import { evaluateInterval } from '@core/geometry/field/interval';
import { prepareMeshSdf } from '@core/geometry/field/meshSdf';
import { type FieldOp, type FieldProgram, programError } from '@core/geometry/field/program';
import { prepareStrutSet } from '@core/geometry/field/strutSet';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { MeshData } from '@core/model/types';

const META = { bounds: null, lipschitz: 1, quality: 'exact' } as const;

function sphereProgram(radius: number, centre: readonly [number, number, number] = [0, 0, 0]): FieldProgram {
  const b = new FieldBuilder('mm');
  const d = b.length3(b.shift(b.x(), -centre[0]), b.shift(b.y(), -centre[1]), b.shift(b.z(), -centre[2]));
  return b.finish(b.shift(d, -radius), {
    bounds: { min: [-radius, -radius, -radius], max: [radius, radius, radius] },
    lipschitz: 1,
    quality: 'exact',
  });
}

const boxMesh = (h: number): MeshData => ({
  positions: [-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7],
});

describe('FieldBuilder', () => {
  it('folds constants, shares equal subexpressions and drops unreachable registers', () => {
    const b = new FieldBuilder('mm');
    const two = b.add(b.constant(1), b.constant(1));
    expect(b.constant(2)).toBe(two);
    const x = b.x();
    expect(b.add(x, b.constant(0))).toBe(x);
    expect(b.mul(b.constant(1), x)).toBe(x);
    expect(b.square(x)).toBe(b.square(x));
    const dead = b.sqrt(b.y());
    void dead;
    const program = b.finish(b.mul(x, two), META);
    expect(program.instructions.map((i) => i.op)).toEqual(['const', 'x', 'mul']);
    expect(program.constants).toEqual([2]);
    expect(programError(program)).toBeNull();
    expect(evaluateAt(prepareProgram(program), new Float64Array(3), 4, 0, 0)).toBe(8);
  });

  it('shares meshes by key and keeps strut sets', () => {
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const first = b.meshSdf('box', boxMesh(1), x, y, z);
    expect(b.meshSdf('box', boxMesh(1), x, y, z)).toBe(first);
    const lattice = b.strutSet(
      {
        periodic: null,
        nodes: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        beams: [{ a: 0, b: 1, ra: 0.1, rb: 0.1, cap: 'sphere' }],
      },
      x,
      y,
      z,
      null,
    );
    const program = b.finish(b.min(first, lattice), META);
    expect(program.meshes).toHaveLength(1);
    expect(program.strutSets).toHaveLength(1);
    expect(programError(program)).toBeNull();
  });
});

describe('programError', () => {
  it('names the first malformed instruction', () => {
    const base = sphereProgram(1);
    expect(programError({ ...base, version: 2 as never })).toMatch(/version/);
    expect(programError({ ...base, output: 99 })).toMatch(/output/);
    expect(programError({ ...base, instructions: [{ op: 'nope' as FieldOp, args: [] }], output: 0 })).toMatch(/unknown op/);
    expect(programError({ ...base, instructions: [{ op: 'add', args: [0] }], output: 0 })).toMatch(/expected 2 operands/);
    expect(programError({ ...base, instructions: [{ op: 'neg', args: [0] }], output: 0 })).toMatch(/out of range/);
  });
});

describe('interpreter', () => {
  it('evaluates the arithmetic table', () => {
    expect(scalarOp('smin_quad', 0, 0, 1)).toBeCloseTo(-0.25, 12);
    expect(scalarOp('smin_exp', 0, 0, 1)).toBeCloseTo(-Math.LN2, 12);
    expect(scalarOp('smin_quad', 1, 5, 0)).toBe(1);
    expect(scalarOp('smin_exp', 1, 5, 0)).toBe(1);
    expect(scalarOp('chamfer_min', 0, 0, 1)).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(scalarOp('select', -1, 7, 9)).toBe(7);
    expect(scalarOp('select', 1, 7, 9)).toBe(9);
    expect(scalarOp('clamp', 5, 0, 1)).toBe(1);
    expect(scalarOp('fract', -0.25, 0, 0)).toBeCloseTo(0.75, 12);
    expect(scalarOp('atan2', 1, 1, 0)).toBeCloseTo(Math.PI / 4, 12);
    expect(scalarOp('const', 0, 0, 0)).toBeNaN();
  });

  it('evaluates batches and rejects a malformed program', () => {
    const program = sphereProgram(2);
    const values = evaluatePoints(prepareProgram(program), Float64Array.from([0, 0, 0, 3, 0, 0, 0, -2, 0]));
    expect(Array.from(values)).toEqual([-2, 1, 0]);
    expect(() => prepareProgram({ ...program, output: 40 })).toThrow(/invalid field program/);
  });
});

describe('gradient', () => {
  it('matches central differences on a program with every smooth op', () => {
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const a = b.add(b.sin(b.scale(x, 0.7)), b.mul(b.cos(y), b.square(z)));
    const c = b.sqrt(b.add(b.square(x), b.constant(2)));
    const d = b.op('smin_quad', a, c, b.constant(1.5));
    const e = b.op('smin_exp', d, b.div(a, c), b.constant(0.8));
    const f = b.op('chamfer_min', e, b.abs(b.op('atan2', y, c)), b.constant(0.4));
    const g = b.op('clamp', f, b.constant(-2), b.constant(2));
    const program = b.finish(b.op('select', b.shift(x, -3), g, b.neg(b.op('fract', g))), META);
    const prepared = prepareProgram(program);
    const registers = new Float64Array(program.instructions.length);
    for (const p of [
      [0.3, 0.4, 0.5],
      [-1.2, 0.8, -0.7],
      [2.0, -1.0, 1.3],
    ] as const) {
      const [px, py, pz] = p;
      const dual = evaluateWithGradient(prepared, px, py, pz);
      expect(dual.value).toBeCloseTo(evaluateAt(prepared, registers, px, py, pz), 12);
      const h = 1e-6;
      for (const axis of [0, 1, 2] as const) {
        const hi: [number, number, number] = [...p];
        const lo: [number, number, number] = [...p];
        hi[axis] += h;
        lo[axis] -= h;
        const numeric = (evaluateAt(prepared, registers, ...hi) - evaluateAt(prepared, registers, ...lo)) / (2 * h);
        expect(dual.gradient[axis]).toBeCloseTo(numeric, 4);
      }
    }
  });

  it('is a unit vector for an exact sphere and differentiates mesh_sdf and strut_set operands', () => {
    const dual = evaluateWithGradient(prepareProgram(sphereProgram(2)), 3, 4, 0);
    expect(Math.hypot(...dual.gradient)).toBeCloseTo(1, 9);
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const set = {
      periodic: null,
      nodes: [
        [0, 0, 0],
        [4, 0, 0],
      ] as [number, number, number][],
      beams: [{ a: 0, b: 1, ra: 0.5, rb: 0.5, cap: 'sphere' as const }],
    };
    const program = b.finish(b.add(b.meshSdf('box', boxMesh(1), x, y, z), b.strutSet(set, x, y, z, null)), META);
    const dualMix = evaluateWithGradient(prepareProgram(program), 0, 3, 0);
    expect(dualMix.gradient[1]).toBeCloseTo(2, 4);
    const radiusProgram = (() => {
      const q = new FieldBuilder('mm');
      return q.finish(q.strutSet(set, q.x(), q.y(), q.z(), q.constant(0.25)), META);
    })();
    expect(evaluateWithGradient(prepareProgram(radiusProgram), 2, 1, 0).value).toBeCloseTo(0.75, 9);
    expect(
      evaluateWithGradient(prepareProgram({ ...sphereProgram(1), instructions: [{ op: 'x', args: [] }], output: 0 }), 5, 0, 0).gradient,
    ).toEqual([1, 0, 0]);
  });
});

describe('interval arithmetic', () => {
  it('is sound: every sampled point value lies in the box interval', () => {
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const gyroid = b.add(b.add(b.mul(b.sin(x), b.cos(y)), b.mul(b.sin(y), b.cos(z))), b.mul(b.sin(z), b.cos(x)));
    const warped = b.op('smin_exp', gyroid, b.length3(x, y, z), b.constant(0.5));
    const stepped = b.add(b.op('fract', b.scale(x, 0.3)), b.op('floor', y));
    const quotient = b.div(b.add(warped, stepped), b.add(b.square(z), b.constant(1)));
    const program = b.finish(
      b.op(
        'chamfer_min',
        b.op('smin_quad', quotient, b.op('select', x, b.abs(y), b.neg(z)), b.constant(1)),
        b.op('clamp', b.op('atan2', y, x), b.constant(-1), b.constant(1)),
        b.constant(0.3),
      ),
      META,
    );
    const prepared = prepareProgram(program);
    const registers = new Float64Array(program.instructions.length);
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 60; trial += 1) {
      const lo: [number, number, number] = [random() * 8 - 4, random() * 8 - 4, random() * 8 - 4];
      const size = random() * 3;
      const hi: [number, number, number] = [lo[0] + size, lo[1] + size, lo[2] + size];
      const [low, high] = evaluateInterval(prepared, { min: lo, max: hi });
      for (let s = 0; s < 25; s += 1) {
        const v = evaluateAt(prepared, registers, lo[0] + random() * size, lo[1] + random() * size, lo[2] + random() * size);
        expect(v).toBeGreaterThanOrEqual(low - 1e-9);
        expect(v).toBeLessThanOrEqual(high + 1e-9);
      }
    }
  });

  it('bounds mesh_sdf and strut_set by their Lipschitz constant and handles a degenerate divisor', () => {
    const b = new FieldBuilder('mm');
    const [x, y, z] = [b.x(), b.y(), b.z()];
    const set = {
      periodic: null,
      nodes: [
        [0, 0, 0],
        [4, 0, 0],
      ] as [number, number, number][],
      beams: [{ a: 0, b: 1, ra: 0.5, rb: 0.5, cap: 'sphere' as const }],
    };
    const program = b.finish(b.add(b.meshSdf('box', boxMesh(1), x, y, z), b.strutSet(set, x, y, z, b.constant(0.25))), META);
    const prepared = prepareProgram(program);
    const [low, high] = evaluateInterval(prepared, { min: [5, 5, 5], max: [6, 6, 6] });
    const value = evaluateAt(prepared, new Float64Array(program.instructions.length), 5.5, 5.2, 5.9);
    expect(value).toBeGreaterThan(low);
    expect(value).toBeLessThan(high);
    const q = new FieldBuilder('mm');
    const divided = q.finish(q.div(q.constant(1), q.x()), META);
    expect(evaluateInterval(prepareProgram(divided), { min: [-1, 0, 0], max: [1, 0, 0] })).toEqual([-Infinity, Infinity]);
    const root = q.finish(q.sqrt(q.x()), META);
    expect(evaluateInterval(prepareProgram(root), { min: [-3, 0, 0], max: [-2, 0, 0] })).toEqual([Infinity, Infinity]);
  });
});

describe('mesh_sdf (field_from_solid core, VC-IMP-08)', () => {
  const sdf = prepareMeshSdf(boxMesh(1));
  it('equals the exact box signed distance, inside and outside', () => {
    expect(sdf.distance(0, 0, 0)).toBeCloseTo(-1, 12);
    expect(sdf.distance(3, 0, 0)).toBeCloseTo(2, 12);
    expect(sdf.distance(0.5, 0.2, -0.9)).toBeCloseTo(-0.1, 12);
    expect(sdf.distance(2, 2, 0)).toBeCloseTo(Math.SQRT2, 12);
  });
  it('is Infinity for an empty mesh and uses dipoles consistently on a large mesh', () => {
    expect(prepareMeshSdf({ positions: [], indices: [] }).distance(0, 0, 0)).toBe(Infinity);
    const subdivided = tsFieldEngine.mesh(
      sphereProgram(5),
      { min: [-6, -6, -6], max: [6, 6, 6], voxel: 0.5 },
      { mesher: 'tetra', maxTriangles: 1e6 },
    );
    if (!subdivided.ok) throw new Error('mesh failed');
    const big = prepareMeshSdf(subdivided.mesh);
    expect(big.distance(0, 0, 0)).toBeCloseTo(-5, 1);
    expect(big.distance(0, 0, 9)).toBeCloseTo(4, 1);
    expect(big.distance(30, 0, 0)).toBeCloseTo(25, 1);
  });
});

describe('strut sets (VC-IMP-26 frustum, periodic fold)', () => {
  it('measures capsule, butt-capped and tapered beams', () => {
    const nodes: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const capsule = prepareStrutSet({ periodic: null, nodes, beams: [{ a: 0, b: 1, ra: 1, rb: 1, cap: 'sphere' }] });
    expect(capsule.distance(5, 3, 0, -1)).toBeCloseTo(2, 12);
    expect(capsule.distance(-2, 0, 0, -1)).toBeCloseTo(1, 12);
    expect(capsule.distance(5, 0, 0, -1)).toBeCloseTo(-1, 12);
    const butt = prepareStrutSet({ periodic: null, nodes, beams: [{ a: 0, b: 1, ra: 1, rb: 0.5, cap: 'butt' }] });
    expect(butt.distance(-1, 0, 0, -1)).toBeCloseTo(1, 12);
    expect(butt.distance(5, 0.75, 0, -1)).toBeCloseTo(0, 12);
    expect(butt.distance(5, 0, 0, -1)).toBeLessThan(0);
    expect(butt.distance(5, 0, 0, 0.2)).toBeCloseTo(-0.2, 12);
    const degenerate = prepareStrutSet({
      periodic: null,
      nodes: [
        [0, 0, 0],
        [0, 0, 0],
      ],
      beams: [{ a: 0, b: 1, ra: 1, rb: 1, cap: 'sphere' }],
    });
    expect(degenerate.distance(3, 0, 0, -1)).toBeCloseTo(2, 12);
  });

  it('folds a periodic set into its cell', () => {
    const lattice = prepareStrutSet({
      periodic: { cell: [10, 10, 10], origin: [0, 0, 0] },
      nodes: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      beams: [{ a: 0, b: 1, ra: 1, rb: 1, cap: 'sphere' }],
    });
    expect(lattice.distance(5, 0, 0, -1)).toBeCloseTo(-1, 12);
    expect(lattice.distance(25, 10, -10, -1)).toBeCloseTo(-1, 12);
    expect(lattice.distance(5, 5, 5, -1)).toBeCloseTo(Math.sqrt(50) - 1, 12);
    expect(lattice.distance(-5, 10.5, 0, -1)).toBeCloseTo(-0.5, 12);
  });
});

describe('tsFieldEngine', () => {
  const grid = { min: [-6, -6, -6] as const, max: [6, 6, 6] as const, voxel: 0.5 };

  it('meshes a sphere closed with a vertex residual far below the voxel and prunes empty tiles', () => {
    const wide = { min: [-10, -10, -10] as const, max: [10, 10, 10] as const, voxel: 0.5 };
    const result = tsFieldEngine.mesh(sphereProgram(5), wide, { mesher: 'tetra', maxTriangles: 1e6 });
    if (!result.ok) throw new Error(result.message);
    expect(result.closedManifold).toBe(true);
    expect(result.maxVertexResidual).toBeLessThan(0.02);
    expect(result.prunedFraction).toBeGreaterThan(0.1);
    expect(result.evaluatedSamples).toBeLessThan(result.samples);
    expect(result.provenance).toMatchObject({ engine: 'ts', deterministic: true, voxel: 0.5 });
    expect(JSON.stringify(tsFieldEngine.mesh(sphereProgram(5), wide, { mesher: 'tetra', maxTriangles: 1e6 }))).toBe(JSON.stringify(result));
  });

  it('refuses over-budget grids and triangle counts and invalid programs with stable codes (VC-IMP-46)', () => {
    const started = Date.now();
    const big = tsFieldEngine.mesh(
      sphereProgram(1000),
      { min: [-1000, -1000, -1000], max: [1000, 1000, 1000], voxel: 0.001 },
      { mesher: 'tetra', maxTriangles: 1e6 },
    );
    expect(big).toMatchObject({ ok: false, code: 'IMP_GRID_BUDGET', limit: tsFieldEngine.limits.maxSamples });
    expect(Date.now() - started).toBeLessThan(100);
    expect(tsFieldEngine.mesh(sphereProgram(5), grid, { mesher: 'tetra', maxTriangles: 10 })).toMatchObject({
      ok: false,
      code: 'IMP_TRIANGLE_BUDGET',
    });
    const broken = { ...sphereProgram(5), output: 77 };
    expect(tsFieldEngine.mesh(broken, grid, { mesher: 'tetra', maxTriangles: 10 })).toMatchObject({ ok: false, code: 'IMP_ENGINE_FAILED' });
    expect(tsFieldEngine.measure(broken, grid, null, { kind: 'components' })).toMatchObject({ ok: false, code: 'IMP_ENGINE_FAILED' });
    expect(tsFieldEngine.measure(sphereProgram(5), { ...grid, voxel: 0.01 }, null, { kind: 'components' })).toMatchObject({
      ok: false,
      code: 'IMP_GRID_BUDGET',
    });
    expect(tsFieldEngine.evaluate(broken, Float64Array.from([0, 0, 0]), true).nonFinite).toBe(1);
  });

  it('counts non-finite samples and treats them as outside', () => {
    const b = new FieldBuilder('mm');
    const program = b.finish(b.sqrt(b.shift(b.x(), 1)), META);
    const samples = tsFieldEngine.evaluate(program, Float64Array.from([-5, 0, 0, 3, 0, 0]), true);
    expect(samples.nonFinite).toBe(1);
    const meshed = tsFieldEngine.mesh(program, { min: [-3, -1, -1], max: [3, 1, 1], voxel: 1 }, { mesher: 'tetra', maxTriangles: 1e5 });
    expect(meshed.ok && meshed.nonFiniteSamples).toBeGreaterThan(0);
  });

  it('measures volume by midpoint and low-discrepancy quadrature, with a region clip', () => {
    const exact = (4 / 3) * Math.PI * 125;
    const midpoint = tsFieldEngine.measure(sphereProgram(5), { ...grid, voxel: 0.25 }, null, { kind: 'volume', sampling: 'midpoint' });
    const quasi = tsFieldEngine.measure(sphereProgram(5), { ...grid, voxel: 0.25 }, null, { kind: 'volume', sampling: 'lowdiscrepancy' });
    for (const result of [midpoint, quasi]) {
      if (!result.ok || result.kind !== 'volume') throw new Error('volume failed');
      expect(Math.abs(result.volume - exact) / exact).toBeLessThan(0.01);
      expect(result.regionVolume).toBeCloseTo(12 ** 3, 6);
    }
    const half = (() => {
      const b = new FieldBuilder('mm');
      return b.finish(b.neg(b.x()), META);
    })();
    const clipped = tsFieldEngine.measure(sphereProgram(5), { ...grid, voxel: 0.25 }, half, { kind: 'volume', sampling: 'midpoint' });
    if (!clipped.ok || clipped.kind !== 'volume') throw new Error('clipped failed');
    expect(clipped.volume).toBeCloseTo(exact / 2, -1);
    expect(clipped.regionVolume).toBeCloseTo(12 * 12 * 6, -1);
  });

  it('returns exact sample quantiles (inverse of the sampled fraction)', () => {
    const b = new FieldBuilder('mm');
    const ramp = b.finish(b.x(), META);
    const quantiles = tsFieldEngine.measure(ramp, { min: [0, 0, 0], max: [8, 2, 2], voxel: 1 }, null, {
      kind: 'quantile',
      probabilities: [0, 0.5, 0.99],
      absolute: false,
    });
    if (!quantiles.ok || quantiles.kind !== 'quantile') throw new Error('quantile failed');
    expect(quantiles.values[0]).toBeCloseTo(0.5, 12);
    expect(quantiles.values[1]).toBeCloseTo(4.5, 12);
    expect(quantiles.values[2]).toBeCloseTo(7.5, 12);
    const abs = tsFieldEngine.measure(sphereProgram(5), grid, null, { kind: 'quantile', probabilities: [0.5], absolute: true });
    expect(abs.ok && abs.kind === 'quantile' && (abs.values[0] ?? -1)).toBeGreaterThan(0);
  });

  it('finds solid components and enclosed voids on the sign grid (VC-IMP-33/34)', () => {
    const shell = (() => {
      const b = new FieldBuilder('mm');
      const d = b.length3(b.x(), b.y(), b.z());
      return b.finish(b.max(b.shift(d, -5), b.neg(b.shift(d, -3))), META);
    })();
    const parts = tsFieldEngine.measure(shell, { min: [-6, -6, -6], max: [6, 6, 6], voxel: 0.25 }, null, { kind: 'components' });
    if (!parts.ok || parts.kind !== 'components') throw new Error('components failed');
    expect(parts.solids).toHaveLength(1);
    const enclosed = parts.voids.filter((part) => part.enclosed);
    expect(enclosed).toHaveLength(1);
    expect(Math.abs((enclosed[0]?.volume ?? 0) - (4 / 3) * Math.PI * 27) / ((4 / 3) * Math.PI * 27)).toBeLessThan(0.05);
    const two = (() => {
      const b = new FieldBuilder('mm');
      const left = b.shift(b.length3(b.shift(b.x(), 4), b.y(), b.z()), -2);
      const right = b.shift(b.length3(b.shift(b.x(), -4), b.y(), b.z()), -2);
      return b.finish(b.min(left, right), META);
    })();
    const split = tsFieldEngine.measure(two, { min: [-8, -4, -4], max: [8, 4, 4], voxel: 0.5 }, sphereProgram(100), { kind: 'components' });
    if (!split.ok || split.kind !== 'components') throw new Error('components failed');
    expect(split.solids).toHaveLength(2);
    expect(split.voids.every((part) => !part.enclosed)).toBe(true);
  });
});

describe('components use the Kuhn 14-neighbourhood', () => {
  const twoPoints = (a: readonly number[], b: readonly number[]): { solids: readonly unknown[] } => {
    const builder = new FieldBuilder('mm');
    const near = (p: readonly number[]): number =>
      builder.length3(
        builder.shift(builder.x(), -(p[0] ?? 0)),
        builder.shift(builder.y(), -(p[1] ?? 0)),
        builder.shift(builder.z(), -(p[2] ?? 0)),
      );
    const program = builder.finish(builder.min(builder.shift(near(a), -0.1), builder.shift(near(b), -0.1)), META);
    const answer = tsFieldEngine.measure(program, { min: [-1, -1, -1], max: [3, 3, 3], voxel: 1 }, null, { kind: 'components' });
    if (!answer.ok || answer.kind !== 'components') throw new Error('components failed');
    return answer;
  };

  it('nodes joined by a same-sign face diagonal are one solid; opposite-sign diagonals are two', () => {
    expect(twoPoints([1, 1, 1], [2, 2, 1]).solids).toHaveLength(1);
    expect(twoPoints([1, 1, 1], [2, 0, 1]).solids).toHaveLength(2);
    expect(twoPoints([0, 0, 0], [1, 1, 1]).solids).toHaveLength(1);
  });
});

describe('engine port', () => {
  it('resolves to the TS engine unless one is installed or given', () => {
    expect(getFieldEngine()).toBeNull();
    expect(resolveFieldEngine(null)).toBe(tsFieldEngine);
    expect(resolveFieldEngine(undefined)).toBe(tsFieldEngine);
    const fake = { ...tsFieldEngine, name: 'fake' };
    expect(resolveFieldEngine(fake)).toBe(fake);
    setFieldEngine(fake);
    expect(getFieldEngine()).toBe(fake);
    setFieldEngine(null);
  });

  it('counts grid cells and nodes', () => {
    expect(gridCells({ min: [0, 0, 0], max: [1, 2, 3], voxel: 0.5 })).toEqual([2, 4, 6]);
    expect(gridNodeCount({ min: [0, 0, 0], max: [1, 1, 1], voxel: 1 })).toBe(8);
    expect(gridCells({ min: [0, 0, 0], max: [0, 0, 0], voxel: 1 })).toEqual([1, 1, 1]);
  });
});
