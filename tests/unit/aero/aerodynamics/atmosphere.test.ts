import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import table from '../../../../docs/aerospace/10-aerodynamics/validation/data/us1976_pdas_table.json';
import { data, expectRefusal } from '../sheetmetal/helpers';

interface Atmosphere {
  temperatureK: number;
  pressurePa: number;
  densityKgM3: number;
  speedOfSoundMS: number;
  dynamicViscosityPaS: number;
  altitude: { geometricM: number; geopotentialM: number; layer: number };
  ratios: { density: number };
  flow?: { mach: number; dynamicPressurePa: number; reynolds: number; equivalentAirspeedMS: number };
}

const doc = createEmptyDocument();
const close = (actual: number, expected: number, rel: number): void =>
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(rel);

describe('standard_atmosphere (VC-AER-01: U.S. Standard Atmosphere 1976, PDAS table)', () => {
  it.each(table.rows)('$geometricAltitudeM m matches the published table to its 5 printed digits', (row) => {
    const state = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: row.geometricAltitudeM });
    expect(Math.abs(state.temperatureK - row.temperatureK)).toBeLessThan(table.acceptance.temperatureK_abs);
    close(state.pressurePa, row.pressurePa, table.acceptance.other_rel);
    close(state.densityKgM3, row.densityKgM3, table.acceptance.other_rel);
    close(state.speedOfSoundMS, row.speedOfSoundMS, table.acceptance.other_rel);
    close(state.dynamicViscosityPaS, row.dynamicViscosityPaS, table.acceptance.other_rel);
  });

  it('converts feet and km, geopotential input and the layer index', () => {
    const feet = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: 36089.24, altitudeUnit: 'ft', altitudeType: 'geopotential' });
    expect(feet.altitude.geopotentialM).toBeCloseTo(11000, 1);
    expect(feet.temperatureK).toBeCloseTo(216.65, 3);
    expect(feet.altitude.layer).toBe(1);
    const km = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: 20, altitudeUnit: 'km', altitudeType: 'geopotential' });
    expect(km.pressurePa).toBeCloseTo(5474.89, 1);
  });

  it('flow quantities: Mach, q, EAS and Reynolds at sea level', () => {
    const state = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: 0, speed: 100, referenceLengthM: 2 });
    expect(state.flow?.mach).toBeCloseTo(100 / 340.294, 5);
    expect(state.flow?.dynamicPressurePa).toBeCloseTo(0.5 * 1.225 * 1e4, 2);
    expect(state.flow?.equivalentAirspeedMS).toBeCloseTo(100, 4);
    expect(state.flow?.reynolds).toBeCloseTo((1.225 * 100 * 2) / 1.7894e-5, -3);
    const knots = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: 0, speed: 100, speedUnit: 'kn' });
    expect(knots.flow?.dynamicPressurePa).toBeCloseTo(0.5 * 1.225 * (100 * 0.514444) ** 2, 0);
  });

  it('ISA+15 keeps the pressure and lowers the density', () => {
    const hot = data<Atmosphere>(doc, 'standard_atmosphere', { altitude: 0, temperatureOffsetK: 15 });
    expect(hot.pressurePa).toBeCloseTo(101325, 3);
    expect(hot.temperatureK).toBeCloseTo(303.15, 6);
    expect(hot.ratios.density).toBeCloseTo(288.15 / 303.15, 5);
  });

  it('refuses out-of-range and invalid inputs with stable codes', () => {
    expectRefusal(doc, 'standard_atmosphere', { altitude: 90000 }, 'AER_ALTITUDE_OUT_OF_RANGE', 'altitude');
    expectRefusal(doc, 'standard_atmosphere', { altitude: -6, altitudeUnit: 'km' }, 'AER_ALTITUDE_OUT_OF_RANGE');
    expectRefusal(doc, 'standard_atmosphere', { altitude: 0, temperatureOffsetK: -250 }, 'AER_PARAM_INVALID', 'temperatureOffsetK');
    expectRefusal(doc, 'standard_atmosphere', { altitude: 0, referenceLengthM: 0 }, 'AER_PARAM_INVALID', 'referenceLengthM');
    expectRefusal(doc, 'standard_atmosphere', { altitude: 0, speed: -1 }, 'AER_PARAM_INVALID', 'speed');
  });
});
