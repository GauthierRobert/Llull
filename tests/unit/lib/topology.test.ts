/** PHY-17 pure reference (VC-TOP-01..04, 10, 11): element stiffness, filter weights, OC on a separable problem, SIMP scaling and the top88 MBB benchmark. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFilter, ocUpdate, q4ElementStiffness, runSimp2d, type Simp2dProblem, type Simp2dResult } from '@lib/topology';

const PACK = 'docs/physics/17-topology-optimization/validation';
interface Case {
  id: string;
  value: number | number[];
  tolerance: { rel?: number; abs?: number };
}
const expected = (JSON.parse(readFileSync(`${PACK}/expected_results.json`, 'utf8')) as { cases: Case[] }).cases;
const caseValue = (id: string): number => {
  const found = expected.find((entry) => entry.id === id)?.value;
  if (typeof found !== 'number') throw new Error(`no numeric case ${id}`);
  return found;
};
const relative = (actual: number, reference: number): number => Math.abs(actual - reference) / Math.abs(reference);

/** top88 MBB half beam: symmetry (ux = 0) on the left edge, uy = 0 at the bottom right node, unit load down at the top left node. */
function mbb(nx: number, ny: number, overrides: Partial<Simp2dProblem> = {}): Simp2dProblem {
  const node = (ix: number, iy: number): number => ix + (nx + 1) * iy;
  const fixedDofs = [...Array.from({ length: ny + 1 }, (_, iy) => 2 * node(0, iy)), 2 * node(nx, 0) + 1];
  return {
    nx,
    ny,
    active: new Uint8Array(nx * ny).fill(1),
    keepIn: new Uint8Array(nx * ny),
    keepOut: new Uint8Array(nx * ny),
    fixedDofs,
    loadCases: [{ name: 'LC1', weight: 1, dofs: [2 * node(0, ny) + 1], values: [-1] }],
    stiffness: 1,
    poisson: 0.3,
    volumeFraction: 0.5,
    penal: 3,
    eminRatio: 1e-9,
    move: 0.2,
    changeTol: 0.01,
    maxIterations: 2000,
    filter: { kind: 'sensitivity', radius: 1.5 },
    ...overrides,
  };
}

