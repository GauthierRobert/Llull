/** VC-MATL-18: millisecond budgets (TECHNICAL_SPEC §8), asserted with a generous margin for loaded CI machines. */
import { describe, expect, it } from 'vitest';
import { druckerScan } from '@core/model/materialLaws/drucker';
import { resolveHyper, type HyperLaw } from '@core/model/materialLaws/hyperResolve';
import { MPa, nl1Document, nl1Steps, pointResponse, run } from './materialFixtures';

const time = (work: () => void): number => {
  work();
  const start = performance.now();
  work();
  return performance.now() - start;
};

describe('budgets (VC-MATL-18)', () => {
  const doc = nl1Document();
  const budgetFactor = 10;

  it('drives 8 steps x 1000 increments of closed-form J2 within the budget', () => {
    const elapsed = time(() =>
      pointResponse(doc, {
        material: 'nl1_steel',
        set: 'iso_hardening',
        kinematics: 'small',
        preset: 'plane_strain',
        steps: nl1Steps(1000),
      }),
    );
    expect(elapsed).toBeLessThan(50 * budgetFactor);
  });

  it('scans Drucker stability and writes cards within the budget', () => {
    const law = resolveHyper({ kind: 'hyper_mooney_rivlin', C10: MPa(0.2), C01: MPa(0.01), D1: { value: 0, unit: '1/MPa' } } as HyperLaw);
    if (law === null) throw new Error('unresolved');
    expect(time(() => druckerScan(law))).toBeLessThan(20 * budgetFactor);
    expect(time(() => run(doc, 'export_material_cards', { material: 'nl1_steel', target: 'calculix' }))).toBeLessThan(5 * budgetFactor);
  });

  it('drives Chaboche with three back stresses (local Newton) within the budget', () => {
    const chaboche = run(doc, 'add_material_model', {
      material: 'nl1_steel',
      id: 'chaboche',
      basis: 'unspecified',
      source: { citation: 'x' },
      model: {
        kind: 'j2_plasticity',
        isotropic: { kind: 'perfect', yieldStress: MPa(5) },
        kinematic: {
          kind: 'chaboche',
          backstresses: [
            { C: MPa(20000), gamma: 100 },
            { C: MPa(5000), gamma: 20 },
            { C: MPa(1000), gamma: 5 },
          ],
        },
      },
    }).document;
    const withSet = run(chaboche, 'define_constitutive_set', {
      material: 'nl1_steel',
      set: { id: 'chaboche', elastic: 'elastic', plastic: 'chaboche' },
    }).document;
    const elapsed = time(() =>
      pointResponse(withSet, {
        material: 'nl1_steel',
        set: 'chaboche',
        kinematics: 'small',
        preset: 'plane_strain',
        steps: nl1Steps(1000),
      }),
    );
    expect(elapsed).toBeLessThan(200 * budgetFactor);
  });
});
