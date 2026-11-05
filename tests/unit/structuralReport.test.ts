import { describe, expect, it } from 'vitest';
import { isFailing, isRefused, toWarnings, worstRows } from '@ui/panels/building/structuralReport';
import {
  toUtilisationMarks,
  utilisationBand,
  utilisationColor,
  UTILISATION_COLORS,
  UTILISATION_LEGEND,
} from '@ui/panels/building/utilisationColor';

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
  it('a refused row is neither a pass nor a failure and lists first, with its code', () => {
    const rows = worstRows({
      rows: [
        { mark: 'C1', kind: 'column', elementId: 'a', utilisation: 99, refusal: { code: 'STL_GRADE_UNKNOWN', message: 'x' } },
        { mark: 'R1', kind: 'rafter', elementId: 'b', utilisation: 1.4 },
      ],
    });
    expect(rows[0]?.elementId).toBe('a');
    expect(rows[0] && isRefused(rows[0])).toBe(true);
    expect(rows[0] && isFailing(rows[0])).toBe(false);
    expect(rows[0]?.detail).toBe('refused (STL_GRADE_UNKNOWN)');
    expect(rows[1] && isRefused(rows[1])).toBe(false);
  });
  it('colours a refused row with its own band, never green or red, and marks it on the model', () => {
    expect(utilisationBand(99, true, true)).toBe('refused');
    expect(utilisationColor(99, true, true)).toBe(UTILISATION_COLORS.refused);
    expect(UTILISATION_COLORS.refused).not.toBe(UTILISATION_COLORS.ok);
    expect(UTILISATION_COLORS.refused).not.toBe(UTILISATION_COLORS.fail);
    expect(UTILISATION_LEGEND.some((entry) => entry.band === 'refused')).toBe(true);
    const rows = worstRows({
      rows: [{ mark: 'C1', kind: 'column', elementId: 'a', utilisation: 99, refusal: { code: 'STL_GRADE_UNKNOWN', message: 'x' } }],
    });
    const building = { elements: { a: { entityIds: ['e1'] } } } as unknown as Parameters<typeof toUtilisationMarks>[1];
    expect(toUtilisationMarks(rows, building)).toMatchObject([{ refused: true, failing: false }]);
  });
});