const solved = (problem: Simp2dProblem): Simp2dResult => {
  const result = runSimp2d(problem);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

describe('q4ElementStiffness (VC-TOP-01)', () => {
  const ke = q4ElementStiffness(0.3);
  it('matches the closed-form entries to 1e-12', () => {
    expect(relative(ke[0] ?? 0, (12 - 4 * 0.3) / (24 * (1 - 0.3 ** 2)))).toBeLessThan(1e-14);
    expect(relative(ke[1] ?? 0, (3 + 3 * 0.3) / (24 * (1 - 0.3 ** 2)))).toBeLessThan(1e-14);
    // the pinned values carry 12 significant digits
    expect(relative(ke[0] ?? 0, caseValue('VC-TOP-01.a'))).toBeLessThan(5e-12);
    expect(relative(ke[1] ?? 0, caseValue('VC-TOP-01.b'))).toBeLessThan(5e-12);
  });
  it('is symmetric and has zero row sums (rigid translation carries no energy)', () => {
    for (let i = 0; i < 8; i += 1) {
      let rowSum = 0;
      for (let j = 0; j < 8; j += 1) {
        expect(ke[i * 8 + j]).toBeCloseTo(ke[j * 8 + i] ?? NaN, 14);
        rowSum += ke[i * 8 + j] ?? 0;
      }
      expect(Math.abs(rowSum)).toBeLessThan(1e-14);
    }
  });
});

describe('buildFilter (VC-TOP-02)', () => {
  const filter = buildFilter(5, 5, 1.5);
  const weightOf = (row: number, column: number): number => {
    for (let k = filter.start[row] ?? 0; k < (filter.start[row + 1] ?? 0); k += 1)
      if (filter.index[k] === column) return filter.weight[k] ?? 0;
    return 0;
  };
  it('gives centre 1.5, edge neighbours 0.5 and diagonal neighbours 1.5 - sqrt(2)', () => {
    expect(weightOf(12, 12)).toBe(1.5);
    expect(weightOf(12, 13)).toBe(0.5);
    expect(weightOf(12, 18)).toBeCloseTo(1.5 - Math.SQRT2, 15);
    expect(weightOf(12, 14)).toBe(0);
    expect(filter.rowSum[12]).toBeCloseTo(1.5 + 4 * 0.5 + 4 * (1.5 - Math.SQRT2), 14);
  });
  it('skips inactive elements: they get no row and are not neighbours', () => {
    const active = new Uint8Array(25).fill(1);
    active[13] = 0;
    const holed = buildFilter(5, 5, 1.5, active);
    expect(holed.rowSum[13]).toBe(0);
    expect(holed.rowSum[12]).toBeCloseTo(1.5 + 3 * 0.5 + 4 * (1.5 - Math.SQRT2), 14);
  });
});

describe('ocUpdate (VC-TOP-03)', () => {
  it('finds the optimum of a separable problem: minimise sum a/x with sum x = V', () => {
    const a = [1, 4, 9, 16];
    const volume = 2;
    let x: Float64Array = Float64Array.from([0.5, 0.5, 0.5, 0.5]);
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const dc = Float64Array.from(x, (value, i) => -(a[i] ?? 0) / value ** 2);
      x = ocUpdate({
        x,
        dc,
        dv: new Float64Array(4).fill(1),
        move: 0.2,
        physical: (xNew, out) => out.set(xNew),
        volumeLimit: volume,
        lambdaTolerance: 1e-14,
      }).xNew;
    }
    const reference = expected.find((entry) => entry.id === 'VC-TOP-03.a')?.value as number[];
    reference.forEach((value, i) => expect(Math.abs((x[i] ?? 0) - value)).toBeLessThan(1e-6));
    const objective = a.reduce((sum, ai, i) => sum + ai / (x[i] ?? 1), 0);
    expect(relative(objective, caseValue('VC-TOP-03.b'))).toBeLessThan(1e-6);
  });
  it('keeps the move limit and the [0, 1] bounds', () => {
    const { xNew } = ocUpdate({
      x: Float64Array.from([0.5, 0.95, 0]),
      dc: Float64Array.from([-1e6, -1e6, -1e6]),
      dv: new Float64Array(3).fill(1),
      move: 0.2,
      physical: (value, out) => out.set(value),
      volumeLimit: 1.69,
    });
    expect(xNew[0]).toBeGreaterThan(0.68);
    expect(xNew[0]).toBeLessThanOrEqual(0.7);
    expect([xNew[1], xNew[2]]).toEqual([1, 0]);
  });
});

describe('runSimp2d scaling (VC-TOP-04)', () => {
  it('compliance scales with 1 / x^p for a uniform design (30 x 10, x = 0.5, p = 3)', () => {
    const solid = solved(mbb(30, 10, { maxIterations: 0, volumeFraction: 1 }));
    expect(relative(solid.compliance, caseValue('VC-TOP-04.a'))).toBeLessThan(1e-9);
    const half = solved(mbb(30, 10, { maxIterations: 0, volumeFraction: 0.5 }));
    expect(relative(half.compliance / solid.compliance, caseValue('VC-TOP-04.b'))).toBeLessThan(1e-8);
    expect(half.iterations).toBe(0);
    expect(half.grey).toBeCloseTo(1, 12);
  });
  it('scales quadratically with the load, with 1 / stiffness and sums weighted load cases', () => {
    const base = mbb(10, 5, { maxIterations: 0 });
    const one = solved(base);
    const loadCase = base.loadCases[0];
    if (loadCase === undefined) throw new Error('no load case');
    const doubled = solved({
      ...base,
      stiffness: 2,
      loadCases: [
        { ...loadCase, values: [-4] },
        { ...loadCase, name: 'LC2', weight: 0.5, values: [-1] },
      ],
    });
    expect(relative(doubled.perLoadCase['LC1'] ?? 0, 16 * one.compliance * 0.5)).toBeLessThan(1e-12);
    expect(relative(doubled.perLoadCase['LC2'] ?? 0, one.compliance * 0.5)).toBeLessThan(1e-12);
    expect(relative(doubled.compliance, 8 * one.compliance + 0.25 * one.compliance)).toBeLessThan(1e-12);
  });
});

const pinnedDensity = (name: string): string[] => readFileSync(`${PACK}/${name}`, 'utf8').trimEnd().split('\n');

