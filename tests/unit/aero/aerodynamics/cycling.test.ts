import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import table from '../../../../docs/aerospace/10-aerodynamics/validation/data/bassett1999_table7.json';
import refs from '../../../../docs/aerospace/10-aerodynamics/validation/data/cycling_references.json';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface Cycling {
  speedMS: number;
  speedKmh: number;
  powerW: number;
  breakdown: { aeroW: number; rollingW: number; bearingW?: number; gravityW?: number };
  inputs: {
    crr?: { value: number; defaulted: boolean };
    cdA?: { value: number; source: string };
    frontalAreaM2?: number;
    k1?: { value: number };
  };
  warnings: string[];
}

const doc = createEmptyDocument();

describe('cycling_power bassett_1999 (VC-AER-20: Bassett et al. 1999 Table 7, hour records)', () => {
  it.each(table.rows)('$year $rider $distanceKm km reproduces the published power', (row) => {
    const result = data<Cycling>(doc, 'cycling_power', {
      model: 'bassett_1999',
      speed: row.distanceKm,
      speedUnit: 'km/h',
      riderHeightM: row.heightM,
      riderMassKg: row.massKg,
      k1: row.k1,
    });
    const target = 'modelPowerW' in row ? (row.modelPowerW as number) : row.powerW;
    expect(Math.abs(result.powerW - target)).toBeLessThan(table.acceptance.absW);
  });

  it('inverts power -> 1 h distance and builds K1 from the altitude density ratio (Mexico City Kd 0.794)', () => {
    const merckx = table.rows[2] as (typeof table.rows)[number];
    const inverse = data<Cycling>(doc, 'cycling_power', {
      model: 'bassett_1999',
      powerW: 366,
      riderHeightM: 1.84,
      riderMassKg: 75,
      k1: merckx.k1,
    });
    expect(inverse.speedKmh).toBeCloseTo(merckx.distanceKm, 1);
    const factors = data<Cycling>(doc, 'cycling_power', {
      model: 'bassett_1999',
      speed: 49.431,
      speedUnit: 'km/h',
      riderHeightM: 1.84,
      riderMassKg: 75,
      altitudeM: 2338,
      positionFactor: 1.08,
      bikeFactor: 1.07,
      clothingFactor: 1.02,
      helmetFactor: 1.04,
    });
    expect(factors.inputs.k1?.value).toBeCloseTo(0.794 * 1.08 * 1.07 * 1.02 * 1.04, 2);
    expect(Math.abs(factors.powerW - 366)).toBeLessThan(2);
  });
});

