/**
 * 13 FLT M2 validation through the command layer on MuJoCo: run_flight / flight_report with the cascaded controller in the loop
 * (docs/aerospace/13-flight-dynamics/validation/README.md VC-FLT-02, 06, 07, 09, 14) and the refusals of a run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { getPhysicsEngine, setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import type { FlightCheck } from '@dynamics/flight/flightVerdict';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { expectNoOp } from '../../helpers/expectNoOp';
import { airframe, flightData, G, quadDrone, rotorParams, step } from './flightFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const rel = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);

interface Report {
  verdict: string;
  checks: FlightCheck[];
  limitsDefaulted: string[];
  hover: { totalShaftPowerW: number; totalIdealPowerW: number; figureOfMerit: number | null };
  metrics: FlightMetrics;
  timestepCheck?: { values: number[]; gci: { status: string; gci21Fine?: number; p?: number } };
}

/** The reference drone with the default controller (maxRpm 7000) and body drag, plus scenario `scenario`. */
function drone(scenario: Record<string, unknown>, controller: Record<string, unknown> = {}): CadDocument {
  let doc = step(quadDrone(), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc', ...controller }).doc;
  doc = step(doc, 'set_body_drag', { body: 'frame', cdaM2: [0.02, 0.02, 0.05] }).doc;
  return step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', ...scenario }).doc;
}

const metricsOf = (doc: CadDocument, params: Record<string, unknown> = {}): FlightMetrics =>
  flightData(doc, 'run_flight', { scenario: 's', ...params }) as unknown as FlightMetrics;
const reportOf = (doc: CadDocument, params: Record<string, unknown> = {}): Report =>
  flightData(doc, 'flight_report', { scenario: 's', ...params }) as unknown as Report;

const GUST = { durationS: 6, wind: { gusts: [{ startS: 1, durationS: 1, peak: [3, 0, 0] }] } };

describe('13 FLT closed loop (FLT-M2)', () => {
  it('VC-FLT-09: the 1.115 kg quad hovers at 4082.5 rpm, 2.7336 N and 19.012 W per rotor, 76.05 W shaft / 51.31 W ideal in total', () => {
    // knocked at t = 0 (drift + tumble): the controller has to bring it back to the hover it then holds
    const doc = drone({ durationS: 8, initialVelocity: [0.3, 0, -0.2], initialAngularVelocity: [0.3, -0.2, 0.1] });
    const metrics = metricsOf(doc);
    for (const rotor of Object.values(metrics.rotors)) {
      expect(rel(rotor.finalRpm, 4082.5)).toBeLessThan(1e-3);
      expect(rel(rotor.finalThrustN, 2.7336)).toBeLessThan(1e-3);
      expect(rel(rotor.finalShaftPowerW, 19.012)).toBeLessThan(1e-3);
    }
    expect(rel(metrics.power.finalShaftPowerW, 76.05)).toBeLessThan(1e-3);
    expect(metrics.tracking.finalPositionErrorM).toBeLessThan(0.02);
    expect(Math.hypot(metrics.attitude.final.rollDeg, metrics.attitude.final.pitchDeg)).toBeLessThan(0.05);
    expect(Math.abs(metrics.attitude.final.yawDeg)).toBeLessThan(0.5);
    expect(metrics.attitude.maxTiltDeg).toBeGreaterThan(1);
    const report = reportOf(doc);
    expect(rel(report.hover.totalIdealPowerW, 51.31)).toBeLessThan(1e-3);
    expect(rel(report.hover.figureOfMerit ?? 0, 51.31 / 76.05)).toBeLessThan(1e-3);
    expect(report.verdict).toBe('PASS');
    expect(report.metrics.control?.thrustToWeight).toBeCloseTo((4 * 1.6402e-7 * 7000 ** 2) / (1.115 * G), 3);
  });

  it('without the controller the same vehicle does not hover (the closed loop is what holds it)', () => {
    let doc = step(quadDrone(), 'set_body_drag', { body: 'frame', cdaM2: [0.02, 0.02, 0.05] }).doc;
    doc = step(doc, 'define_flight_scenario', { body: 'frame', durationS: 2, id: 's' }).doc;
    const metrics = metricsOf(doc);
    expect(metrics.control).toBeNull();
    expect(metrics.tracking.finalPositionErrorM).toBeGreaterThan(10);
    const report = reportOf(doc);
    expect(report.checks.find((entry) => entry.name === 'thrust_margin')?.status).toBe('not_applicable');
    expect(report.checks.find((entry) => entry.name === 'final_position_error_m')?.status).toBe('not_applicable');
  });

  it('tracks a climb + translation step and a heading change, and reports the recovery of the event', () => {
    const doc = drone({ durationS: 8, setpoints: [{ t: 0 }, { t: 1, position: [1, 0.5, 1], yawDeg: 30 }] });
    const metrics = metricsOf(doc, { detail: 'series' });
    expect(metrics.tracking.finalPositionErrorM).toBeLessThan(0.02);
    expect(Math.abs(metrics.tracking.finalYawErrorDeg)).toBeLessThan(0.5);
    expect(metrics.attitude.final.yawDeg).toBeCloseTo(30, 0);
    expect(metrics.events).toHaveLength(1);
    expect(metrics.events[0]?.peakErrorM).toBeCloseTo(1.5, 3);
    expect(metrics.recoveryTimeS).toBeGreaterThan(0.5);
    expect(metrics.recoveryTimeS).toBeLessThan(5);
    expect(metrics.attitude.maxTiltDeg).toBeLessThanOrEqual(35 + 1);
    const series = (metrics as unknown as { series: { times: number[]; positionM: number[][]; rotors: Record<string, { rpm: number[] }> } })
      .series;
    expect(series.times).toHaveLength(metrics.samples);
    expect(series.positionM.at(-1)?.[2]).toBeCloseTo(1, 1);
    expect(Object.keys(series.rotors)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('VC-FLT-07: a 3 m/s 1-cosine gust gives max attitude, recovery time, saturation fraction and a verdict, replayed bit-identically', () => {
    const doc = drone(GUST);
    const report = reportOf(doc);
    const { metrics } = report;
    for (const value of [metrics.attitude.maxTiltDeg, metrics.control?.saturationFraction ?? NaN, metrics.recoveryTimeS ?? NaN])
      expect(Number.isFinite(value)).toBe(true);
    expect(['PASS', 'MARGINAL', 'FAIL']).toContain(report.verdict);
    expect(report.checks.map((entry) => entry.name)).toEqual([
      'thrust_margin',
      'saturation_fraction',
      'max_attitude_deg',
      'final_position_error_m',
      'recovery_time_s',
      'battery_final_soc',
    ]);
    expect(metrics.events).toEqual([expect.objectContaining({ kind: 'gust', timeS: 1 })]);
    // the gust disturbs the hover: calm air keeps it level
    const calm = metricsOf(drone({ durationS: 6 }));
    expect(metrics.attitude.maxTiltDeg).toBeGreaterThan(0.2);
    expect(metrics.attitude.maxTiltDeg).toBeGreaterThan(100 * calm.attitude.maxTiltDeg);
    expect(metrics.tracking.maxPositionErrorM).toBeGreaterThan(0.01);
    // FR-FLT-16: the same document and scenario give the same bits
    expect(JSON.stringify(reportOf(doc))).toBe(JSON.stringify(report));
    expect(JSON.stringify(flightData(doc, 'run_flight', { scenario: 's', detail: 'series' }))).toBe(
      JSON.stringify(flightData(doc, 'run_flight', { scenario: 's', detail: 'series' })),
    );
  });

  it('VC-FLT-07 oracle: in a steady 3 m/s wind the hover tilts by atan(½ρ·CdA·v² / m g), against the wind', () => {
    // drag 0.5 · 1.225 · 0.02 · 3² = 0.11025 N against the weight 1.115 · 9.80665 N: 0.5777°; the body-z drag term of the tilted body and the
    // rotor inflow it sees (J ≈ 0.002, static coefficients) change it by < 0.1 %; 20 s lets the position integrator settle the drift
    const expected = (Math.atan2(0.5 * 1.225 * 0.02 * 3 ** 2, 1.115 * G) * 180) / Math.PI;
    const east = metricsOf(drone({ durationS: 20, wind: { steady: [3, 0, 0] } })).attitude.final;
    expect(rel(-east.pitchDeg, expected)).toBeLessThan(1e-3);
    expect(Math.abs(east.rollDeg)).toBeLessThan(1e-3 * expected);
    const north = metricsOf(drone({ durationS: 20, wind: { steady: [0, 3, 0] } })).attitude.final;
    expect(rel(north.rollDeg, expected)).toBeLessThan(1e-3);
    expect(Math.abs(north.pitchDeg)).toBeLessThan(1e-3 * expected);
  });

  it('anti-windup: a yaw channel saturated on almost every update holds only the yaw-rate integrator, so the drift in a steady wind is trimmed out', () => {
    // the geometric quad-X mixer with its yaw column scaled ×1000: any yaw demand is cut to the remaining authority (λ < 1) every update
    const yawGain = 15.367 * 1000;
    const mixer = [
      [0.25, -1.3889, -1.3889, -yawGain],
      [0.25, 1.3889, 1.3889, -yawGain],
      [0.25, 1.3889, -1.3889, yawGain],
      [0.25, -1.3889, 1.3889, yawGain],
    ];
    const metrics = metricsOf(drone({ durationS: 15, wind: { steady: [5, 0, 0] } }, { mixer }));
    expect(metrics.control?.saturationFraction).toBeGreaterThan(0.9);
    // velocity P alone would leave drag / (m · Kp_v · Kp_p) = 0.14 m of drift and the frozen vertical integrator a metre of sag
    expect(Math.hypot(metrics.tracking.finalOffsetM[0], metrics.tracking.finalOffsetM[1])).toBeLessThan(0.02);
    expect(metrics.tracking.finalPositionErrorM).toBeLessThan(0.05);
    expect(Math.abs(metrics.tracking.finalYawErrorDeg)).toBeLessThan(1);
  });

  it('flight_report reads recovery on the same samples as run_flight at a given sampleRate', () => {
    const doc = drone({ durationS: 6, setpoints: [{ t: 0 }, { t: 1, position: [1, 0, 0] }] });
    for (const sampleRate of [20, 200]) {
      const run = metricsOf(doc, { sampleRate });
      const report = reportOf(doc, { sampleRate });
      expect(report.metrics.recoveryTimeS).toBe(run.recoveryTimeS);
      expect(report.metrics.samples).toBe(run.samples);
    }
    expect(metricsOf(doc, { sampleRate: 20 }).recoveryTimeS).not.toBe(metricsOf(doc, { sampleRate: 200 }).recoveryTimeS);
  });

  it('VC-FLT-14: halving the timestep twice changes the gust max attitude by a GCI below 1 %', () => {
    const report = reportOf(drone(GUST), { timestepCheck: true });
    const check = report.timestepCheck;
    expect(check?.values).toHaveLength(3);
    expect(check?.gci.status).toBe('monotone');
    expect(check?.gci.gci21Fine).toBeLessThan(0.01);
  });

  it('VC-FLT-06: a static APC 10x4.7 rotor at 6528 rpm reports 7.8404 N, 88.570 W, ideal 62.308 W and figure of merit 0.7035', () => {
    const thrust = 0.1299 * 1.225 * (6528 / 60) ** 2 * 0.254 ** 4;
    let doc = airframe(thrust / G, [0.01, 0.01, 0.01], [0, 0, -G]);
    doc = step(doc, 'add_rotor', rotorParams({ rpm: 6528, thrustCoefficient: 0.1299, powerCoefficient: 0.0531, id: 'apc' })).doc;
    doc = step(doc, 'define_flight_scenario', { body: 'frame', durationS: 0.5, id: 's' }).doc;
    const report = reportOf(doc);
    const rotor = report.metrics.rotors['apc'];
    expect(rel(rotor?.finalThrustN ?? 0, 7.8404)).toBeLessThan(5e-3);
    expect(rel(rotor?.finalShaftPowerW ?? 0, 88.57)).toBeLessThan(5e-3);
    expect(rel(rotor?.idealPowerW ?? 0, 62.308)).toBeLessThan(5e-3);
    expect(rel(rotor?.figureOfMerit ?? 0, 0.7035)).toBeLessThan(5e-3);
    expect(rel(report.hover.figureOfMerit ?? 0, 0.7035)).toBeLessThan(5e-3);
  });

  it('VC-FLT-02: a torque-free body keeps |H| within 1e-6 over 10 s; spin about the intermediate axis flips, the other two hold', () => {
    const inertia = [0.01, 0.02, 0.03] as const;
    const spin = 2 * Math.PI;
    const results = [0, 1, 2].map((axis) => {
      const omega = [1e-3, 1e-3, 1e-3].map((small, i) => (i === axis ? spin : small));
      let doc = airframe(1, inertia, [0, 0, 0]);
      doc = step(doc, 'define_flight_scenario', { body: 'frame', durationS: 10, id: 's', initialAngularVelocity: omega }).doc;
      const data = flightData(doc, 'run_flight', { scenario: 's', detail: 'series', timestep: 0.0005, sampleRate: 100 }) as {
        series: { bodyRateDegS: number[][] };
      };
      const rates = data.series.bodyRateDegS.map((rate) => rate.map((value) => (value * Math.PI) / 180));
      const momentum = rates.map((w) => Math.hypot(...w.map((value, i) => (inertia[i] ?? 0) * value)));
      const h0 = momentum[0] ?? 0;
      return {
        drift: Math.max(...momentum.map((h) => Math.abs(h - h0) / h0)),
        minAlong: Math.min(...rates.map((w) => (w[axis] ?? 0) / spin)),
      };
    });
    for (const result of results) expect(result.drift).toBeLessThan(1e-6);
    expect(results[0]?.minAlong).toBeGreaterThan(0.99);
    expect(results[2]?.minAlong).toBeGreaterThan(0.99);
    expect(results[1]?.minAlong).toBeLessThan(-0.9);
  });

  it('kernel-optional: with the Manifold kernel (exact mass properties) the hover is the same as on the mesh path', async () => {
    const kernel = await createManifoldKernel();
    const doc = drone({ durationS: 2 });
    const exact = execute(doc, 'run_flight', { scenario: 's' }, { ...defaultContext(), kernel });
    const mesh = metricsOf(doc);
    const data = exact.data as FlightMetrics;
    expect(data.vehicle.massKg).toBe(mesh.vehicle.massKg);
    expect(rel(data.rotors['r1']?.finalRpm ?? 0, mesh.rotors['r1']?.finalRpm ?? 1)).toBeLessThan(1e-6);
    expect(exact.provenance).toBeDefined();
  });

  it('starts a free body with the scenario initial velocity (port initialTwist): x = v t in zero gravity', () => {
    let doc = airframe(1, [0.01, 0.01, 0.01], [0, 0, 0]);
    doc = step(doc, 'define_flight_scenario', { body: 'frame', durationS: 1, id: 's', initialVelocity: [2, -1, 0.5] }).doc;
    const metrics = metricsOf(doc);
    expect(metrics.tracking.finalOffsetM[0]).toBeCloseTo(2, 9);
    expect(metrics.tracking.finalOffsetM[1]).toBeCloseTo(-1, 9);
    expect(metrics.tracking.finalOffsetM[2]).toBeCloseTo(0.5, 9);
  });

  it('a vehicle with too little thrust saturates and fails the thrust-margin and saturation checks', () => {
    const doc = drone({ durationS: 4, setpoints: [{ t: 0 }, { t: 0.5, position: [0, 0, 2] }] }, { maxRpm: 4400 });
    const report = reportOf(doc, { limits: { maxRecoveryTimeS: 10 } });
    expect(report.metrics.control?.thrustMargin).toBeLessThan(0.3);
    expect(report.metrics.control?.saturationFraction).toBeGreaterThan(0.05);
    expect(report.checks.find((entry) => entry.name === 'thrust_margin')?.status).toBe('FAIL');
    expect(report.checks.find((entry) => entry.name === 'saturation_fraction')?.status).toBe('FAIL');
    expect(report.verdict).toBe('FAIL');
    expect(report.limitsDefaulted).not.toContain('maxRecoveryTimeS');
    expect(report.limitsDefaulted).toContain('minThrustMargin');
  });

  it('a mixer with the roll sign inverted diverges: run_flight refuses FLT_DIVERGED, flight_report fails it', () => {
    const geometric = [
      [0.25, -1.3889, -1.3889, -15.367],
      [0.25, 1.3889, 1.3889, -15.367],
      [0.25, 1.3889, -1.3889, 15.367],
      [0.25, -1.3889, 1.3889, 15.367],
    ];
    const inverted = geometric.map(([t, x, y, z]) => [t, -(x ?? 0), y, z]);
    const doc = drone({ durationS: 3, initialAngularVelocity: [0.2, 0, 0] }, { mixer: inverted });
    const refused = execute(doc, 'run_flight', { scenario: 's' });
    expectNoOp(refused, doc, 'FLT_DIVERGED');
    expect(refused.error?.detail?.['divergedAtS']).toBeGreaterThan(0);
    const report = reportOf(doc);
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.at(-1)).toMatchObject({ name: 'diverged', status: 'FAIL' });
  });

  it('refuses a run without engine, an unknown scenario, a timestep off the controller period, too many steps and a jointed body', () => {
    const doc = drone({ durationS: 2 });
    const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
    expect(code(execute(doc, 'run_flight', { scenario: 'ghost' }))).toBe('FLT_SCENARIO_UNKNOWN');
    expect(code(execute(doc, 'flight_report', { scenario: 'ghost' }))).toBe('FLT_SCENARIO_UNKNOWN');
    expect(code(execute(doc, 'run_flight', { scenario: 's', timestep: 0.0003 }))).toBe('FLT_CONTROL_RATE');
    expect(code(execute(doc, 'flight_report', { scenario: 's', timestep: 0.0003 }))).toBe('FLT_CONTROL_RATE');
    const long = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', durationS: 600, id: 'long' }).doc;
    expect(code(execute(long, 'run_flight', { scenario: 'long' }))).toBe('FLT_RUN_TOO_LONG');
    // 200 s: 400 000 steps at 0.5 ms pass, the 1 600 000 of the timestep check at 0.125 ms do not (refused before anything is flown)
    const mid = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', durationS: 200, id: 'mid' }).doc;
    expect(code(execute(mid, 'flight_report', { scenario: 'mid', timestepCheck: true }))).toBe('FLT_RUN_TOO_LONG');
    // 50 s: each run fits (100 000 / 200 000 / 400 000 steps) but together they fly 700 000
    const sum = step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', durationS: 50, id: 'sum' }).doc;
    const summed = execute(sum, 'flight_report', { scenario: 'sum', timestepCheck: true });
    expect(summed.error?.code).toBe('FLT_RUN_TOO_LONG');
    expect(summed.summary).toContain('700000 physics steps in total');
    const pivot = step(doc, 'add_body_joint', {
      kind: 'revolute',
      parent: 'ground',
      child: 'frame',
      anchor: [0, 0, 0],
      axis: [0, 0, 1],
    }).doc;
    expect(code(execute(pivot, 'run_flight', { scenario: 's' }))).toBe('FLT_BODY_NOT_FREE');
    const engine = getPhysicsEngine();
    setPhysicsEngine(null);
    try {
      const refused = execute(doc, 'run_flight', { scenario: 's' });
      expectNoOp(refused, doc, 'FLT_NO_ENGINE');
    } finally {
      setPhysicsEngine(engine);
    }
  });
});
