import { describe, expect, it } from 'vitest';
import { countCycles, rainflowFourPoint, rainflowRepeating, rainflowThreePoint, reversalsOf, totalsOf } from '@cae/fatigue/rainflow';
import { expectedValue } from './support';

const E1049 = [-2, 1, -3, 5, -1, 3, -4, 4, -2];
const S2_CASE2 = [-1.5, 1, -3, 10, -1, 3, -8, 4, -2, 6, -1, -4, -8, 2, 1, -5, 0, 2.5, -4, 1, 0, 2, -0.5];

describe('rainflow (ASTM E1049)', () => {
  it('VC-FAT-01: three-point totals of the E1049 Fig. 6 history', () => {
    expect(totalsOf(rainflowThreePoint(E1049))).toEqual(expectedValue('07-fatigue', 'VC-FAT-01'));
  });

  it('VC-FAT-02: four-point gives one full cycle, the residue, and the same totals with the residue as half cycles', () => {
    const negated = E1049.map((x) => -x);
    const { full, residue } = rainflowFourPoint(negated);
    expect(full.map((c) => [c.from, c.to, c.range])).toEqual([[1, -3, 4]]);
    expect(residue).toEqual([2, -1, 3, -5, 4, -4, 2]);
    expect(totalsOf([...full, ...rainflowThreePoint(residue)])).toEqual(expectedValue('07-fatigue', 'VC-FAT-01'));
    expect(totalsOf(countCycles(negated, 'rainflow_4pt', 'half_cycles'))).toEqual(expectedValue('07-fatigue', 'VC-FAT-01'));
  });

  it('VC-FAT-03: repeating history gives only full cycles', () => {
    const cycles = rainflowRepeating(E1049);
    expect(totalsOf(cycles)).toEqual(expectedValue('07-fatigue', 'VC-FAT-03'));
    expect(cycles.every((c) => c.count === 1)).toBe(true);
    expect(totalsOf(countCycles(E1049, 'rainflow_3pt', 'repeat'))).toEqual(expectedValue('07-fatigue', 'VC-FAT-03'));
  });

  it('VC-FAT-04: the S2 TEST_CASE_2 history', () => {
    expect(totalsOf(rainflowThreePoint(S2_CASE2))).toEqual(expectedValue('07-fatigue', 'VC-FAT-04'));
  });

  it('extracts reversals: plateaus collapsed, monotone runs merged, ends kept', () => {
    expect(reversalsOf([0, 0, 1, 2, 2, 1, 0, 3])).toEqual([0, 2, 0, 3]);
  });

  it('a gate drops reversals smaller than the band and may leave a single point', () => {
    expect(reversalsOf([0, 5, 4.5, 5.2, -3], 1)).toEqual([0, 5, -3]);
    expect(reversalsOf([0, 0.1, 0], 1)).toEqual([0]);
  });

  it('cycles carry from / to / range / mean', () => {
    const [first] = rainflowThreePoint([0, 10, 2, 8, 0]);
    expect(first).toMatchObject({ range: 6, mean: 5, count: 1 });
  });

  it('degenerate histories give no cycle', () => {
    expect(rainflowRepeating([1])).toEqual([]);
    expect(rainflowThreePoint([1, 2])).toHaveLength(1);
  });
});
