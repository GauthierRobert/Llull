/** Sampled scalar data on the tape (`sample_field`, 05 IMP 14.11): interpolation, ranges, validation, gradient. */
import { describe, expect, it } from 'vitest';
import { FieldBuilder } from '@core/geometry/field/build';
import { evaluateWithGradient } from '@core/geometry/field/gradient';
import { evaluateAt, prepareProgram } from '@core/geometry/field/interpret';
import { evaluateInterval } from '@core/geometry/field/interval';
import { programError } from '@core/geometry/field/program';
import { type GridSamples, type SampledField, type TetSamples, prepareSampledField } from '@core/geometry/field/sampled';

const META = { bounds: null, lipschitz: 1, quality: 'approximate' } as const;

/** v = 1 + x + 2y + 3z at the centres of a 3 x 2 x 2 grid of 0.5 voxels from the origin. */
function linearGrid(): GridSamples {
  const values: number[] = [];
  for (let k = 0; k < 2; k += 1)
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 3; i += 1) values.push(1 + (i + 0.5) * 0.5 + 2 * (j + 0.5) * 0.5 + 3 * (k + 0.5) * 0.5);
  return { kind: 'grid', nodes: [3, 2, 2], origin: [0, 0, 0], voxel: 0.5, values };
}

/** Two tetrahedra sharing the face (1,0,0)-(0,1,0)-(0,0,1); v = 1 + x + 2y + 3z at the nodes. */
function twoTets(): TetSamples {
  const points = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1];
  const values = [0, 1, 2, 3, 4].map(
    (n) => 1 + (points[3 * n] as number) + 2 * (points[3 * n + 1] as number) + 3 * (points[3 * n + 2] as number),
  );
  return { kind: 'tets', points, tets: [0, 1, 2, 3, 4, 1, 2, 3], values };
}

const valueAt = (field: SampledField, x: number, y: number, z: number): number => prepareSampledField(field).value(x, y, z);

describe('sampled grid', () => {
  it('reproduces a linear field between the voxel centres and holds the edge values outside', () => {
    const grid = linearGrid();
    for (const [x, y, z] of [
      [0.4, 0.3, 0.3],
      [0.9, 0.5, 0.6],
      [1.1, 0.25, 0.25],
    ] as const)
      expect(valueAt(grid, x, y, z)).toBeCloseTo(1 + x + 2 * y + 3 * z, 12);
    expect(valueAt(grid, 0.25, 0.25, 0.25)).toBe(grid.values[0]);
    expect(valueAt(grid, -5, -5, -5)).toBe(grid.values[0]);
    expect(valueAt(grid, 50, 50, 50)).toBe(grid.values[grid.values.length - 1]);
    expect(Number.isNaN(valueAt(grid, Number.NaN, 0, 0))).toBe(true);
  });

  it('stays inside the data range at every point', () => {
    const grid = linearGrid();
    const { lo, hi } = prepareSampledField(grid);
    for (let n = 0; n < 500; n += 1) {
      const v = valueAt(grid, Math.sin(n) * 3, Math.cos(n * 1.7) * 2, Math.sin(n * 0.3) * 2);
      expect(v >= lo && v <= hi).toBe(true);
    }
  });
});

describe('sampled tetrahedra', () => {
  it('reproduces a linear field inside, takes the lowest tetrahedron on a shared face, and the nearest node outside', () => {
    const mesh = twoTets();
    expect(valueAt(mesh, 0.1, 0.2, 0.3)).toBeCloseTo(1 + 0.1 + 0.4 + 0.9, 12);
    expect(valueAt(mesh, 0.7, 0.6, 0.5)).toBeCloseTo(1 + 0.7 + 1.2 + 1.5, 12);
    expect(valueAt(mesh, 1 / 3, 1 / 3, 1 / 3)).toBeCloseTo(1 + 2, 12);
    expect(valueAt(mesh, 5, 5, 5)).toBe(mesh.values[4]);
    expect(valueAt(mesh, -3, 0, 0)).toBe(mesh.values[0]);
    expect(Number.isNaN(valueAt(mesh, 0, Number.NaN, 0))).toBe(true);
  });
});

describe('the data range bounds every sample', () => {
  it('a point inside the 1e-9 tolerance of a tetrahedron face never leaves [lo, hi] (the interval of the pruner relies on it)', () => {
    const single: TetSamples = { kind: 'tets', points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], tets: [0, 1, 2, 3], values: [0, 1, 1, 1] };
    const { lo, hi } = prepareSampledField(single);
    const v = valueAt(single, 0.4, 0.3, 0.3 + 5e-10);
    expect(v >= lo && v <= hi).toBe(true);
    expect(v).toBe(1);
  });
});

describe('sample_field on the tape', () => {
  it('evaluates, bounds an interval by the data range, differentiates, and is validated', () => {
    const grid = linearGrid();
    const b = new FieldBuilder('mm');
    const program = b.finish(b.sampledField(grid, b.x(), b.y(), b.z()), META);
    expect(program.sampled).toHaveLength(1);
    expect(programError(program)).toBeNull();
    const prepared = prepareProgram(program);
    expect(evaluateAt(prepared, new Float64Array(program.instructions.length), 0.4, 0.3, 0.3)).toBeCloseTo(1 + 0.4 + 0.6 + 0.9, 12);
    const [lo, hi] = evaluateInterval(prepared, { min: [0, 0, 0], max: [1, 1, 1] });
    expect([lo, hi]).toEqual([Math.min(...grid.values), Math.max(...grid.values)]);
    const dual = evaluateWithGradient(prepared, 0.6, 0.5, 0.5);
    expect(dual.gradient[0]).toBeCloseTo(1, 5);
    expect(dual.gradient[1]).toBeCloseTo(2, 5);
    expect(dual.gradient[2]).toBeCloseTo(3, 5);
    const plain = new FieldBuilder('mm').finish(0, META);
    expect(plain.sampled).toBeUndefined();
    expect(programError({ ...program, sampled: [{ ...grid, values: [1, 2] }] })).toContain('sampled field 0');
    expect(programError({ ...program, sampled: [] })).toContain('operand 3');
    expect(programError({ ...program, sampled: [{ kind: 'tets', points: [0, 0, 0], tets: [0, 0, 0, 7], values: [1] }] })).toContain(
      'out of range',
    );
  });
});
