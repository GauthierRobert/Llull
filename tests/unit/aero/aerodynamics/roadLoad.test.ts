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

describe('road_load_power bassett_1999 (VC-AER-20: Bassett et al. 1999 Table 7, hour records)', () => {
  it.each(table.rows)('$year $rider $distanceKm km reproduces the published power', (row) => {
    const result = data<Cycling>(doc, 'road_load_power', {
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
    const inverse = data<Cycling>(doc, 'road_load_power', {
      model: 'bassett_1999',
      powerW: 366,
      riderHeightM: 1.84,
      riderMassKg: 75,
      k1: merckx.k1,
    });
    expect(inverse.speedKmh).toBeCloseTo(merckx.distanceKm, 1);
    const factors = data<Cycling>(doc, 'road_load_power', {
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

describe('road_load_power bicycle preset (VC-AER-21..23)', () => {
  const base = { vehicle: 'bicycle', massKg: 80, cdA: refs.defraeye2010.riderPlusBikeCdAM2.dropped, densityKgM3: 1.225 };

  it('closed form of every term (Martin 1998 constants Fw 0.0044, Crr 0.0032, E_c 0.976)', () => {
    const v = 40 / 3.6;
    const result = data<Cycling>(doc, 'road_load_power', { ...base, speed: 40, speedUnit: 'km/h' });
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
    const at = (cdA: number): number => data<Cycling>(doc, 'road_load_power', { ...base, cdA, speed: 40, speedUnit: 'km/h' }).powerW;
    const { upright, dropped, timeTrial } = refs.defraeye2010.riderPlusBikeCdAM2;
    expect(at(upright)).toBeGreaterThan(at(dropped));
    expect(at(dropped)).toBeGreaterThan(at(timeTrial));
    const power = at(dropped);
    const back = data<Cycling>(doc, 'road_load_power', { ...base, powerW: power });
    expect(back.speedKmh).toBeCloseTo(40, 4);
  });

  it('grade, headwind, tailwind descent and altitude', () => {
    const climb = data<Cycling>(doc, 'road_load_power', { ...base, speed: 20, speedUnit: 'km/h', gradePercent: 5 });
    expect(climb.breakdown.gravityW).toBeCloseTo((20 / 3.6) * 80 * 9.80665 * Math.sin(Math.atan(0.05)), 3);
    const wind = data<Cycling>(doc, 'road_load_power', { ...base, speed: 30, speedUnit: 'km/h', headwindMS: 3 });
    const still = data<Cycling>(doc, 'road_load_power', { ...base, speed: 30, speedUnit: 'km/h' });
    expect(wind.powerW).toBeGreaterThan(still.powerW);
    const descent = data<Cycling>(doc, 'road_load_power', { ...base, powerW: 50, gradePercent: -6 });
    expect(descent.speedKmh).toBeGreaterThan(40);
    const coast = data<Cycling>(doc, 'road_load_power', { ...base, speed: 15, speedUnit: 'km/h', gradePercent: -8 });
    expect(coast.warnings.join(' ')).toContain('negative');
    const altitude = data<Cycling>(doc, 'road_load_power', {
      vehicle: 'bicycle',
      massKg: base.massKg,
      cdA: base.cdA,
      speed: 40,
      speedUnit: 'km/h',
      altitudeM: 2338,
    });
    expect(altitude.powerW).toBeLessThan(still.powerW * 2);
    expect(altitude.breakdown.aeroW).toBeLessThan(
      data<Cycling>(doc, 'road_load_power', { ...base, speed: 40, speedUnit: 'km/h' }).breakdown.aeroW,
    );
  });

  it('CdA from a model: cd x frontal area of solids (metres document)', () => {
    const metres = { ...doc, units: 'm' as const };
    const rider = ok(metres, 'add_box', { size: [1.6, 0.4, 1] });
    const result = data<Cycling>(rider.document, 'road_load_power', {
      vehicle: 'bicycle',
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
    expectRefusal(doc, 'road_load_power', { vehicle: 'bicycle', massKg: 80, cdA: 0.25 }, 'AER_SPEED_SOURCE_CONFLICT');
    expectRefusal(
      doc,
      'road_load_power',
      { vehicle: 'bicycle', massKg: 80, cdA: 0.25, speed: 10, powerW: 200 },
      'AER_SPEED_SOURCE_CONFLICT',
    );
    expectRefusal(doc, 'road_load_power', { vehicle: 'bicycle', massKg: 80, cdA: 0.25, speed: 150 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'road_load_power', { vehicle: 'bicycle', cdA: 0.25, speed: 10 }, 'AER_PARAM_INVALID', 'massKg');
    expectRefusal(doc, 'road_load_power', { vehicle: 'bicycle', massKg: 80, speed: 10 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(doc, 'road_load_power', { vehicle: 'bicycle', massKg: 80, entityIds: ['a'], speed: 10 }, 'AER_AREA_SOURCE_CONFLICT');
    expectRefusal(
      doc,
      'road_load_power',
      { vehicle: 'bicycle', massKg: 80, cd: 0.5, entityIds: ['ghost'], speed: 10 },
      'AER_ENTITY_NOT_FOUND',
    );
    expectRefusal(
      doc,
      'road_load_power',
      { vehicle: 'bicycle', massKg: 80, cdA: 0.25, speed: 10, drivetrainEfficiency: 1.5 },
      'AER_PARAM_INVALID',
    );
    expectRefusal(
      doc,
      'road_load_power',
      { massKg: 40000, crr: 0.006, cdA: 6, powerW: 10, gradePercent: -25, headwindMS: -10 },
      'AER_NO_EQUILIBRIUM',
    );
    expectRefusal(
      doc,
      'road_load_power',
      { vehicle: 'bicycle', massKg: 80, cdA: 0.25, speed: 10, altitudeM: 99999 },
      'AER_ALTITUDE_OUT_OF_RANGE',
    );
    expectRefusal(doc, 'road_load_power', { model: 'bassett_1999', speed: 10, riderMassKg: 70 }, 'AER_PARAM_INVALID', 'riderHeightM');
    expectRefusal(
      doc,
      'road_load_power',
      { model: 'bassett_1999', speed: 10, riderMassKg: 70, riderHeightM: 1.8, k1: -1 },
      'AER_PARAM_INVALID',
    );
  });
});

describe('road_load_power generic vehicle', () => {
  it('car at 120 km/h: aero + rolling at the wheels, no bicycle terms, drivetrain 1 flagged as defaulted', () => {
    const v = 120 / 3.6;
    type Car = Cycling & {
      vehicle: string;
      inputs: { drivetrainEfficiency: { value: number; defaulted: boolean }; bearingLosses: boolean };
    };
    const car = data<Car>(doc, 'road_load_power', { massKg: 1500, cdA: 0.65, crr: 0.01, speed: 120, speedUnit: 'km/h', densityKgM3: 1.2 });
    expect(car.vehicle).toBe('generic');
    expect(car.breakdown.aeroW).toBeCloseTo(0.5 * 1.2 * 0.65 * v ** 3, 3);
    expect(car.breakdown.rollingW).toBeCloseTo(v * 0.01 * 1500 * 9.80665, 3);
    expect(car.breakdown.bearingW).toBe(0);
    expect(car.powerW).toBeCloseTo(car.breakdown.aeroW + car.breakdown.rollingW, 3);
    expect(car.inputs.drivetrainEfficiency).toEqual({ value: 1, defaulted: true });
    expect(car.inputs.bearingLosses).toBe(false);
    const motor = data<Car>(doc, 'road_load_power', {
      massKg: 1500,
      cdA: 0.65,
      crr: 0.01,
      speed: 120,
      speedUnit: 'km/h',
      densityKgM3: 1.2,
      drivetrainEfficiency: 0.9,
    });
    expect(motor.powerW).toBeCloseTo(car.powerW / 0.9, 3);
    const back = data<Car>(doc, 'road_load_power', { massKg: 1500, cdA: 0.65, crr: 0.01, powerW: car.powerW, densityKgM3: 1.2 });
    expect(back.speedKmh).toBeCloseTo(120, 4);
  });

  it('a generic vehicle needs crr (no unsourced default)', () => {
    expectRefusal(doc, 'road_load_power', { massKg: 1500, cdA: 0.65, speed: 30 }, 'AER_PARAM_INVALID', 'crr');
  });

  it('the bicycle preset equals the generic model with the Martin terms given explicitly', () => {
    const bike = data<Cycling>(doc, 'road_load_power', {
      vehicle: 'bicycle',
      massKg: 80,
      cdA: 0.25,
      speed: 40,
      speedUnit: 'km/h',
      densityKgM3: 1.225,
    });
    const explicit = data<Cycling>(doc, 'road_load_power', {
      massKg: 80,
      cdA: 0.25,
      crr: 0.0032,
      wheelAreaM2: 0.0044,
      bearingLosses: true,
      drivetrainEfficiency: 0.976,
      speed: 40,
      speedUnit: 'km/h',
      densityKgM3: 1.225,
    });
    expect(explicit.powerW).toBeCloseTo(bike.powerW, 9);
  });
});
