/** 04 DIR §5.8, DES-4c review: consistent rank-deficient systems (about 15 % of the rows combinations of two others) never come back wrongly "ok" from the factor path: the residual matches the iterative one. */

import { describe, expect, it } from 'vitest';
import { type Sample, type SparseRow, solveSparse } from '@core/geometry/subd/g1Linear';
import type { Vec3 } from '@core/model/types';

function rankDeficient(
  seedStart: number,
  rowCount: number,
  unknowns: number,
): { rows: SparseRow[]; b: Vec3[]; start: Vec3[]; samples: Sample[] } {
  let seed = seedStart;
  const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows: Array<Array<[number, number]>> = [];
  for (let i = 0; i < rowCount; i++) {
    if (i > 3 && random() < 0.15) {
      const first = rows[Math.floor(random() * rows.length)] as Array<[number, number]>;
      const second = rows[Math.floor(random() * rows.length)] as Array<[number, number]>;
      const scale = random() * 2 - 1;
      rows.push([...first, ...second.map(([k, c]): [number, number] => [k, scale * c])]);
      continue;
    }
    const row: Array<[number, number]> = [];
    const base = Math.floor(random() * unknowns);
    for (let t = 0; t < 4; t++) row.push([(base + Math.floor(random() * 12)) % unknowns, random() * 2 - 1]);
    rows.push(row);
  }
  const truth: Vec3[] = Array.from({ length: unknowns }, (_, k): Vec3 => [Math.sin(k), Math.cos(k), 0.1 * k]);
  const b = rows.map(
    (row): Vec3 =>
      [0, 1, 2].map((axis) => row.reduce((sum, [k, c]) => sum + c * ((truth[k] as Vec3)[axis] as number), 0)) as unknown as Vec3,
  );
  const start = truth.map((p, k): Vec3 => [p[0] + 0.3 * Math.sin(3 * k), p[1], p[2] - 0.2]);
  const samples: Sample[] = Array.from({ length: unknowns }, (_, k) => ({
    terms: [
      [k, 0.7],
      [(5 * k + 1) % unknowns, 0.3],
    ],
    constant: [0, 0, 0],
    target: [0.1, 0.2, 0.3],
  }));
  return { rows, b, start, samples };
}

const violationOf = (rows: readonly SparseRow[], b: readonly Vec3[], x: readonly Vec3[]): number =>
  Math.max(
    ...rows.flatMap((row, i) =>
      [0, 1, 2].map((axis) =>
        Math.abs(row.reduce((sum, [k, c]) => sum + c * ((x[k] as Vec3)[axis] as number), 0) - ((b[i] as Vec3)[axis] as number)),
      ),
    ),
  );

describe('consistent rank-deficient systems on the factor path (review of DES-4c)', () => {
  const cases = [4, 5, 13, 16, 20].flatMap((seed) =>
    (
      [
        [600, 500],
        [300, 200],
      ] as const
    ).map(([rowCount, unknowns]) => ({ seed, rowCount, unknowns })),
  );

  it.each(cases)(
    'seed $seed, $rowCount x $unknowns: every ordering meets the conditions like CGLS and reports ok',
    ({ seed, rowCount, unknowns }) => {
      const { rows, b, start } = rankDeficient(seed * 7919, rowCount, unknowns);
      const iterative = solveSparse(rows, b, start, [], undefined, 'iterative');
      expect(iterative.status).toBe('ok');
      for (const ordering of ['auto', 'rcm', 'minimum-degree'] as const) {
        const direct = solveSparse(rows, b, start, [], undefined, 'direct', { ordering });
        expect(direct.status).toBe('ok');
        expect(direct.residual).toBeLessThan(Math.max(1e-7, 10 * iterative.residual));
        expect(violationOf(rows, b, direct.x)).toBeLessThan(1e-6);
      }
    },
  );

  it.each([4, 5, 13, 20])('seed %i with the limit objective: conditions kept, a consistent group is not misreported', (seed) => {
    const { rows, b, start, samples } = rankDeficient(seed * 7919, 300, 200);
    for (const ordering of ['rcm', 'minimum-degree'] as const) {
      const direct = solveSparse(rows, b, start, samples, undefined, 'direct', { ordering });
      expect(direct.status).toBe('ok');
      expect(direct.residual).toBeLessThan(1e-6);
      expect(violationOf(rows, b, direct.x)).toBeLessThan(1e-6);
    }
  });

  it('a contradictory system is still reported with its residual (the fallback does not hide it)', () => {
    const { rows, b, start } = rankDeficient(7919, 300, 200);
    const wrong: Vec3[] = [...b, [(b[2] as Vec3)[0] + 1, 0, 0]];
    const direct = solveSparse([...rows, rows[2] as SparseRow], wrong, start, []);
    expect(direct.residual).toBeGreaterThan(0.1);
  });
});
