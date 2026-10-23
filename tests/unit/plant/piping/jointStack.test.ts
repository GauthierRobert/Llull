/** Joint stack and cut-back along a leg (02 RTE §5.3; VC-RTE-01, 04, 10). */

import { describe, expect, it } from 'vitest';
import { defaultMinWeldSpacing, stackLeg, type Interval, type Stack, type StackFailure } from '@aec/plant/piping/jointStack';

const fitting = (id: string, start: number, end: number, gap = 0): Interval => ({ id, start, end, gap, kind: 'fitting' });
const inline = (id: string, start: number, end: number, gap = 0): Interval => ({ id, start, end, gap, kind: 'inline' });

const stack = (result: Stack | StackFailure): Stack => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result as Stack;
};
const failure = (result: Stack | StackFailure): StackFailure => {
  expect(result.ok).toBe(false);
  return result as StackFailure;
};

describe('stackLeg: SC-RTE-01', () => {
  it('leg 0 starts behind a flange set (gasket 3 + hub 76) and ends at an LR elbow (152): cut 1269', () => {
    const result = stack(stackLeg(1500, [fitting('flange-1', 0, 79), fitting('elbow-1', 1348, 1500)], 50));
    expect(result.pieces).toEqual([{ start: 79, end: 1348, cut: 1269, from: 'flange-1', to: 'elbow-1' }]);
    expect(result.warnings).toEqual([]);
  });

  it('leg 4 ends behind the second flange set: 3000 - 152 - 76 - 3 = 2769', () => {
    const result = stack(stackLeg(3000, [fitting('elbow-4', 0, 152), fitting('flange-2', 2921, 3000)], 50));
    expect(result.pieces[0]?.cut).toBe(2769);
  });

  it('a leg between two elbows: 3000 - 2 x 152 = 2696; 1500 - 2 x 152 = 1196', () => {
    expect(stack(stackLeg(3000, [fitting('a', 0, 152), fitting('b', 2848, 3000)], 50)).pieces[0]?.cut).toBe(2696);
    expect(stack(stackLeg(1500, [fitting('a', 0, 152), fitting('b', 1348, 1500)], 50)).pieces[0]?.cut).toBe(1196);
  });
});

describe('stackLeg: inline valve (SC-RTE-02, VC-RTE-04)', () => {
  it('a 229 mm gate valve centred 800 from the start of the leg (z 1800) splits leg 0 into 527.5 and 354.5', () => {
    // Leg from z 1000 to the elbow centre z 2500: flange set 79 at the start, elbow 152 at the end; valve + 2 x (gasket 3 + hub 76) around its faces.
    const faceLow = 800 - 229 / 2;
    const faceHigh = 800 + 229 / 2;
    const result = stack(
      stackLeg(1500, [fitting('flange-1', 0, 79), inline('valve-1', faceLow - 79, faceHigh + 79), fitting('elbow-1', 1348, 1500)], 50),
    );
    expect(result.pieces.map((piece) => piece.cut)).toEqual([527.5, 354.5]);
    expect(result.pieces.map((piece) => [piece.from, piece.to])).toEqual([
      ['flange-1', 'valve-1'],
      ['valve-1', 'elbow-1'],
    ]);
  });

  it('refuses a valve that overlaps a fitting with RTE_INLINE_DOES_NOT_FIT, naming the pair', () => {
    const result = failure(stackLeg(1500, [fitting('flange-1', 0, 79), inline('valve-1', 60, 400)], 50));
    expect(result.code).toBe('RTE_INLINE_DOES_NOT_FIT');
    expect(result.detail).toMatchObject({ from: 'flange-1', to: 'valve-1', cutLengthMm: -19 });
  });
});

describe('stackLeg: short legs between two NPS 4 elbows (SC-RTE-05, VC-RTE-10)', () => {
  const between = (length: number): Stack | StackFailure =>
    stackLeg(length, [fitting('a', 0, 152), fitting('b', length - 152, length)], defaultMinWeldSpacing(6.02));

  it('250 mm: cut -54, refused with RTE_SEGMENT_TOO_SHORT and the cut length in the detail', () => {
    const result = failure(between(250));
    expect(result.code).toBe('RTE_SEGMENT_TOO_SHORT');
    expect(result.detail.cutLengthMm).toBe(-54);
    expect(result.detail.legLengthMm).toBe(250);
  });

  it('304 mm: zero cut is fitting-to-fitting, no pipe piece, warning RTE_FITTING_TO_FITTING', () => {
    const result = stack(between(304));
    expect(result.pieces).toEqual([]);
    expect(result.fittingToFitting).toEqual([{ from: 'a', to: 'b', at: 152 }]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['RTE_FITTING_TO_FITTING']);
  });

  it('340 mm: a 36 mm piece is shorter than the named default weld spacing max(4 t, 50) = 50: warning, piece kept', () => {
    expect(defaultMinWeldSpacing(6.02)).toBe(50);
    const result = stack(between(340));
    expect(result.pieces.map((piece) => piece.cut)).toEqual([36]);
    expect(result.warnings).toEqual([{ code: 'RTE_WELD_SPACING', from: 'a', to: 'b', cutLengthMm: 36, minimumMm: 50 }]);
    expect(defaultMinWeldSpacing(20)).toBe(80);
  });
});

describe('stackLeg: weld gaps', () => {
  it('deducts the gap of each adjoining joint from the piece (named default 0 leaves the cut unchanged)', () => {
    const open = stack(stackLeg(3000, [fitting('a', 0, 152, 0), fitting('b', 2848, 3000, 0)], 50));
    const gapped = stack(stackLeg(3000, [fitting('a', 0, 152, 1.6), fitting('b', 2848, 3000, 1.6)], 50));
    expect(open.pieces[0]?.cut).toBe(2696);
    expect(gapped.pieces[0]?.cut).toBeCloseTo(2692.8, 9);
    expect(gapped.pieces[0]).toMatchObject({ start: 153.6, end: 2846.4 });
  });

  it('sorts intervals by position, so callers need not order them', () => {
    const result = stack(stackLeg(3000, [fitting('b', 2848, 3000), fitting('a', 0, 152)], 50));
    expect(result.pieces[0]).toMatchObject({ from: 'a', to: 'b', cut: 2696 });
  });
});