describe('cycling_power martin_1998 (VC-AER-21..23)', () => {
  const base = { massKg: 80, cdA: refs.defraeye2010.riderPlusBikeCdAM2.dropped, densityKgM3: 1.225 };

  it('closed form of every term (Martin 1998 constants Fw 0.0044, Crr 0.0032, E_c 0.976)', () => {
    const v = 40 / 3.6;
    const result = data<Cycling>(doc, 'cycling_power', { ...base, speed: 40, speedUnit: 'km/h' });
    const aero = 0.5 * 1.225 * (base.cdA + 0.0044) * v ** 3;
    const rolling = v * 0.0032 * 80 * 9.80665;
    const bearing = v * (91 + 8.7 * v) * 1e-3;
    expect(result.breakdown.aeroW).toBeCloseTo(aero, 3);
    expect(result.breakdown.rollingW).toBeCloseTo(rolling, 3);
    expect(result.breakdown.bearingW).toBeCloseTo(bearing, 3);
    expect(result.powerW).toBeCloseTo((aero + rolling + bearing) / 0.976, 2);
    expect(result.inputs.crr?.defaulted).toBe(true);
  });

  it('position ranking (Defraeye 2010): upright > dropped > time-trial power at 40 km/h; inverse speed round trip', () => {
    const at = (cdA: number): number => data<Cycling>(doc, 'cycling_power', { ...base, cdA, speed: 40, speedUnit: 'km/h' }).powerW;
    const { upright, dropped, timeTrial } = refs.defraeye2010.riderPlusBikeCdAM2;
    expect(at(upright)).toBeGreaterThan(at(dropped));
    expect(at(dropped)).toBeGreaterThan(at(timeTrial));
    const power = at(dropped);
    const back = data<Cycling>(doc, 'cycling_power', { ...base, powerW: power });
    expect(back.speedKmh).toBeCloseTo(40, 4);
  });

  it('grade, headwind, tailwind descent and altitude', () => {
    const climb = data<Cycling>(doc, 'cycling_power', { ...base, speed: 20, speedUnit: 'km/h', gradePercent: 5 });
    expect(climb.breakdown.gravityW).toBeCloseTo((20 / 3.6) * 80 * 9.80665 * Math.sin(Math.atan(0.05)), 3);
    const wind = data<Cycling>(doc, 'cycling_power', { ...base, speed: 30, speedUnit: 'km/h', headwindMS: 3 });
    const still = data<Cycling>(doc, 'cycling_power', { ...base, speed: 30, speedUnit: 'km/h' });
    expect(wind.powerW).toBeGreaterThan(still.powerW);
    const descent = data<Cycling>(doc, 'cycling_power', { ...base, powerW: 50, gradePercent: -6 });
    expect(descent.speedKmh).toBeGreaterThan(40);
    const coast = data<Cycling>(doc, 'cycling_power', { ...base, speed: 15, speedUnit: 'km/h', gradePercent: -8 });
    expect(coast.warnings.join(' ')).toContain('negative');
    const altitude = data<Cycling>(doc, 'cycling_power', {
      massKg: base.massKg,
      cdA: base.cdA,
      speed: 40,
      speedUnit: 'km/h',
      altitudeM: 2338,
    });
    expect(altitude.powerW).toBeLessThan(still.powerW * 2);
    expect(altitude.breakdown.aeroW).toBeLessThan(
      data<Cycling>(doc, 'cycling_power', { ...base, speed: 40, speedUnit: 'km/h' }).breakdown.aeroW,
    );
  });

  it('CdA from a model: cd x frontal area of solids (metres document)', () => {
    const metres = { ...doc, units: 'm' as const };
    const rider = ok(metres, 'add_box', { size: [1.6, 0.4, 1] });
    const result = data<Cycling>(rider.document, 'cycling_power', {
      massKg: 80,
      cd: 0.6,
      entityIds: rider.affected,
      speed: 10,
      densityKgM3: 1.2,
    });
    expect(result.inputs.cdA?.value).toBeCloseTo(0.6 * 0.4, 2);
    expect(result.inputs.cdA?.source).toContain('frontal area');
  });

  it('refuses missing or conflicting inputs', () => {
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25 }, 'AER_SPEED_SOURCE_CONFLICT');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25, speed: 10, powerW: 200 }, 'AER_SPEED_SOURCE_CONFLICT');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25, speed: 100 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'cycling_power', { cdA: 0.25, speed: 10 }, 'AER_PARAM_INVALID', 'massKg');
    expectRefusal(doc, 'cycling_power', { massKg: 80, speed: 10 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(doc, 'cycling_power', { massKg: 80, entityIds: ['a'], speed: 10 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cd: 0.5, entityIds: ['ghost'], speed: 10 }, 'AER_ENTITY_NOT_FOUND');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25, speed: 10, chainEfficiency: 1.5 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25, powerW: 100, gradePercent: -25, headwindMS: -10 }, 'AER_NO_EQUILIBRIUM');
    expectRefusal(doc, 'cycling_power', { massKg: 80, cdA: 0.25, speed: 10, altitudeM: 99999 }, 'AER_ALTITUDE_OUT_OF_RANGE');
    expectRefusal(doc, 'cycling_power', { model: 'bassett_1999', speed: 10, riderMassKg: 70 }, 'AER_PARAM_INVALID', 'riderHeightM');
    expectRefusal(
      doc,
      'cycling_power',
      { model: 'bassett_1999', speed: 10, riderMassKg: 70, riderHeightM: 1.8, k1: -1 },
      'AER_PARAM_INVALID',
    );
  });
});
