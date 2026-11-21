/**
 * 13 FLT M3b through the commands and MuJoCo: Peukert on add_battery, the ESC map and the motor thermal network on add_flight_powertrain,
 * the opt-in minimum-endurance limit of flight_report, load validation of the new fields; absent fields leave every result unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { flightDocument } from '@dynamics/flight/document';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import type { FlightCheck } from '@dynamics/flight/flightVerdict';
import { steadyWindingC, thermalParams, windingTemperatureSeries } from '@dynamics/sim/actuators/thermal';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { pow } from '@lib/pow';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { flightData, G, quadDrone, step } from './flightFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const MASS = 1.115;
const MOTOR = {
  nominalVoltageV: 14.8,
  terminalResistanceOhm: 0.1,
  torqueConstantNmPerA: 60 / (2 * Math.PI * 920),
  rotorInertiaKgM2: 1e-5,
  noLoadCurrentA: 0.5,
  peakCurrentA: 30,
};
const THERMAL = { rthWindingHousingKPerW: 5, rthHousingAmbientKPerW: 5, tauWindingS: 6, tauMotorS: 200, maxWindingC: 125 };
const FLAT = [
  [0, 3.7],
  [1, 3.7],
];

function quad(battery: Record<string, unknown> = {}, powertrain: Record<string, unknown> = {}, durationS = 4): CadDocument {
  let doc = step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;
  doc = step(doc, 'add_battery', {
    id: 'pack',
    cellsSeries: 4,
    capacityMah: 5600,
    internalResistanceOhm: 0.04,
    ocv: FLAT,
    cutoffVoltPerCell: 3,
    source: 't',
    ...battery,
  }).doc;
  doc = step(doc, 'add_flight_powertrain', {
    id: 'pt',
    battery: 'pack',
    rotors: ['r1', 'r2', 'r3', 'r4'],
    datasheet: MOTOR,
    motorSource: 'test motor',
    ...(powertrain['escEfficiencyMap'] === undefined ? { escEfficiency: 0.95 } : {}),
    ...powertrain,
  }).doc;
  return step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS }).doc;
}
const run = (doc: CadDocument, params: Record<string, unknown> = {}): FlightMetrics =>
  flightData(doc, 'run_flight', { scenario: 's', timestep: 0.0025, ...params }) as unknown as FlightMetrics;
const report = (
  doc: CadDocument,
  limits: Record<string, unknown> = {},
): { verdict: string; checks: FlightCheck[]; limits: Record<string, unknown>; limitsDefaulted: string[] } =>
  flightData(doc, 'flight_report', { scenario: 's', timestep: 0.0025, limits }) as never;
const pack = (metrics: FlightMetrics): NonNullable<FlightMetrics['battery'][string]> => {
  const entry = metrics.battery['pt'];
  if (entry === undefined) throw new Error('no pack');
  return entry;
};
const estimate = (doc: CadDocument): Record<string, unknown> & { summary: string } => {
  const result = execute(doc, 'estimate_endurance', { powertrain: 'pt', totalThrustN: MASS * G });
  return { ...(result.data as Record<string, unknown>), summary: result.summary };
};

describe('add_battery / add_flight_powertrain M3b fields', () => {
  it('stores the Peukert fields only when given and refuses an exponent without its rated time (FLT_PEUKERT_RATING_MISSING)', () => {
    expect(quad().flight?.batteries?.['pack']).not.toHaveProperty('peukertExponent');
    expect(quad({ peukertExponent: 1 }).flight?.batteries?.['pack']).toMatchObject({ peukertExponent: 1, defaulted: [] });
    const rated = quad({ peukertExponent: 1.2, peukertRatedHours: 20 });
    expect(rated.flight?.batteries?.['pack']).toMatchObject({ peukertRatedHours: 20, defaulted: [] });
    const base = quadDrone(MASS);
    const params = {
      cellsSeries: 4,
      capacityMah: 5600,
      internalResistanceOhm: 0.04,
      ocv: FLAT,
      source: 't',
      peukertExponent: 1.2,
      peukertRatedHours: 1,
    };
    expectPure(base, () => execute(base, 'add_battery', params));
    expect(execute(base, 'add_battery', params).summary).toContain('Peukert k 1.200 at I_rated 5.600 A (1.000 h rate)');
    expectNoOp(
      execute(base, 'add_battery', { ...params, peukertExponent: undefined, peukertRatedHours: 5 }),
      base,
      'needs peukertExponent',
    );
    expectNoOp(execute(base, 'add_battery', { ...params, peukertExponent: 3 }), base, 'invalid params');
    expectNoOp(execute(base, 'add_battery', { ...params, peukertRatedHours: undefined }), base, 'FLT_PEUKERT_RATING_MISSING');
  });

  it('stores an ESC map in place of the constant, refuses both or a malformed map, and flags a defaulted motor ambient', () => {
    const map = {
      throttle: [0, 1],
      currentA: [0, 30],
      efficiency: [
        [0.8, 0.9],
        [0.9, 0.97],
      ],
    };
    const doc = quad({}, { escEfficiencyMap: map });
    expect(doc.flight?.powertrains?.['pt']).toMatchObject({ escEfficiencyMap: map, defaulted: [] });
    expect(quad().flight?.powertrains?.['pt']).not.toHaveProperty('escEfficiencyMap');
    const base = step(quadDrone(MASS), 'add_battery', {
      id: 'pack',
      cellsSeries: 4,
      capacityMah: 5600,
      internalResistanceOhm: 0,
      source: 't',
    }).doc;
    const params = { battery: 'pack', rotors: ['r1'], datasheet: MOTOR, motorSource: 'm' };
    expectNoOp(execute(base, 'add_flight_powertrain', { ...params, escEfficiency: 0.9, escEfficiencyMap: map }), base, 'not both');
    const bad = execute(base, 'add_flight_powertrain', { ...params, escEfficiencyMap: { ...map, throttle: [1, 0] } });
    expectNoOp(bad, base, 'FLT_ESC_MAP_INVALID');
    expectNoOp(
      execute(base, 'add_flight_powertrain', { ...params, escEfficiencyMap: { ...map, currentA: [5, 5] } }),
      base,
      'currentA must strictly increase',
    );
    expectNoOp(
      execute(base, 'add_flight_powertrain', { ...params, escEfficiencyMap: { ...map, efficiency: [[0.9, 0.9], [0.9]] } }),
      base,
      'one value per currentA',
    );
    expectNoOp(
      execute(base, 'add_flight_powertrain', {
        ...params,
        escEfficiencyMap: {
          ...map,
          efficiency: [
            [0.9, 0.9],
            [0.9, 0.9],
            [0.9, 0.9],
          ],
        },
      }),
      base,
      'one row per throttle',
    );
    const hot = execute(base, 'add_flight_powertrain', { ...params, datasheet: { ...MOTOR, thermal: THERMAL } });
    expect(hot.document.flight?.powertrains?.[hot.affected[0] ?? '']?.defaulted).toEqual(['escEfficiency', 'motorAmbientC']);
    expect(hot.summary).toContain('winding thermal network (max 125.0 C) at ambient 25.00 C');
    expect(execute(base, 'add_flight_powertrain', { ...params, motorAmbientC: 40 }).summary).toContain('motorAmbientC ignored');
    expect(execute(base, 'add_flight_powertrain', { ...params, escEfficiencyMap: map }).summary).toContain('map 2x2 (0.8000 to 0.9700)');
  });

  it('load validation names a rated time without an exponent, a malformed map and out-of-range values', () => {
    const doc = quad(
      { peukertExponent: 1.1, peukertRatedHours: 5 },
      {
        escEfficiencyMap: {
          throttle: [0, 1],
          currentA: [0, 30],
          efficiency: [
            [0.8, 0.9],
            [0.9, 0.97],
          ],
        },
        motorAmbientC: 35,
      },
    );
    type Json = { flight: { batteries: Record<string, Record<string, unknown>>; powertrains: Record<string, Record<string, unknown>> } };
    const errors = (mutate: (copy: Json) => void): string => {
      const copy = JSON.parse(JSON.stringify(doc)) as Json;
      mutate(copy);
      return flightDocument.validate(copy as unknown as Record<string, unknown>).join('|');
    };
    expect(errors(() => undefined)).toBe('');
    const ratedOnly = (c: Json): void => {
      const stored = c.flight.batteries['pack']!;
      delete stored['peukertExponent'];
      stored['peukertRatedHours'] = 2;
    };
    expect(errors(ratedOnly)).toContain('only with peukertExponent');
    expect(errors((c) => delete c.flight.batteries['pack']!['peukertRatedHours'])).toContain('peukertExponent: needs peukertRatedHours');
    expect(errors((c) => (c.flight.batteries['pack']!['peukertExponent'] = 0.5))).toContain('peukertExponent');
    expect(errors((c) => ((c.flight.powertrains['pt']!['escEfficiencyMap'] as { throttle: number[] }).throttle = [1, 0]))).toContain(
      'throttle must strictly increase',
    );
    expect(
      errors((c) => ((c.flight.powertrains['pt']!['escEfficiencyMap'] as { efficiency: number[][] }).efficiency = [[0.9, 0.9]])),
    ).toContain('efficiency');
    expect(errors((c) => (c.flight.powertrains['pt']!['motorAmbientC'] = 900))).toContain('motorAmbientC');
  });
});

describe('the M3b laws in run_flight / flight_report / estimate_endurance', () => {
  it('Peukert on a flat pack: identical currents, the SoC drained faster by (I / I_rated)^(k - 1)', () => {
    const plain = pack(run(quad()));
    const peukert = pack(run(quad({ peukertExponent: 1.05, peukertRatedHours: 1 })));
    expect(peukert.usedChargeMah).toBe(plain.usedChargeMah);
    expect(peukert.meanCurrentA).toBe(plain.meanCurrentA);
    const ratio = (1 - peukert.finalSoc) / (1 - plain.finalSoc);
    expect(Math.abs(ratio - pow(plain.meanCurrentA / 5.6, 0.05))).toBeLessThan(1e-3);
    expect(peukert.enduranceS ?? 0).toBeLessThan(plain.enduranceS ?? 0);
  });

  it('an ESC map equal to the constant flies the same numbers; a lossy map draws the current estimate_endurance predicts', () => {
    const constant = pack(run(quad()));
    const flatMap = {
      throttle: [0, 1],
      currentA: [0, 30],
      efficiency: [
        [0.95, 0.95],
        [0.95, 0.95],
      ],
    };
    expect(pack(run(quad({}, { escEfficiencyMap: flatMap })))).toEqual(constant);
    const lossy = {
      throttle: [0, 0.5, 1],
      currentA: [0, 10, 30],
      efficiency: [
        [0.6, 0.7, 0.75],
        [0.8, 0.85, 0.9],
        [0.9, 0.95, 0.97],
      ],
    };
    const doc = quad({}, { escEfficiencyMap: lossy });
    const flown = pack(run(doc));
    const predicted = estimate(doc)['bus'] as { currentA: number };
    expect(flown.meanCurrentA).toBeGreaterThan(constant.meanCurrentA * 1.05);
    expect(Math.abs(flown.finalCurrentA - predicted.currentA) / predicted.currentA).toBeLessThan(0.01);
  });

  it('integrates the winding temperature of every motor from its copper loss; without thermal data nothing is added', () => {
    expect(pack(run(quad()))).not.toHaveProperty('motorThermal');
    const doc = quad({}, { datasheet: { ...MOTOR, thermal: THERMAL }, motorAmbientC: 30 });
    const metrics = run(doc, { detail: 'series' });
    const thermal = pack(metrics).motorThermal;
    expect(thermal).toMatchObject({ ambientC: 30, maxWindingC: 125, overLimitAtS: null, overLimitFraction: 0 });
    // hover: each motor carries about the estimate_endurance motor current; the network at that constant current
    const rows = estimate(doc)['rotors'] as { id: string; motorCurrentA: number }[];
    const network = thermalParams({ ...MOTOR, thermal: THERMAL }) ?? (null as never);
    const times = Array.from({ length: 1601 }, (_, k) => k * 0.0025);
    for (const motor of thermal?.motors ?? []) {
      const current = rows.find((row) => row.id === motor.rotorId)?.motorCurrentA ?? 0;
      const expected =
        windingTemperatureSeries(
          network,
          times,
          times.map(() => current),
          30,
        ).windingC.at(-1) ?? 0;
      expect(Math.abs(motor.finalWindingC - expected) / (expected - 30)).toBeLessThan(0.03);
      expect(motor.peakWindingC).toBeCloseTo(motor.finalWindingC, 9);
    }
    const series = (metrics as unknown as { series: { battery: { pt: { windingC: Record<string, number[]> } } } }).series.battery.pt;
    expect(series.windingC['r1']?.[0]).toBe(30);
    expect(series.windingC['r1']?.at(-1)).toBeCloseTo(thermal?.motors[0]?.finalWindingC ?? 0, 4);
    expect(report(doc).checks.find((check) => check.name === 'motor_winding_c')?.status).toBe('PASS');
    expect(report(quad()).checks.some((check) => check.name === 'motor_winding_c')).toBe(false);
  });

  it('a winding past maxWindingC warns FLT_MOTOR_OVERTEMP and fails flight_report; the motors cool after a cut-off', () => {
    const doc = quad({}, { datasheet: { ...MOTOR, thermal: { ...THERMAL, maxWindingC: 25.05 } } });
    const metrics = run(doc);
    expect(metrics.warnings.some((warning) => warning.startsWith('FLT_MOTOR_OVERTEMP'))).toBe(true);
    expect(pack(metrics).motorThermal?.overLimitAtS).toBeGreaterThan(0);
    const verdict = report(doc);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.checks.find((check) => check.name === 'motor_winding_c')).toMatchObject({ status: 'FAIL', limit: 25.05 });
    const cut = pack(
      run(quad({ capacityMah: 10, internalResistanceOhm: 0, cutoffVoltPerCell: 3 }, { datasheet: { ...MOTOR, thermal: THERMAL } }, 8)),
    );
    expect(cut.cutoffAtS).not.toBeNull();
    const motor = cut.motorThermal?.motors[0];
    expect(motor?.finalWindingC ?? 0).toBeLessThan(motor?.peakWindingC ?? 0);
  });

  it('estimate_endurance gives the steady winding temperature at the hover current and warns when it exceeds the limit', () => {
    const doc = quad({}, { datasheet: { ...MOTOR, thermal: THERMAL }, motorAmbientC: 30 });
    const data = estimate(doc);
    const network = thermalParams({ ...MOTOR, thermal: THERMAL }) ?? (null as never);
    const rows = data['rotors'] as { motorCurrentA: number }[];
    const thermal = data['motorThermal'] as { motors: { steadyWindingC: number }[]; continuousCurrentA: number };
    expect(thermal.motors[0]?.steadyWindingC).toBeCloseTo(steadyWindingC(network, rows[0]?.motorCurrentA ?? 0, 30) ?? 0, 9);
    expect(thermal.continuousCurrentA).toBeGreaterThan(rows[0]?.motorCurrentA ?? 0);
    expect(data.summary).not.toContain('FLT_MOTOR_OVERTEMP');
    expect(estimate(quad({}, { datasheet: { ...MOTOR, thermal: { ...THERMAL, maxWindingC: 26 } } })).summary).toContain(
      'FLT_MOTOR_OVERTEMP',
    );
    expect(estimate(quad())).not.toHaveProperty('motorThermal');
  });

  it('flight_report checks minEnduranceS only when given: FAIL with FLT_ENDURANCE_SHORT below, PASS above, n/a without a powertrain', () => {
    const doc = quad();
    const plain = report(doc);
    expect(plain.checks.some((check) => check.name === 'battery_endurance_s')).toBe(false);
    expect(plain.limits).not.toHaveProperty('minEnduranceS');
    const endurance = pack(run(doc)).enduranceS ?? 0;
    const short = report(doc, { minEnduranceS: endurance * 2 });
    const check = short.checks.find((entry) => entry.name === 'battery_endurance_s');
    expect(check).toMatchObject({ status: 'FAIL', comparison: '>=', limit: endurance * 2 });
    expect(check?.note).toContain('FLT_ENDURANCE_SHORT');
    expect(check?.note).toContain('ESTIMATE');
    expect(short.verdict).toBe('FAIL');
    expect(short.limitsDefaulted).toEqual(plain.limitsDefaulted);
    expect(report(doc, { minEnduranceS: endurance / 2 }).checks.find((entry) => entry.name === 'battery_endurance_s')?.status).toBe('PASS');
    expect(report(doc, { minEnduranceS: endurance * 0.95 }).checks.find((entry) => entry.name === 'battery_endurance_s')?.status).toBe(
      'MARGINAL',
    );
    const cut = quad({ capacityMah: 10, internalResistanceOhm: 0, cutoffVoltPerCell: 3 }, {}, 8);
    expect(report(cut, { minEnduranceS: 1 }).checks.find((entry) => entry.name === 'battery_endurance_s')?.note).toContain(
      'cut-off reached',
    );
    const unpowered = step(
      step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc,
      'define_flight_scenario',
      { body: 'frame', controller: 'fc', id: 's', durationS: 1 },
    ).doc;
    expect(report(unpowered, { minEnduranceS: 60 }).checks.find((entry) => entry.name === 'battery_endurance_s')).toMatchObject({
      status: 'not_applicable',
      value: null,
    });
  });
});
