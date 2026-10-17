/** VC-MATL-01 / 02 converged values: N = 100 000 increments per segment (800 000 per run), driven directly because the command caps a path at 100 000 increments. */
import { describe, it } from 'vitest';
import { expectCase } from '../benchmarkCases';
import { runMaterialPoint } from '@core/model/materialLaws/driver';
import { selectSlots } from '@core/commands/materiallab/setSelection';
import { PACK, NL1_PATH, nl1Document } from './materialFixtures';

const pyFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));
const doc = nl1Document();

describe('NL1 converged (VC-MATL-01, 02)', () => {
  it.each([
    ['VC-MATL-01', 'perfect', 'perfect'],
    ['VC-MATL-02', 'isotropicH62500', 'iso_hardening'],
  ] as const)(
    '%s %s at N = 100000',
    (vc, label, set) => {
      const material = doc.materials['nl1_steel'];
      const selection = material === undefined ? undefined : selectSlots(material, 'nl1_steel', set, undefined);
      if (selection === undefined || 'code' in selection) throw new Error('no slots');
      const steps = NL1_PATH.map(([xx, yy]) => ({
        duration: null,
        temperatureK: null,
        increments: 100_000,
        control: { xx: { strain: xx * 1e-4 }, yy: { strain: yy * 1e-4 } },
      }));
      const outcome = runMaterialPoint({
        record: { name: 'nl1_steel' },
        slots: selection.slots,
        kinematics: 'small',
        preset: 'plane_strain',
        steps,
        output: 'steps',
        maxIncrements: 1_000_000,
      });
      if ('code' in outcome) throw new Error(outcome.message);
      const rows = outcome.rows;
      NL1_PATH.forEach(([xx, yy], i) => {
        expectCase(PACK, `${vc}/${label}/point${i + 1}(${pyFloat(xx)},${pyFloat(yy)})e-4/converged`, rows[i]?.vonMises ?? Number.NaN);
      });
    },
    120_000,
  );
});
