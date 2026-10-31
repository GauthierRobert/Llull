/** Plant 05 ISO M2: the cut list (VC-ISO-07): gap 0 / 3 mm, SKEY WF allowance 100 mm, explicit gap and allowance (AF-31), refusals. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { loadedL101, refNumber, withWeldSkey } from './isoM2Fixtures';

interface Piece {
  piece: string;
  spool: string;
  componentId: string;
  boreMm: number;
  itemCode: string | null;
  centrelineLengthMm: number;
  cutLengthMm: number;
  adjustments: Array<{ end: string; kind: string; mm: number }>;
}
interface CutData {
  pieces: Piece[];
  totalMm: number;
  centrelineTotalMm: number;
  provenance: Record<string, { value: number; source: string }>;
}

const results = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/expected_results.json'), 'utf8'),
) as { cases: Array<{ id: string; expected: Record<string, number[] | string[]> }> };
const vc07 = results.cases.find((entry) => entry.id === 'VC-ISO-07')?.expected as Record<string, number[]>;

const cuts = (doc: ReturnType<typeof loadedL101>, params: Record<string, unknown>): CutData =>
  data<CutData>(doc, 'cut_list', { lineId: 'L-101', ...params });
const lengths = (result: CutData): number[] => result.pieces.map((piece) => piece.cutLengthMm);

describe('VC-ISO-07: cut lengths of the fixture', () => {
  const doc = loadedL101();

  it('gap 0: the cut lengths are the centreline lengths, named <spool>-P<k> in flow order', () => {
    const result = cuts(doc, { weldGapMm: 0 });
    expect(lengths(result)).toEqual(vc07['gap0']);
    expect(result.pieces.map((piece) => piece.piece)).toEqual(
      results.cases.find((entry) => entry.id === 'VC-ISO-07')?.expected['pieceNames'],
    );
    expect(result.pieces.map((piece) => refNumber(piece.componentId))).toEqual(['2', '4', '6', '8', '10', '12', '14']);
    expect(result.pieces[0]).toMatchObject({ spool: 'L-101-SP01', boreMm: 100, itemCode: 'PIPE-100-S40', centrelineLengthMm: 2424 });
  });

  it('gap 3: -1.5 mm per welded end, every piece -3 mm', () => {
    const result = cuts(doc, { weldGapMm: 3 });
    expect(lengths(result)).toEqual(vc07['gap3']);
    expect(result.pieces[0]?.adjustments).toEqual([
      { end: 'start', kind: 'weld_gap', mm: -1.5 },
      { end: 'end', kind: 'weld_gap', mm: -1.5 },
    ]);
    expect(result.totalMm).toBeCloseTo(13045 - 21, 6);
    expect(result.centrelineTotalMm).toBeCloseTo(13045, 6);
    expect(result.provenance['weldGapMm']).toEqual({ value: 3, source: 'param weldGapMm' });
  });

  it('SKEY WF with allowance 100: each cut at the field-fit weld gets +100 (gap 0 and gap 3)', () => {
    const wf = loadedL101(withWeldSkey('WF'));
    expect(lengths(cuts(wf, { weldGapMm: 0, fieldFitAllowanceMm: 100 }))).toEqual(vc07['weldSkeyWF_allowance100_gap0']);
    const withGap = cuts(wf, { weldGapMm: 3, fieldFitAllowanceMm: 100 });
    expect(lengths(withGap)).toEqual(vc07['weldSkeyWF_allowance100_gap3']);
    expect(withGap.pieces[0]?.adjustments.map((adjustment) => adjustment.kind)).toEqual(['weld_gap', 'weld_gap', 'field_fit_allowance']);
  });

  it('values stored with set_fabrication_rules are used, with their source; params win', () => {
    const ruled = apply(doc, 'set_fabrication_rules', { source: 'shop std', weldGapMm: 2 });
    const stored = cuts(ruled, {});
    expect(stored.pieces[0]?.cutLengthMm).toBe(2422);
    expect(stored.provenance['weldGapMm']).toEqual({ value: 2, source: 'shop std' });
    expect(cuts(ruled, { weldGapMm: 0 }).pieces[0]?.cutLengthMm).toBe(2424);
  });

  it('spoolId keeps one spool', () => {
    const result = cuts(doc, { weldGapMm: 0, spoolId: 'L-101-SP01' });
    expect(result.pieces.map((piece) => piece.piece)).toEqual(['L-101-SP01-P1']);
  });

  it('a field-fit weld set by set_weld_type needs the allowance too', () => {
    const numbered = apply(doc, 'number_welds', { lineId: 'L-101' });
    const fieldFit = apply(numbered, 'set_weld_type', { weldId: 'L-101#2', type: 'field_fit' });
    expectRefusal(fieldFit, 'cut_list', { lineId: 'L-101', weldGapMm: 0 }, 'ISO_GAP_UNDEFINED', 'fieldFitAllowanceMm');
    expect(lengths(cuts(fieldFit, { weldGapMm: 0, fieldFitAllowanceMm: 50 }))[0]).toBe(2474);
  });
});

describe('refusals', () => {
  const doc = loadedL101();

  it('no gap anywhere: ISO_GAP_UNDEFINED (never a silent default)', () => {
    expectRefusal(doc, 'cut_list', { lineId: 'L-101' }, 'ISO_GAP_UNDEFINED', 'weldGapMm');
  });

  it('a piece not longer than the minimum: ISO_CUT_LENGTH_SHORT with the component ids', () => {
    const refused = expectRefusal(doc, 'cut_list', { lineId: 'L-101', weldGapMm: 1000 }, 'ISO_CUT_LENGTH_SHORT');
    expect(refused.error?.ids.map(refNumber)).toEqual(['12', '14']);
    const ruled = apply(doc, 'set_fabrication_rules', { source: 's', minCutPieceMm: 400 });
    expectRefusal(ruled, 'cut_list', { lineId: 'L-101', weldGapMm: 0 }, 'ISO_CUT_LENGTH_SHORT');
  });

  it('unknown line and unknown spool', () => {
    expectRefusal(doc, 'cut_list', { lineId: 'NOPE', weldGapMm: 0 }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(doc, 'cut_list', { lineId: 'L-101', weldGapMm: 0, spoolId: 'X' }, 'ISO_SPOOL_NOT_FOUND', 'spoolId');
  });

  it('is a query: the same document comes back', () => {
    expect(execute(doc, 'cut_list', { lineId: 'L-101', weldGapMm: 3 }).document).toBe(doc);
  });
});
