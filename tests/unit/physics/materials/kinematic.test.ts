/** VC-MATL-05: Armstrong-Frederick and Prager kinematic hardening through the driver (combined hardening, Chaboche terms). */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { GPa, MPa, ONE, PACK, addModel, defineSet, pointResponse, withMaterial, type PointRow } from './materialFixtures';

const ELASTIC = { kind: 'elastic_isotropic', E: GPa(200), nu: ONE(0.3) };
const E = 200000;

function document(plastic: Record<string, unknown>): ReturnType<typeof createEmptyDocument> {
  let doc = withMaterial(createEmptyDocument(), 'steel');
  doc = addModel(doc, 'steel', 'elastic', ELASTIC);
  doc = addModel(doc, 'steel', 'plastic', plastic);
  return defineSet(doc, 'steel', { id: 's', elastic: 'elastic', plastic: 'plastic' }, true);
}

const uniaxial = (doc: ReturnType<typeof document>, steps: Record<string, unknown>[]): PointRow[] =>
  pointResponse(doc, { material: 'steel', kinematics: 'small', preset: 'uniaxial_stress', output: 'increments', steps }).rows;

/** Stress at which the equivalent plastic strain reaches `target` (linear between increments). */
function stressAtPlasticStrain(rows: readonly PointRow[], target: number): number {
  const index = rows.findIndex((row) => row.eqPlasticStrain >= target);
  const after = rows[index];
  const before = rows[index - 1];
  if (after === undefined || before === undefined) return Number.NaN;
  const w = (target - before.eqPlasticStrain) / (after.eqPlasticStrain - before.eqPlasticStrain);
  return (before.stress[0] ?? 0) + w * ((after.stress[0] ?? 0) - (before.stress[0] ?? 0));
}

describe('Armstrong-Frederick (VC-MATL-05)', () => {
  const doc = document({
    kind: 'j2_plasticity',
    isotropic: { kind: 'perfect', yieldStress: MPa(200) },
    kinematic: { kind: 'chaboche', backstresses: [{ C: MPa(20000), gamma: 100 }] },
  });

  it('follows σ = σy + (C/γ)(1 − exp(−γ εp)) in uniaxial stress', () => {
    const rows = uniaxial(doc, [{ increments: 3000, control: { xx: { strain: 0.0505 + 400 / E } } }]);
    for (const ep of [0.005, 0.01, 0.05]) expectCase(PACK, `VC-MATL-05/AF/monotonic/ep=${ep}`, stressAtPlasticStrain(rows, ep));
  });

  it('saturates at σy + C/γ', () => {
    const rows = uniaxial(doc, [{ increments: 2000, control: { xx: { strain: 0.5 } } }]);
    expectCase(PACK, 'VC-MATL-05/AF/saturation', rows[rows.length - 1]?.stress[0] ?? Number.NaN);
    expect(rows[rows.length - 1]?.backStress[0]).toBeCloseTo((2 / 3) * 200, 6);
  });

  it('two equal back-stress terms behave as one term of the summed modulus', () => {
    const two = document({
      kind: 'j2_plasticity',
      isotropic: { kind: 'perfect', yieldStress: MPa(200) },
      kinematic: {
        kind: 'chaboche',
        backstresses: [
          { C: MPa(10000), gamma: 100 },
          { C: MPa(10000), gamma: 100 },
        ],
      },
    });
    const rows = uniaxial(two, [{ increments: 2000, control: { xx: { strain: 0.5 } } }]);
    const one = uniaxial(doc, [{ increments: 2000, control: { xx: { strain: 0.5 } } }]);
    expect(rows[rows.length - 1]?.stress[0]).toBeCloseTo(one[one.length - 1]?.stress[0] ?? Number.NaN, 6);
  });
});

