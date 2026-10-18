import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import table from '../../../../docs/aerospace/11-fluid-dynamics-propulsion/validation/data/compressible_naca1135.json';
import { data, expectRefusal } from '../../../helpers/commandAssertions';

interface Flow {
  result: Record<string, number>;
}

const doc = createEmptyDocument();
const ANGLES = new Set(['prandtlMeyerDeg', 'waveAngleDeg', 'maxDeflectionDeg', 'deflectionDeg', 'machAngleDeg']);

describe('compressible_flow (VC-FLD-01..05: NACA Report 1135 tables, γ 1.4)', () => {
  it.each(table.cases)('$id $relation', (row) => {
    const { expect: expected, rel } = row as typeof row & { rel?: number };
    const params = Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'expect', 'grade', 'rel'].includes(key)));
    const result = data<Flow>(doc, 'compressible_flow', params).result;
    for (const [key, value] of Object.entries(expected)) {
      const actual = result[key] as number;
      if (ANGLES.has(key)) expect(Math.abs(actual - value), key).toBeLessThan(table.acceptance.angleAbsDeg);
      else expect(Math.abs(actual - value) / value, key).toBeLessThan(rel ?? table.acceptance.rel);
    }
  });

  it('round trips the isentropic inverses (pressure, temperature, subsonic area ratio) and strong shocks', () => {
    const p = data<Flow>(doc, 'compressible_flow', { relation: 'isentropic', pressureRatio: 0.1278045 }).result;
    expect(p['mach']).toBeCloseTo(2, 5);
    const t = data<Flow>(doc, 'compressible_flow', { relation: 'isentropic', temperatureRatio: 5 / 9 }).result;
    expect(t['mach']).toBeCloseTo(2, 9);
    const sub = data<Flow>(doc, 'compressible_flow', { relation: 'isentropic', areaRatio: 1.3398, branch: 'subsonic' }).result;
    expect(sub['mach']).toBeCloseTo(0.5, 4);
    const strong = data<Flow>(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 2, deflectionDeg: 10, branch: 'strong' }).result;
    expect(strong['mach2'] as number).toBeLessThan(1);
    const byWave = data<Flow>(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 2, waveAngleDeg: 90 }).result;
    expect(byWave['pressureRatio']).toBeCloseTo(4.5, 9);
    const helium = data<Flow>(doc, 'compressible_flow', { relation: 'normal_shock', mach: 2, gamma: 5 / 3 }).result;
    expect(helium['pressureRatio']).toBeCloseTo(1 + ((2 * 5) / 3 / (8 / 3)) * 3, 9);
  });

  it('refuses invalid inputs with stable codes', () => {
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic' }, 'FLD_INPUT_CONFLICT');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', mach: 2, areaRatio: 2 }, 'FLD_INPUT_CONFLICT');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', mach: 2, gamma: 2.5 }, 'FLD_PARAM_INVALID', 'gamma');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', mach: -1 }, 'FLD_MACH_RANGE');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', areaRatio: 0.5 }, 'FLD_PARAM_INVALID', 'areaRatio');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', pressureRatio: 2 }, 'FLD_PARAM_INVALID', 'pressureRatio');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', temperatureRatio: 0 }, 'FLD_PARAM_INVALID', 'temperatureRatio');
    expectRefusal(doc, 'compressible_flow', { relation: 'isentropic', prandtlMeyerDeg: 140 }, 'FLD_PARAM_INVALID', 'prandtlMeyerDeg');
    expectRefusal(doc, 'compressible_flow', { relation: 'normal_shock', mach: 0.8 }, 'FLD_MACH_RANGE');
    expectRefusal(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 0.8, deflectionDeg: 5 }, 'FLD_MACH_RANGE');
    expectRefusal(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 2 }, 'FLD_INPUT_CONFLICT');
    expectRefusal(
      doc,
      'compressible_flow',
      { relation: 'oblique_shock', mach: 2, deflectionDeg: 30 },
      'FLD_SHOCK_DETACHED',
      'deflectionDeg',
    );
    expectRefusal(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 2, deflectionDeg: -3 }, 'FLD_PARAM_INVALID');
    expectRefusal(doc, 'compressible_flow', { relation: 'oblique_shock', mach: 2, waveAngleDeg: 10 }, 'FLD_PARAM_INVALID', 'waveAngleDeg');
    expectRefusal(doc, 'compressible_flow', { relation: 'fanno', mach: 0 }, 'FLD_MACH_RANGE');
  });
});
