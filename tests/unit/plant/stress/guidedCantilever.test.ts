/**
 * Plant 07 PST M1: guided_cantilever. VC-PST-06 (beam theory, 1e-6 rel, grade A): NPS 6 Sch 40, E 200 GPa, L 6 m, d 50 mm:
 * I = pi/64 (168.3^4 - 154.08^4) = 1.17162e7 mm4, F = 12 E I d / L^3 = 6509.017 N, M = 6 E I d / L^2 = 1.9527e7 N.mm, S = 3 E D d / L^2 = 140.25 MPa,
 * Lmin = sqrt(3 E D d / 206.85) = 4940.55 mm. The L-bend comparison (VC-PST-12) pins the screening bias: 151.47 MPa against 106.79 exact.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRel, referenceData } from './stressFixtures';

interface Cantilever {
  forceN: number;
  momentNmm: number;
  stressMPa: number;
  minLegMm?: number;
  ratio?: number;
  withinAllowable?: boolean;
  grade: string;
  reviewRequired: boolean;
}

const doc = createEmptyDocument();
const NPS6 = { legMm: 6000, displacementMm: 50, odMm: 168.3, wallMm: 7.11, EMPa: 200000 };
const cantilever = (params: Record<string, unknown>): Cantilever => data<Cantilever>(doc, 'guided_cantilever', params);

describe('VC-PST-06 guided cantilever (grade A)', () => {
  const { guidedCantilever: reference } = referenceData<{
    guidedCantilever: { expected: { F_N: number; M_Nmm: number; S_MPa: number; 'LminMm_for_SA_206.85': number } };
  }>('lbend_guided_cantilever.json');

  it('force, moment, stress and minimum leg meet the reference to 1e-6', () => {
    const result = cantilever({ ...NPS6, SAMPa: 206.85 });
    expectRel(result.forceN, reference.expected.F_N, 1e-6, 'F');
    expectRel(result.momentNmm, reference.expected.M_Nmm, 1e-6, 'M');
    expectRel(result.stressMPa, reference.expected.S_MPa, 1e-6, 'S');
    expectRel(result.minLegMm as number, reference.expected['LminMm_for_SA_206.85'], 1e-6, 'Lmin');
    expect(result.withinAllowable).toBe(true);
    expect(result.ratio).toBeCloseTo(140.25 / 206.85, 9);
    expect(result.grade).toBe('A');
    expect(result.reviewRequired).toBe(true);
  });

  it('a leg shorter than Lmin is over the allowable', () => {
    const short = cantilever({ ...NPS6, legMm: 4000, SAMPa: 206.85 });
    expect(short.withinAllowable).toBe(false);
    expect(short.stressMPa).toBeGreaterThan(206.85);
    expect(short.minLegMm).toBeCloseTo(4940.5457, 3);
  });

  it('without SA there is no minimum leg or ratio', () => {
    const result = cantilever(NPS6);
    expect(result.minLegMm).toBeUndefined();
    expect(result.ratio).toBeUndefined();
  });

  it('the short leg of the two-anchor L-bend over-predicts: 151.47 MPa against the exact 106.79 (screening bias, VC-PST-12)', () => {
    const shortLeg = cantilever({ ...NPS6, legMm: 3000, displacementMm: 13.5 });
    expectRel(shortLeg.stressMPa, 151.47, 1e-3);
    expect(shortLeg.stressMPa).toBeGreaterThan(106.7912);
  });
});

describe('contract', () => {
  it('refuses a non-physical section', () => {
    expectRefusal(doc, 'guided_cantilever', { ...NPS6, wallMm: 84.15 }, 'PST_PARAM_INVALID', 'wallMm');
  });

  it('rejects a zero leg or a missing modulus at the schema', () => {
    for (const params of [
      { ...NPS6, legMm: 0 },
      { ...NPS6, EMPa: undefined },
    ]) {
      const result = execute(doc, 'guided_cantilever', params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'guided_cantilever', NPS6));
  });
});