describe('Prager linear kinematic hardening (VC-MATL-05)', () => {
  const doc = document({
    kind: 'j2_plasticity',
    isotropic: { kind: 'perfect', yieldStress: MPa(200) },
    kinematic: { kind: 'linear', C: MPa(10000) },
  });

  it('translates the elastic range 2σy: reverse yield at σmax − 2σy', () => {
    const peakStrain = 0.01 + 300 / E;
    const rows = uniaxial(doc, [
      { increments: 200, control: { xx: { strain: peakStrain } } },
      { increments: 400, control: { xx: { strain: peakStrain - 400 / E } } },
    ]);
    const peak = rows[199];
    const reversed = rows[rows.length - 1];
    expect(peak?.stress[0]).toBeCloseTo(300, 6);
    expect(peak?.eqPlasticStrain).toBeCloseTo(0.01, 9);
    expectCase(PACK, 'VC-MATL-05/Prager/reverseYield', reversed?.stress[0] ?? Number.NaN);
    expect(reversed?.eqPlasticStrain).toBeCloseTo(0.01, 9);
  });

  it('keeps flowing in reverse with the kinematic modulus afterwards', () => {
    const peakStrain = 0.01 + 300 / E;
    const rows = uniaxial(doc, [
      { increments: 200, control: { xx: { strain: peakStrain } } },
      { increments: 400, control: { xx: { strain: peakStrain - 400 / E - 0.001 } } },
    ]);
    const last = rows[rows.length - 1];
    expect(last?.stress[0]).toBeCloseTo(-100 - ((E * 10000) / (E + 10000)) * 0.001, 6);
    expect(last?.eqPlasticStrain).toBeCloseTo(0.01 + (0.001 * E) / (E + 10000), 8);
  });
});

describe('combined hardening and rate laws in the driver', () => {
  it('adds isotropic expansion to the kinematic shift', () => {
    const doc = document({
      kind: 'j2_plasticity',
      isotropic: { kind: 'linear', yieldStress: MPa(200), modulus: MPa(5000), modulusKind: 'plastic' },
      kinematic: { kind: 'linear', C: MPa(10000) },
    });
    const rows = uniaxial(doc, [{ increments: 400, control: { xx: { strain: 0.0116 } } }]);
    const last = rows[rows.length - 1];
    const ep = last?.eqPlasticStrain ?? 0;
    expect(last?.stress[0]).toBeCloseTo(200 + 5000 * ep + 10000 * ep, 6);
  });

  it('applies Johnson-Cook hardening with a rate factor and Cowper-Symonds', () => {
    let doc = withMaterial(createEmptyDocument(), 'jc');
    doc = addModel(doc, 'jc', 'elastic', ELASTIC);
    doc = addModel(doc, 'jc', 'plastic', {
      kind: 'j2_plasticity',
      isotropic: {
        kind: 'johnson_cook',
        A: MPa(500),
        B: MPa(300),
        n: 0.3,
        m: 1,
        meltTemperature: { value: 1800, unit: 'K' },
        transitionTemperature: { value: 293, unit: 'K' },
      },
      kinematic: { kind: 'none' },
    });
    doc = addModel(doc, 'jc', 'rate', { kind: 'rate_johnson_cook', C: 0.015, referenceRate: { value: 1, unit: '1/s' } });
    doc = defineSet(doc, 'jc', { id: 's', elastic: 'elastic', plastic: 'plastic', rate: 'rate' }, true);
    const run = (duration: number): PointRow[] =>
      pointResponse(doc, {
        material: 'jc',
        kinematics: 'small',
        preset: 'uniaxial_stress',
        steps: [
          {
            increments: 400,
            duration: { value: duration, unit: 's' },
            temperature: { value: 293, unit: 'K' },
            control: { xx: { strain: 0.1 } },
          },
        ],
      }).rows;
    const slow = run(100)[0];
    const fast = run(0.01)[0];
    expect(fast?.stress[0]).toBeGreaterThan((slow?.stress[0] ?? 0) * 1.02);
    let cs = withMaterial(createEmptyDocument(), 'cs');
    cs = addModel(cs, 'cs', 'elastic', ELASTIC);
    cs = addModel(cs, 'cs', 'plastic', {
      kind: 'j2_plasticity',
      isotropic: { kind: 'perfect', yieldStress: MPa(200) },
      kinematic: { kind: 'none' },
    });
    cs = addModel(cs, 'cs', 'rate', { kind: 'rate_cowper_symonds', D: { value: 40, unit: '1/s' }, q: 5 });
    cs = defineSet(cs, 'cs', { id: 's', elastic: 'elastic', plastic: 'plastic', rate: 'rate' }, true);
    const quick = pointResponse(cs, {
      material: 'cs',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [{ increments: 200, duration: { value: 0.001, unit: 's' }, control: { xx: { strain: 0.02 } } }],
    });
    expect(quick.rows[0]?.stress[0]).toBeGreaterThan(200);
  });
});
