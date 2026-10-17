/** PHY-03 TR-THM-04: thermal unit conversions into the 05 unit systems (TECHNICAL_SPEC 5.3), 1e-12 round trip. */
import { describe, expect, it } from 'vitest';
import { fromSi, siToSystem, siUnitOf, systemToSi, toSi, UNIT_SYSTEMS, type ThermalKind } from '@lib/thermalUnits';

const SIGMA = 5.670374419e-8;

describe('thermal units', () => {
  it('matches the SI -> N-mm-t-s factors of the table', () => {
    const factors: Array<[ThermalKind, number]> = [
      ['conductivity', 1],
      ['specificHeat', 1e6],
      ['density', 1e-12],
      ['film', 1e-3],
      ['flux', 1e-3],
      ['generation', 1e-6],
      ['power', 1e3],
      ['stefanBoltzmann', 1e-3],
      ['temperature', 1],
      ['ratio', 1],
    ];
    for (const [kind, factor] of factors) expect(siToSystem(kind, 1, 'N-mm-t-s') / factor, kind).toBeCloseTo(1, 12);
    expect(siToSystem('stefanBoltzmann', SIGMA, 'N-mm-t-s')).toBeCloseTo(5.670374419e-11, 20);
  });

  it('is the identity in N-m-kg-s and consistent in lbf-in-slinch-s', () => {
    expect(siToSystem('flux', 123.5, 'N-m-kg-s')).toBe(123.5);
    const slinch = 4.4482216152605 / 0.0254;
    expect(siToSystem('density', 1, 'lbf-in-slinch-s')).toBeCloseTo(0.0254 ** 3 / slinch, 20);
    expect(siToSystem('length', 1, 'lbf-in-slinch-s')).toBeCloseTo(1 / 0.0254, 10);
    expect(siToSystem('conductivity', 1, 'lbf-in-slinch-s')).toBeCloseTo(1 / (0.0254 * slinch), 12);
  });

  it('round-trips every kind in every system to 1e-12', () => {
    const kinds: ThermalKind[] = [
      'length',
      'conductivity',
      'specificHeat',
      'density',
      'film',
      'flux',
      'generation',
      'power',
      'stefanBoltzmann',
      'diffusivity',
      'time',
      'latentHeat',
      'resistance',
      'inverseLength',
      'temperature',
      'temperatureDifference',
      'ratio',
    ];
    for (const system of UNIT_SYSTEMS) {
      for (const kind of kinds) {
        const there = siToSystem(kind, 3.7e-3, system);
        expect(Math.abs(systemToSi(kind, there, system) - 3.7e-3) / 3.7e-3, `${kind} ${system}`).toBeLessThan(1e-12);
      }
    }
  });

  it('converts quantities to SI and back, dimension-checked', () => {
    expect(toSi('conductivity', { value: 0.052, unit: 'W/(mm*K)' })).toEqual({ ok: true, value: 52 });
    const kelvin = toSi('temperature', { value: 20, unit: 'degC' });
    expect(kelvin).toEqual({ ok: true, value: 293.15 });
    expect(fromSi('temperature', 293.15, 'degF')).toBeCloseTo(68, 10);
    expect(fromSi('length', 1, 'furlong')).toBeNaN();
    expect(siUnitOf('film')).toBe('W/(m^2*K)');
    expect(toSi('film', { value: 1, unit: 'W/m^2' })).toMatchObject({ ok: false });
    expect(toSi('temperatureDifference', { value: 5, unit: 'K' })).toEqual({ ok: true, value: 5 });
    const interval = toSi('temperatureDifference', { value: 5, unit: 'degC' });
    expect(interval).toMatchObject({ ok: false });
    expect(toSi('temperatureDifference', { value: 5, unit: 'fathom' })).toMatchObject({ ok: false });
  });
});