/** Fraction of cells whose density digit (9 x, rounded; top row first) matches the pinned file. */
function digitAgreement(result: Simp2dResult, rows: readonly string[], nx: number, ny: number): number {
  let same = 0;
  for (let row = 0; row < ny; row += 1)
    for (let ix = 0; ix < nx; ix += 1) {
      const digit = String(Math.round(9 * (result.xPhys[ix + nx * (ny - 1 - row)] ?? 0)));
      if (digit === rows[row]?.[ix]) same += 1;
    }
  return same / (nx * ny);
}

describe.each([
  { vc: 'VC-TOP-10', kind: 'sensitivity' as const, file: 'mbb_60x20_sensitivity.txt', label: 'sensitivity' },
  { vc: 'VC-TOP-11', kind: 'density' as const, file: 'mbb_60x20_density.txt', label: 'density' },
])('MBB 60 x 20 ($label filter, $vc)', ({ vc, kind, file, label }) => {
  const result = solved(mbb(60, 20, { filter: { kind, radius: 1.5 } }));
  const history = readFileSync(`${PACK}/mbb_history.csv`, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .filter((cells) => cells[0] === label)
    .map((cells) => ({ it: Number(cells[1]), compliance: Number(cells[2]), volume: Number(cells[3]), change: Number(cells[4]) }));

  it('stops at the pinned iteration count with status converged', () => {
    expect(result.iterations).toBe(caseValue(`${vc}.a`));
    expect(result.status).toBe('converged');
    expect(result.history).toHaveLength(history.length);
  });
  it('reproduces the compliances to 1e-6 relative', () => {
    expect(relative(result.lastIterationCompliance, caseValue(`${vc}.b`))).toBeLessThan(1e-6);
    expect(relative(result.compliance, caseValue(`${vc}.c`))).toBeLessThan(1e-6);
    expect(result.perLoadCase['LC1']).toBe(result.compliance);
  });
  it('reproduces volume fraction and grey level', () => {
    expect(Math.abs(result.volumeFraction - caseValue(`${vc}.d`))).toBeLessThan(1e-3);
    expect(Math.abs(result.grey - caseValue(`${vc}.e`))).toBeLessThan(1e-4);
  });
  it('reproduces the history rows (compliance, volume, change)', () => {
    result.history.forEach((row, i) => {
      const pinned = history[i];
      expect(row.it).toBe(pinned?.it);
      expect(relative(row.compliance, pinned?.compliance ?? NaN)).toBeLessThan(1e-6);
      expect(Math.abs(row.volume - (pinned?.volume ?? NaN))).toBeLessThan(1e-6);
      expect(Math.abs(row.change - (pinned?.change ?? NaN))).toBeLessThan(1e-6);
    });
  });
  it('reproduces the final density field', () => {
    expect(digitAgreement(result, pinnedDensity(file), 60, 20)).toBeGreaterThanOrEqual(0.995);
  });
});

describe('runSimp2d behaviour', () => {
  it('is deterministic and does not touch its input', () => {
    const problem = mbb(20, 8);
    const before = JSON.stringify({ ...problem, active: Array.from(problem.active) });
    const first = solved(problem);
    const second = solved(problem);
    expect(Array.from(second.xPhys)).toEqual(Array.from(first.xPhys));
    expect(JSON.stringify({ ...problem, active: Array.from(problem.active) })).toBe(before);
  });
  it('honours keep-in and keep-out elements and inactive holes (nx <= ny numbering too)', () => {
    const nx = 8;
    const ny = 12;
    const problem = mbb(nx, ny);
    const keepIn = new Uint8Array(nx * ny);
    const keepOut = new Uint8Array(nx * ny);
    const active = Uint8Array.from(problem.active);
    keepIn[3 + nx * 6] = 1;
    keepOut[5 + nx * 2] = 1;
    active[7 + nx * 11] = 0;
    const result = solved({ ...problem, keepIn, keepOut, active, filter: { kind: 'density', radius: 1.5 }, maxIterations: 15 });
    expect(result.xPhys[3 + nx * 6]).toBe(1);
    expect(result.xPhys[5 + nx * 2]).toBe(0);
    expect(result.xPhys[7 + nx * 11]).toBe(0);
    expect(result.status).toBe('max_iterations');
    expect(result.iterations).toBe(15);
  });
  it('fails softly on a singular system (no support)', () => {
    const failure = runSimp2d(mbb(6, 4, { fixedDofs: [] }));
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.reason).toMatch(/singular/);
  });
});
