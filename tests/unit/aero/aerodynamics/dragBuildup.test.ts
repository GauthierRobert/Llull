/** drag_buildup (10 AER M3, VC-AER-37): each table entry recomputed from the sourced closed forms (validation/data/vlm_references.json S15-S16). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { data, expectRefusal } from '../../../helpers/commandAssertions';

interface Row {
  name: string;
  reynolds: number;
  cf: number;
  formFactor: number;
  formFactorModel: string;
  interferenceDefaulted: boolean;
  cd0: number;
  percent: number;
}
interface Buildup {
  flow: { speedMS: number; mach: number; dynamicPressurePa: number; air: { densityKgM3: number; viscosityPaS: number } };
  components: Row[];
  cd0: number;
  dragN: number;
  warnings: string[];
  formulas: Record<string, string>;
}

const doc = createEmptyDocument();
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

const wing = {
  name: 'wing',
  kind: 'lifting',
  wettedAreaM2: 32,
  referenceLengthM: 1.5,
  thicknessRatio: 0.12,
  maxThicknessX: 0.3,
  sweepDeg: 10,
};
const fuselage = { name: 'fuselage', kind: 'body', wettedAreaM2: 25, referenceLengthM: 8, finenessRatio: 6, interferenceFactor: 1.1 };

describe('drag_buildup (VC-AER-37)', () => {
  it('Raymer wing and Torenbeek body rows equal the closed forms; CD0 sums the rows', () => {
    const result = data<Buildup>(doc, 'drag_buildup', { components: [wing, fuselage], referenceAreaM2: 16, speed: 70, altitudeM: 1000 });
    const { mach, speedMS, air, dynamicPressurePa } = result.flow;
    const [w, f] = result.components as [Row, Row];
    const reWing = (air.densityKgM3 * speedMS * 1.5) / air.viscosityPaS;
    expect(rel(w.reynolds, reWing)).toBeLessThan(1e-8);
    const cfTurb = (re: number): number => 0.455 / Math.log10(re) ** 2.58 / (1 + 0.144 * mach * mach) ** 0.65;
    expect(rel(w.cf, cfTurb(w.reynolds))).toBeLessThan(1e-8);
    const ffWing = (1 + (0.6 / 0.3) * 0.12 + 100 * 0.12 ** 4) * 1.34 * mach ** 0.18 * Math.cos((10 * Math.PI) / 180) ** 0.28;
    expect(rel(w.formFactor, ffWing)).toBeLessThan(1e-8);
    expect(rel(f.formFactor, 1 + 2.2 / 6 ** 1.5 + 3.8 / 6 ** 3)).toBeLessThan(1e-8);
    expect(rel(f.cd0, (f.cf * f.formFactor * 1.1 * 25) / 16)).toBeLessThan(1e-8);
    expect(rel(result.cd0, w.cd0 + f.cd0)).toBeLessThan(1e-8);
    expect(rel(result.dragN, dynamicPressurePa * 16 * result.cd0)).toBeLessThan(1e-8);
    expect(w.percent + f.percent).toBeCloseTo(100, 6);
    expect(w.interferenceDefaulted).toBe(true);
    expect(f.interferenceDefaulted).toBe(false);
    expect(result.warnings.some((text) => text.includes('interferenceFactor defaulted'))).toBe(true);
    expect(result.formulas['raymerLifting']).toContain('12.30');
  });

  it('Hoerner / Torenbeek lifting and Hoerner body form factors; laminar fraction lowers Cf; low Mach warns for raymer', () => {
    const result = data<Buildup>(doc, 'drag_buildup', {
      components: [
        { ...wing, formFactorModel: 'hoerner' },
        { ...wing, name: 'tail', formFactorModel: 'torenbeek', laminarFraction: 0.3 },
        { ...fuselage, formFactorModel: 'hoerner' },
        { ...wing, name: 'strut' },
      ],
      referenceAreaM2: 16,
      speed: 100,
      speedUnit: 'km/h',
    });
    const [hoerner, torenbeek, body] = result.components as [Row, Row, Row];
    expect(rel(hoerner.formFactor, 1 + 2 * 0.12 + 60 * 0.12 ** 4)).toBeLessThan(1e-8);
    expect(rel(torenbeek.formFactor, 1 + 2.7 * 0.12 + 100 * 0.12 ** 4)).toBeLessThan(1e-8);
    expect(rel(body.formFactor, 1 + 1.5 / 6 ** 1.5 + 7 / 6 ** 3)).toBeLessThan(1e-8);
    const k = 0.3;
    const { mach } = result.flow;
    const turb = (re: number): number => 0.455 / Math.log10(re) ** 2.58 / (1 + 0.144 * mach * mach) ** 0.65;
    const mixed = (1.328 / Math.sqrt(k * torenbeek.reynolds) - turb(k * torenbeek.reynolds)) * k + turb(torenbeek.reynolds);
    expect(rel(torenbeek.cf, mixed)).toBeLessThan(1e-8);
    expect(torenbeek.cf).toBeLessThan(hoerner.cf);
    expect(result.warnings.some((text) => text.includes('< 0.2'))).toBe(true);
  });

  it('warns above Mach 0.8 and is pure', () => {
    const params = { components: [{ ...wing, formFactorModel: 'torenbeek' }], referenceAreaM2: 16, speed: 280, altitudeM: 11000 };
    const before = structuredClone(doc);
    const result = execute(doc, 'drag_buildup', params);
    expect(result.document).toBe(doc);
    expect(doc).toEqual(before);
    expect((result.data as Buildup).warnings.some((text) => text.includes('wave drag'))).toBe(true);
    expect(result.summary).toContain('CD0');
  });

  it.each([
    [{ components: [], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components'],
    [{ components: [wing], referenceAreaM2: 0, speed: 10 }, 'AER_PARAM_INVALID', 'referenceAreaM2'],
    [{ components: [wing], referenceAreaM2: 1, speed: 0 }, 'AER_PARAM_INVALID', 'speed'],
    [{ components: [wing], referenceAreaM2: 1, speed: 10, altitudeM: 0, densityKgM3: 1.2 }, 'AER_AIR_STATE_CONFLICT', 'altitudeM'],
    [{ components: [{ ...wing, wettedAreaM2: 0 }], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components.0'],
    [{ components: [{ ...wing, laminarFraction: 1 }], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components.0.laminarFraction'],
    [
      { components: [{ ...wing, interferenceFactor: 0.9 }], referenceAreaM2: 1, speed: 10 },
      'AER_PARAM_INVALID',
      'components.0.interferenceFactor',
    ],
    [
      { components: [{ ...wing, thicknessRatio: undefined }], referenceAreaM2: 1, speed: 10 },
      'AER_PARAM_INVALID',
      'components.0.thicknessRatio',
    ],
    [{ components: [{ ...wing, maxThicknessX: 1 }], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components.0.maxThicknessX'],
    [{ components: [{ ...wing, sweepDeg: 85 }], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components.0.sweepDeg'],
    [
      { components: [{ ...fuselage, formFactorModel: 'raymer' }], referenceAreaM2: 1, speed: 10 },
      'AER_PARAM_INVALID',
      'components.0.formFactorModel',
    ],
    [{ components: [{ ...fuselage, finenessRatio: 1 }], referenceAreaM2: 1, speed: 10 }, 'AER_PARAM_INVALID', 'components.0.finenessRatio'],
  ])('%j -> %s', (params, code, path) => {
    expectRefusal(doc, 'drag_buildup', params, code, path);
  });
});
