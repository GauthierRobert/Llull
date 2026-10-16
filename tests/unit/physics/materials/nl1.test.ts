/** VC-MATL-01 / 02 (NAFEMS NL1 plane-strain J2): increments N = 10 and 1000, first yield, modulus kind. */
import { describe, it } from 'vitest';
import { expectCase } from '../benchmarkCases';
import { PACK, NL1_HARDENING, NL1_PATH, NL1_VALIDITY, addModel, defineSet, nl1Document, nl1Steps, pointResponse } from './materialFixtures';

const pyFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
const pointId = (vc: string, label: string, index: number): string => {
  const [xx, yy] = NL1_PATH[index] ?? [0, 0];
  return `${vc}/${label}/point${index + 1}(${pyFloat(xx)},${pyFloat(yy)})e-4`;
};

const doc = nl1Document();
const run = (set: string, increments: number): number[] =>
  pointResponse(doc, { material: 'nl1_steel', set, kinematics: 'small', preset: 'plane_strain', steps: nl1Steps(increments) }).rows.map(
    (row) => row.vonMises,
  );

describe('NL1 material point (VC-MATL-01, 02)', () => {
  it('reproduces the reference integrator at N = 10 and N = 1000 increments per segment', () => {
    for (const [vc, label, set] of [
      ['VC-MATL-01', 'perfect', 'perfect'],
      ['VC-MATL-02', 'isotropicH62500', 'iso_hardening'],
    ] as const) {
      const n10 = run(set, 10);
      const n1000 = run(set, 1000);
      NL1_PATH.forEach((_, i) => {
        expectCase(PACK, `${pointId(vc, label, i)}/N10`, n10[i] ?? Number.NaN);
        expectCase(PACK, `${pointId(vc, label, i)}/N1000`, n1000[i] ?? Number.NaN);
      });
    }
  });

  it('first yield at exx = 0.25e-4 gives 5 MPa (VC-MATL-01/firstYield)', () => {
    const data = pointResponse(doc, {
      material: 'nl1_steel',
      set: 'perfect',
      kinematics: 'small',
      preset: 'plane_strain',
      steps: [{ increments: 1, control: { xx: { strain: 0.25e-4 }, yy: { strain: 0 } } }],
    });
    expectCase(PACK, 'VC-MATL-01/firstYield', data.rows[0]?.vonMises ?? Number.NaN);
  });

  it('shows that the modulus kind matters: 62.5 GPa read as a tangent modulus (VC-MATL-02/hardeningKindMatters)', () => {
    let tangent = addModel(
      nl1Document(),
      'nl1_steel',
      'iso_tangent',
      { ...NL1_HARDENING, isotropic: { ...NL1_HARDENING.isotropic, modulusKind: 'tangent' } },
      { validity: NL1_VALIDITY },
    );
    tangent = defineSet(tangent, 'nl1_steel', { id: 'tangent', elastic: 'elastic', plastic: 'iso_tangent' });
    const rows = pointResponse(tangent, {
      material: 'nl1_steel',
      set: 'tangent',
      kinematics: 'small',
      preset: 'plane_strain',
      steps: nl1Steps(1000),
    }).rows;
    expectCase(PACK, 'VC-MATL-02/hardeningKindMatters/point2', rows[1]?.vonMises ?? Number.NaN);
  });
});
