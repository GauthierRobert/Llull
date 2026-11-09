/**
 * 13 FLT M3 through run_flight / flight_report on MuJoCo: the battery / ESC / motor chain integrated every physics step (current, state of charge,
 * voltage sag, cut-off, voltage-limited rotor speed, endurance) against closed forms (docs/aerospace/13-flight-dynamics/validation VC-FLT-11).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import type { FlightCheck } from '@dynamics/flight/flightVerdict';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { airframe, flightData, G, quadDrone, rotorParams, step } from './flightFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const MASS = 1.115;
const KT = 60 / (2 * Math.PI * 920);
const MOTOR = {
  nominalVoltageV: 14.8,
  terminalResistanceOhm: 0.1,
  torqueConstantNmPerA: KT,
  rotorInertiaKgM2: 1e-5,
  noLoadCurrentA: 0.5,
  peakCurrentA: 30,
};
const FLAT = [
  [0, 3.7],
  [1, 3.7],
];
const rel = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);

/** Reference quad + controller + battery + powertrain + scenario `s` (hover). */
function flyingQuad(battery: Record<string, unknown> = {}, scenario: Record<string, unknown> = {}): CadDocument {
  let doc = step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;
  doc = step(doc, 'add_battery', {
    id: 'pack',
    cellsSeries: 4,
    capacityMah: 5600,
    internalResistanceOhm: 0.04,
    source: 'test pack',
    ...battery,
  }).doc;
  doc = step(doc, 'add_flight_powertrain', {
    id: 'pt',
    battery: 'pack',
    rotors: ['r1', 'r2', 'r3', 'r4'],
    datasheet: MOTOR,
    motorSource: 'test motor',
    escEfficiency: 0.95,
  }).doc;
  return step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 4, ...scenario }).doc;
}

const run = (doc: CadDocument, params: Record<string, unknown> = {}): FlightMetrics =>
  flightData(doc, 'run_flight', { scenario: 's', timestep: 0.0025, ...params }) as unknown as FlightMetrics;
const hoverCurrent = (doc: CadDocument): number =>
  (execute(doc, 'estimate_endurance', { powertrain: 'pt', totalThrustN: MASS * G }).data as { bus: { currentA: number } }).bus.currentA;

