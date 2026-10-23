/** Turns and elbow choice (02 RTE §5.2; VC-RTE-03, 08, 11, 15). */

import { describe, expect, it } from 'vitest';
import { arcLength, centrelineLength, chooseElbow, turnAngleDeg, type ElbowChoice, type FittingFailure } from '@aec/plant/piping/fittings';
import { createSpecLookup, isMiss, type SpecLookup, type SpecMiss } from '@aec/plant/piping/specLookup';
import { apply } from '../../../helpers/commandAssertions';
import { cs150Document } from './rteFixtures';

function lookupOf(doc = cs150Document()): SpecLookup {
  const lookup = createSpecLookup(doc, 'CS150');
  if (isMiss(lookup)) throw new Error(lookup.detail);
  return lookup;
}

const elbow = (result: ElbowChoice | FittingFailure | SpecMiss): ElbowChoice => {
  expect('nominalDeg' in result, JSON.stringify(result)).toBe(true);
  return result as ElbowChoice;
};

describe('turnAngleDeg', () => {
  it('measures the angle between leg directions', () => {
    expect(turnAngleDeg([1, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
    expect(turnAngleDeg([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(turnAngleDeg([1, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 12);
    expect(turnAngleDeg([0, 0, 1], [Math.SQRT1_2, 0, Math.SQRT1_2])).toBeCloseTo(45, 12);
  });
});

describe('chooseElbow', () => {
  it('takes the 90 degree centre-to-end from the catalogue row (152, the stub input, not the 152.4 of the bundled B16.9 row)', () => {
    const choice = elbow(chooseElbow(lookupOf(), 100, 90, 1));
    expect(choice.nominalDeg).toBe(90);
    expect(choice.row.key).toBe('CS150/E90-LR/100');
    expect(choice.centreToEnd).toBe(152);
    expect(choice.radius).toBe(152);
    expect(choice.deviationDeg).toBe(0);
    expect(choice.row.unverified).toBe(true);
  });

  it('accepts 89.427061 degrees as a standard 90 within 1 degree and reports the deviation; 0.5 degrees refuses (VC-RTE-08)', () => {
    const turn = (Math.acos(80 / 8000.39999) * 180) / Math.PI;
    expect(turn).toBeCloseTo(89.427061, 6);
    const choice = elbow(chooseElbow(lookupOf(), 100, turn, 1));
    expect(choice.nominalDeg).toBe(90);
    expect(choice.deviationDeg).toBeCloseTo(0.572939, 6);
    expect(choice.centreToEnd).toBe(152);
    const refused = chooseElbow(lookupOf(), 100, turn, 0.5) as FittingFailure;
    expect(refused.code).toBe('RTE_NO_FITTING_FOR_ANGLE');
    expect(refused.detail['angleDeg']).toBeCloseTo(89.427061, 6);
  });

  it('refuses 60 degrees on a 90 / 45 spec with the angle in the detail (VC-RTE-11), and a reversal', () => {
    const refused = chooseElbow(lookupOf(), 100, 60, 1) as FittingFailure;
    expect(refused.code).toBe('RTE_NO_FITTING_FOR_ANGLE');
    expect(refused.detail).toMatchObject({ angleDeg: 60, anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: false });
    expect((chooseElbow(lookupOf(), 100, 180, 1) as FittingFailure).code).toBe('RTE_NO_FITTING_FOR_ANGLE');
  });

  it('reads the 45 degree B from the table (64), never R tan 22.5 (VC-RTE-15)', () => {
    const choice = elbow(chooseElbow(lookupOf(), 100, 45, 1));
    expect(choice.row.key).toBe('CS150/E45-LR/100');
    expect(choice.centreToEnd).toBe(64);
    expect(Math.abs(choice.centreToEnd - 152 * Math.tan(Math.PI / 8))).toBeGreaterThan(1);
    // The arc radius is derived so the arc is tangent to both ports.
    expect(choice.radius).toBeCloseTo(64 / Math.tan(Math.PI / 8), 6);
  });

  it('falls back to the bundled B16.9 rows (152.4) when the stub has no row for the size', () => {
    const bigger = apply(cs150Document(), 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [
        { op: 'setSizeRange', sizeRange: { fromNps: 2, toNps: 8 } },
        { op: 'updateComponent', id: 'P-BW', changes: { toNps: 8 } },
        { op: 'updateComponent', id: 'E90-LR', changes: { toNps: 8 } },
      ],
    });
    const choice = elbow(chooseElbow(lookupOf(bigger), 200, 90, 1));
    // NPS 8 is not in the stub catalogue: its LR rule row gives 1.5 x 8 x 25.4 = 304.8 (bundled B16.9 rule, grade A).
    expect(choice.centreToEnd).toBeCloseTo(304.8, 6);
  });

  it('uses the angles of the spec elbow components when the spec declares none (named default tolerance)', () => {
    const doc = apply(cs150Document(), 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'setHeader', fields: { elbowAngles: null } }] });
    const rule = lookupOf(doc).elbowAngles();
    expect(rule).toEqual({ anglesDeg: [90, 45], toleranceDeg: 1, trimmedAllowed: false, defaulted: true });
  });

  it('returns the spec miss when the spec has no elbow, and refuses an angle the model has no elbow type for', () => {
    const noElbows = apply(cs150Document(), 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [
        { op: 'removeComponent', id: 'E90-LR' },
        { op: 'setHeader', fields: { elbowAngles: { anglesDeg: [90, 60], toleranceDeg: 1, trimmedAllowed: false } } },
      ],
    });
    const missing = chooseElbow(lookupOf(noElbows), 100, 90, 1) as SpecMiss;
    expect(missing.miss).toBe('RTE_SPEC_NO_COMPONENT');
    const sixty = chooseElbow(lookupOf(noElbows), 100, 60, 1) as FittingFailure;
    expect(sixty.code).toBe('RTE_NO_FITTING_FOR_ANGLE');
    expect(sixty.message).toContain('no elbow type');
  });

  it('names a row without centreToEnd', () => {
    const real = lookupOf();
    const row = real.component({ types: ['elbow90'], dn: 100 });
    if (isMiss(row)) throw new Error(row.detail);
    const fake: SpecLookup = { ...real, component: () => ({ ...row, dims: {} }) };
    const result = chooseElbow(fake, 100, 90, 1) as SpecMiss;
    expect(result.miss).toBe('RTE_SPEC_NO_COMPONENT');
    expect(result.detail).toContain('centreToEnd');
  });
});

describe('centreline length (VC-RTE-03)', () => {
  it('SC-RTE-01: 12000 - 4 x 2 x 152 + 4 x (pi/2) x 152 = 11739.044', () => {
    const choice = elbow(chooseElbow(lookupOf(), 100, 90, 1));
    expect(arcLength(choice.radius, 90)).toBeCloseTo(238.761, 3);
    const length = centrelineLength([1500, 3000, 3000, 1500, 3000], [choice, choice, choice, choice]);
    expect(length).toBeCloseTo(11739.044, 3);
    expect(centrelineLength([1000], [])).toBe(1000);
  });
});
