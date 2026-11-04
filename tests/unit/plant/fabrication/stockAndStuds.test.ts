/** ISO-M6 follow-ups: stock-length nesting of the cut list (V1) and stud lengths of the bolting by the PSC named rule. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { nestPieces } from '@aec/plant/fabrication/stockNesting';
import type { CutPiece } from '@aec/plant/fabrication/cutList';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { loadedL101 } from './isoM2Fixtures';

const piece = (name: string, cutLengthMm: number, itemCode: string | null = 'PIPE-100-S40', boreMm = 100): CutPiece => ({
  piece: name,
  spool: 'S',
  componentId: name,
  boreMm,
  itemCode,
  centrelineLengthMm: cutLengthMm,
  cutLengthMm,
  adjustments: [],
});

describe('nestPieces', () => {
  const pieces = [5000, 4000, 3000, 2500, 2000, 1500].map((length, index) => piece(`P${index + 1}`, length));

  it('6 m stock only: first-fit decreasing, 4 bars, 25 % waste (hand-checked)', () => {
    const nesting = nestPieces(pieces, [6000], 0);
    expect(nesting.groups[0]?.bars.map((bar) => bar.pieces)).toEqual([['P1'], ['P2', 'P5'], ['P3', 'P4'], ['P6']]);
    expect(nesting.barsByLength).toEqual({ '6000': 4 });
    expect(nesting.stockMm).toBe(24000);
    expect(nesting.cutMm).toBe(18000);
    expect(nesting.wastePercent).toBe(25);
  });

  it('6 m and 12 m stock: a 12 m bar takes the three long pieces, a 6 m bar the rest, no waste', () => {
    const nesting = nestPieces(pieces, [12000, 6000], 0);
    expect(nesting.stockLengthsMm).toEqual([6000, 12000]);
    expect(nesting.barsByLength).toEqual({ '12000': 1, '6000': 1 });
    expect(nesting.wastePercent).toBe(0);
    expect(nesting.totalBars).toBe(2);
  });

  it('a kerf per piece: 3 x 2000 in a 6 m bar fits at kerf 0 and needs a second bar at kerf 5', () => {
    const three = [1, 2, 3].map((n) => piece(`K${n}`, 2000));
    expect(nestPieces(three, [6000], 0).totalBars).toBe(1);
    const kerf = nestPieces(three, [6000], 5);
    expect(kerf.totalBars).toBe(2);
    expect(kerf.groups[0]?.bars[0]?.offcutMm).toBe(1990);
  });

  it('pieces of another item code or bore never share a bar; deterministic', () => {
    const mixed = [piece('A', 1000), piece('B', 1000, 'PIPE-50-S40', 50), piece('C', 1000, null)];
    const nesting = nestPieces(mixed, [6000], 0);
    expect(nesting.groups.map((group) => [group.itemCode, group.boreMm, group.bars.length])).toEqual([
      ['PIPE-100-S40', 100, 1],
      ['PIPE-50-S40', 50, 1],
      [null, 100, 1],
    ]);
    expect(JSON.stringify(nestPieces(mixed, [6000], 0))).toBe(JSON.stringify(nesting));
  });
});

describe('cut_list stockLengthsMm', () => {
  const doc = loadedL101();
  const params = { lineId: 'L-101', weldGapMm: 3 };
  type Cut = { pieces: Array<{ piece: string; cutLengthMm: number }>; nesting?: ReturnType<typeof nestPieces> };

  it('nests the listed pieces: every piece once, bars within their stock length', () => {
    const result = data<Cut>(doc, 'cut_list', { ...params, stockLengthsMm: [6000, 12000], kerfMm: 2 });
    const nesting = result.nesting;
    expect(nesting?.kerfMm).toBe(2);
    const placed = nesting?.groups.flatMap((group) => group.bars.flatMap((bar) => bar.pieces)) ?? [];
    expect([...placed].sort()).toEqual(result.pieces.map((entry) => entry.piece).sort());
    for (const bar of nesting?.groups.flatMap((group) => group.bars) ?? []) {
      expect(bar.cutMm + 2 * bar.pieces.length).toBeLessThanOrEqual(bar.stockLengthMm);
      expect(bar.offcutMm).toBeGreaterThanOrEqual(0);
    }
    expect(nesting?.cutMm).toBeCloseTo(
      result.pieces.reduce((sum, entry) => sum + entry.cutLengthMm, 0),
      6,
    );
  });

  it('without stockLengthsMm there is no nesting; spoolId narrows the nested pieces', () => {
    expect(data<Cut>(doc, 'cut_list', params).nesting).toBeUndefined();
    const one = data<Cut>(doc, 'cut_list', { ...params, spoolId: 'L-101-SP01', stockLengthsMm: [12000] });
    expect(one.nesting?.groups.flatMap((group) => group.bars.flatMap((bar) => bar.pieces)).length).toBe(one.pieces.length);
  });

  it('refuses a piece longer than the longest stock, and kerfMm without stockLengthsMm; is pure', () => {
    expectRefusal(doc, 'cut_list', { ...params, stockLengthsMm: [1000] }, 'ISO_STOCK_TOO_SHORT', 'stockLengthsMm');
    expectRefusal(doc, 'cut_list', { ...params, kerfMm: 2 }, 'ISO_PARAM_INVALID', 'kerfMm');
    const before = JSON.stringify(doc);
    expect(execute(doc, 'cut_list', { ...params, stockLengthsMm: [12000] }).document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('piping_bom stud length', () => {
  type Bom = {
    bolting?: {
      groups: Array<{
        stud: { lengthMm: number; lengthIn: string | null; method: string; verified: boolean; assumptions: string[] } | null;
      }>;
    };
  };
  const doc = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
  const bolts = (extra: Record<string, unknown> = {}): Bom =>
    data<Bom>(doc, 'piping_bom', { scope: 'line', lineId: 'L-101', includeBolting: true, matingFlanges: 'assume_in_scope', ...extra });

  it('class 150 NPS 4: 22.4 + 1.6 + 22.4 + 1.6 + 4.5 + 2 x 15.875 + 4 x 2.309 = 93.5 mm, stocked at 95.25 mm (3-3/4 in), derived, never verified', () => {
    const stud = bolts().bolting?.groups[0]?.stud;
    expect(stud).toMatchObject({ lengthMm: 95.25, lengthIn: '3-3/4', method: 'rule', verified: false });
    expect(stud?.assumptions.join(' ')).toContain('gasket 4.5 mm ASSUMED');
  });

  it('a given gasket thickness is used and named', () => {
    const stud = bolts({ gasketThicknessMm: 10 }).bolting?.groups[0]?.stud;
    expect(stud?.lengthMm).toBe(101.6);
    expect(stud?.assumptions.join(' ')).toContain('gasket 10 mm given by the caller');
  });

  it('no includeBolting, no stud', () => {
    expect(data<Bom>(doc, 'piping_bom', { scope: 'line', lineId: 'L-101' }).bolting).toBeUndefined();
  });
});