describe('13 FLT power chain in the loop (FLT-M3)', () => {
  it('without a powertrain the run has no battery data and the report no battery check', () => {
    const doc = step(
      step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc,
      'define_flight_scenario',
      { body: 'frame', controller: 'fc', id: 's', durationS: 1 },
    ).doc;
    expect(run(doc).battery).toEqual({});
    const report = flightData(doc, 'flight_report', { scenario: 's', timestep: 0.0025 }) as { checks: FlightCheck[] };
    expect(report.checks.find((check) => check.name === 'battery_final_soc')?.status).toBe('not_applicable');
  });

  it('draws the hover current of the DC + ESC chain, integrates the charge and shows the sag', () => {
    const doc = flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3 });
    const metrics = run(doc);
    const pack = metrics.battery['pt'];
    const analytic = hoverCurrent(doc);
    expect(pack).toBeDefined();
    if (pack === undefined) return;
    expect(rel(pack.meanCurrentA, analytic)).toBeLessThan(0.02);
    expect(rel(pack.finalCurrentA, analytic)).toBeLessThan(0.01);
    // charge bookkeeping: mAh = A · s / 3.6 and SoC = 1 - Q / C
    expect(rel(pack.usedChargeMah, (pack.meanCurrentA * metrics.durationS) / 3.6)).toBeLessThan(2e-3);
    expect(rel(1 - pack.finalSoc, pack.usedChargeMah / 5600)).toBeLessThan(1e-9);
    // V = OCV - R · I (flat OCV 14.8 V, 0.04 ohm)
    expect(rel(pack.minVoltageV, 14.8 - 0.04 * pack.peakCurrentA)).toBeLessThan(1e-3);
    expect(rel(pack.energyWh * 3600, pack.meanCurrentA * metrics.durationS * ((pack.minVoltageV + 14.8) / 2))).toBeLessThan(0.02);
    expect(pack.cutoffAtS).toBeNull();
    expect(pack.peakThrottle).toBeGreaterThan(0.25);
    expect(pack.peakThrottle).toBeLessThan(0.45);
    expect(pack.motorPeakCurrentA).toBeLessThan(pack.motorCurrentLimitA);
    expect(metrics.defaulted.some((name) => name.startsWith('battery.') || name.startsWith('powertrain.'))).toBe(false);
    // the vehicle still hovers on the powered rotors (the pack does not limit hover)
    expect(rel(metrics.power.finalShaftPowerW, 76.05)).toBeLessThan(2e-3);
  });

  it('endurance of a run that did not reach the cut-off is capacity / current on an ideal pack', () => {
    const doc = flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3, internalResistanceOhm: 0 });
    const pack = run(doc).battery['pt'];
    expect(pack?.enduranceBasis).toBe('extrapolated_at_final_current');
    // remaining charge / current at the end of the run, plus the run time = whole capacity / current
    expect(rel(pack?.enduranceS ?? 0, (5600 * 3.6) / hoverCurrent(doc))).toBeLessThan(0.01);
  });

  it('a small pack reaches its cut-off at capacity / current, the motors stop, the report fails and the run warns FLT_BATTERY_CUTOFF', () => {
    const doc = flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3, internalResistanceOhm: 0, capacityMah: 10 }, { durationS: 8 });
    const metrics = run(doc);
    const pack = metrics.battery['pt'];
    const expected = (10 * 3.6) / hoverCurrent(doc);
    expect(pack?.cutoffAtS).not.toBeNull();
    expect(rel(pack?.cutoffAtS ?? 0, expected)).toBeLessThan(0.03);
    expect(pack?.enduranceBasis).toBe('cutoff_reached');
    expect(pack?.enduranceS).toBe(pack?.cutoffAtS);
    expect(pack?.finalSoc).toBe(0);
    expect(metrics.warnings.some((warning) => warning.startsWith('FLT_BATTERY_CUTOFF'))).toBe(true);
    // after the cut-off no rotor thrusts
    for (const rotor of Object.values(metrics.rotors)) expect(rotor.finalThrustN).toBe(0);
    const report = flightData(doc, 'flight_report', { scenario: 's', timestep: 0.0025 }) as { verdict: string; checks: FlightCheck[] };
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.find((check) => check.name === 'battery_cutoff')?.status).toBe('FAIL');
  });

  it('a sagging pack cuts off on voltage while it still holds charge', () => {
    const doc = flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3.25, internalResistanceOhm: 0.25 }, { durationS: 1 });
    const pack = run(doc).battery['pt'];
    // 14.8 V - 0.25 ohm · 7.7 A = 12.9 V < 13.0 V from the first step
    expect(pack?.cutoffAtS).toBeLessThan(0.05);
    expect(pack?.finalSoc).toBeGreaterThan(0.99);
  });

  it('flight_report judges the reserve: battery_final_soc passes at 100 % and fails below its limit, which is overridable', () => {
    const full = flightData(flyingQuad(), 'flight_report', { scenario: 's', timestep: 0.0025 }) as {
      checks: FlightCheck[];
      limitsDefaulted: string[];
    };
    expect(full.checks.find((check) => check.name === 'battery_final_soc')?.status).toBe('PASS');
    expect(full.limitsDefaulted).toContain('minFinalSoc');
    const low = flyingQuad({ initialSoc: 0.1 });
    const reserve = (limits: Record<string, unknown>): FlightCheck | undefined =>
      (flightData(low, 'flight_report', { scenario: 's', timestep: 0.0025, limits }) as { checks: FlightCheck[] }).checks.find(
        (check) => check.name === 'battery_final_soc',
      );
    expect(reserve({})?.status).toBe('FAIL');
    expect(reserve({ minFinalSoc: 0.05 })?.status).toBe('PASS');
  });

  it('limits the rotor speed to what the pack voltage sustains (one cell cannot hover) and warns', () => {
    // open loop: four rotors at the hover speed on a 1S flat 3.7 V pack
    let doc = airframe(MASS, [0.012, 0.012, 0.022], [0, 0, -G]);
    const hubs: [string, number, number, 'cw' | 'ccw'][] = [
      ['r1', 180, -180, 'ccw'],
      ['r2', -180, 180, 'ccw'],
      ['r3', 180, 180, 'cw'],
      ['r4', -180, -180, 'cw'],
    ];
    for (const [id, x, y, spin] of hubs)
      doc = step(
        doc,
        'add_rotor',
        rotorParams({ id, hub: [x, y, 0], spin, rpm: 4082.5, thrustCoefficient: 0.1158, powerCoefficient: 0.0466 }),
      ).doc;
    doc = step(doc, 'add_battery', {
      id: 'pack',
      cellsSeries: 1,
      capacityMah: 5000,
      internalResistanceOhm: 0,
      ocv: FLAT,
      cutoffVoltPerCell: 3,
      source: 't',
    }).doc;
    doc = step(doc, 'add_flight_powertrain', {
      id: 'pt',
      battery: 'pack',
      rotors: ['r1', 'r2', 'r3', 'r4'],
      datasheet: MOTOR,
      motorSource: 't',
      escEfficiency: 1,
    }).doc;
    doc = step(doc, 'define_flight_scenario', { body: 'frame', id: 's', durationS: 0.5 }).doc;
    const metrics = run(doc);
    // independent bisection of kt·w + R·(Q(w) / kt + I0) = 3.7 V, with Q = Cp rho n^2 D^5 / (2 pi)
    const voltage = (omega: number): number => {
      const n = omega / (2 * Math.PI);
      const torque = (0.0466 * 1.225 * n ** 2 * 0.254 ** 5) / (2 * Math.PI);
      return KT * omega + 0.1 * (torque / KT + 0.5);
    };
    let lo = 0;
    let hi = 1000;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (voltage(mid) > 3.7) hi = mid;
      else lo = mid;
    }
    const n = lo / (2 * Math.PI);
    const thrust = 0.1158 * 1.225 * n ** 2 * 0.254 ** 4;
    expect(thrust).toBeLessThan(2.7336 * 0.8);
    for (const rotor of Object.values(metrics.rotors)) expect(rel(rotor.finalThrustN, thrust)).toBeLessThan(0.01);
    expect(metrics.battery['pt']?.voltageLimitedFraction).toBeGreaterThan(0.9);
    // the cap uses the previous step's voltage: the throttle may exceed 1 only by the one-step lag
    expect(metrics.battery['pt']?.peakThrottle).toBeLessThanOrEqual(1.05);
    expect(metrics.warnings.some((warning) => warning.startsWith('FLT_PACK_VOLTAGE_LIMITED'))).toBe(true);
  });

  it('warns when a motor draws more than its peak current', () => {
    const doc = execute(flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3 }), 'delete_dynamics_item', { id: 'pt' }).document;
    const weak = step(doc, 'add_flight_powertrain', {
      id: 'pt',
      battery: 'pack',
      rotors: ['r1', 'r2', 'r3', 'r4'],
      datasheet: { ...MOTOR, peakCurrentA: 2 },
      motorSource: 't',
      escEfficiency: 0.95,
    }).doc;
    const metrics = run(weak, { scenario: 's' });
    expect(metrics.battery['pt']?.overCurrentFraction).toBeGreaterThan(0.9);
    expect(metrics.warnings.some((warning) => warning.startsWith('FLT_MOTOR_CURRENT_LIMIT'))).toBe(true);
  });

  it('prints the extrapolated endurance as an estimate and a reached cut-off plainly', () => {
    const summary = (doc: CadDocument): string => execute(doc, 'run_flight', { scenario: 's', timestep: 0.0025 }).summary;
    expect(summary(flyingQuad({}, { durationS: 1 }))).toMatch(/endurance ~[0-9.e+]+ s est. [(]extrapolated_at_final_current[)]/);
    const cut = summary(flyingQuad({ ocv: FLAT, cutoffVoltPerCell: 3, internalResistanceOhm: 0, capacityMah: 10 }, { durationS: 8 }));
    expect(cut).toMatch(/endurance [0-9.e+]+ s [(]cutoff_reached[)]/);
  });

  it('is deterministic and carries per-sample battery series', () => {
    const doc = flyingQuad({}, { durationS: 1 });
    const a = flightData(doc, 'run_flight', { scenario: 's', timestep: 0.0025, detail: 'series' }) as unknown as {
      series: { battery: { pt: { soc: number[]; voltageV: number[]; currentA: number[] } } };
    };
    const b = flightData(doc, 'run_flight', { scenario: 's', timestep: 0.0025, detail: 'series' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const series = a.series.battery.pt;
    expect(series.soc.length).toBe(series.currentA.length);
    expect(series.soc[0]).toBeGreaterThan(series.soc[series.soc.length - 1] ?? 1);
    expect(Math.max(...series.currentA)).toBeGreaterThan(5);
  });

  it('a powertrain over a missing battery in a hand-edited document is refused as FLT_MODEL_INVALID', () => {
    const doc = flyingQuad();
    const broken = { ...doc, flight: { ...doc.flight, batteries: {} } } as unknown as CadDocument;
    const result = execute(broken, 'run_flight', { scenario: 's' });
    expect(result.error?.code).toBe('FLT_MODEL_INVALID');
  });
});
