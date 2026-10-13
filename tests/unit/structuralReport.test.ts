import { describe, expect, it } from 'vitest';
import { isFailing, toWarnings, worstRows } from '@ui/panels/building/structuralReport';

describe('structuralReport', () => {
  it('sorts rows by utilisation descending and keeps the top N', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ elementId: `e${i}`, utilisation: i / 10 }));
    const top = worstRows({ rows });
    expect(top).toHaveLength(12);
    expect(top[0]?.elementId).toBe('e14');
    expect(worstRows({ rows }, 2).map((row) => row.elementId)).toEqual(['e14', 'e13']);
  });
  it('labels rows and flags failures', () => {
    const [row] = worstRows({ members: [{ mark: 'C1', kind: 'column', id: 'x', utilisation: 1.2, ok: true }] });
    expect(row?.label).toBe('C1 · column');
    expect(row?.elementId).toBe('x');
    expect(row && isFailing(row)).toBe(true);
    const [notOk] = worstRows({ rows: [{ utilisation: 0.1, ok: false }] });
    expect(notOk && isFailing(notOk)).toBe(true);
  });
  it('turns pipe results into span rows', () => {
    const [pipe] = worstRows({ pipes: [{ id: 'p1', line: 'L1', dn: 100, largestSpanM: 3, allowedSpanM: 4 }] });
    expect(pipe?.utilisation).toBeCloseTo(0.75);
    expect(pipe?.detail).toBe('span 3.0 / 4.0 m');
    expect(pipe?.label).toBe('L1 · DN100');
  });
  it('ignores malformed data', () => {
    expect(worstRows(null)).toEqual([]);
    expect(worstRows({ rows: [{ nope: 1 }] })).toEqual([]);
    expect(toWarnings({ warnings: ['a', 3] })).toEqual(['a']);
    expect(toWarnings(undefined)).toEqual([]);
  });
});
