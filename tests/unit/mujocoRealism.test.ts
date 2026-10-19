/**
 * PHY-21 M3b realism on MuJoCo: gear mesh loss (VC-FPR-27, 16), motored inertia torque (VC-FPR-28), calibrated brake torque and friction
 * (VC-FPR-15, TR-FPR-15), timestep halving (VC-FPR-33), compare_to_reference with the Rotax reference set (VC-FPR-31, 34), free-equilibrium
 * runs against a propeller (VC-FPR-32 machinery), plausibility findings and the realism block of the engine report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { EngineData } from '@core/dynamics/engineReport';
import type { RealismData } from '@core/dynamics/engine/engineRealism';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { RATED_BRAKE_TORQUE_NM, RATED_RPM, calibratedEngine, step } from './engineRealismFixture';
import { sliderCrank, travelRate } from './sliderCrankFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const expectedCase = (id: string): { value: number | number[] } => {
  const file = fileURLToPath(new URL('../../docs/physics/21-functional-prototype/validation/expected_results.json', import.meta.url));
  const found = (JSON.parse(readFileSync(file, 'utf8')) as { cases: { id: string; value: number | number[] }[] }).cases.find(
    (entry) => entry.id === id,
  );
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

type Series = { times: number[]; jointPosition: Record<string, number[]>; motorTorque: Record<string, number[]> };
type RunData = {
  motors: Record<string, { torque: number }>;
  series?: Series;
  warnings: string[];
  engineReport?: EngineData & { realism?: RealismData };
};

function simulate(doc: CadDocument, params: Record<string, unknown>): RunData {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  expect(result.document).toBe(doc);
  return result.data as RunData;
}

describe('gear mesh efficiency (VC-FPR-27, 16)', () => {
  /** Crank driven by a constant 121 N·m through a 21/51 pinion pair; the propeller shaft is held at constant speed by a governor. */
  function gearTrain(efficiency: number | undefined): { doc: CadDocument; governor: string } {
    let doc = createEmptyDocument();
    const a = step(doc, 'add_cylinder', { radius: 80, height: 20, axis: [0, 0, 1], position: [0, 0, 0] });
    const b = step(a.doc, 'add_cylinder', { radius: 150, height: 15, axis: [0, 0, 1], position: [0, 300, 0] });
    doc = step(b.doc, 'add_rigid_body', { entityIds: [a.id], massKg: 2, id: 'crank' }).doc;
    doc = step(doc, 'add_rigid_body', { entityIds: [b.id], massKg: 2, id: 'prop' }).doc;
    doc = step(doc, 'add_body_joint', {
      kind: 'revolute',
      child: 'crank',
      anchor: [0, 0, 0],
      axis: [0, 0, 1],
      id: 'crank_j',
      initialRpm: 5800,
    }).doc;
    doc = step(doc, 'add_body_joint', { kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1], id: 'prop_j' }).doc;
    doc = step(doc, 'add_gear_coupling', {
      driver: 'crank_j',
      driven: 'prop_j',
      teeth: [21, 51],
      ...(efficiency === undefined ? {} : { efficiency }),
    }).doc;
    doc = step(doc, 'add_motor', { joint: 'crank_j', kind: 'torque_curve', torque: 121 }).doc;
    const governor = step(doc, 'add_motor', { joint: 'prop_j', kind: 'speed', rpm: (5800 * 21) / 51, maxTorque: 1e6 });
    return { doc: governor.doc, governor: governor.id };
  }

  it('121 N·m on the crank through 51/21 at efficiency 0.99 gives 290.92 N·m on the propeller shaft within 0.1 % (VC-FPR-27)', () => {
    const { doc, governor } = gearTrain(0.99);
    const data = simulate(doc, { duration: 0.5, timestep: 0.0002 });
    const expected = expectedCase('VC-FPR-27').value as number;
    expect(expected).toBeCloseTo(290.918571429, 6);
    expect(Math.abs(Math.abs(data.motors[governor]?.torque ?? 0) - expected) / expected).toBeLessThan(1e-3);
  });

  it('an ideal gear (no efficiency given) transmits the full 121 · 51/21 = 293.86 N·m; the loss is exactly 1 % at 0.99', () => {
    const ideal = gearTrain(undefined);
    const lossy = gearTrain(0.99);
    const idealTorque = Math.abs(simulate(ideal.doc, { duration: 0.5, timestep: 0.0002 }).motors[ideal.governor]?.torque ?? 0);
    const lossyTorque = Math.abs(simulate(lossy.doc, { duration: 0.5, timestep: 0.0002 }).motors[lossy.governor]?.torque ?? 0);
    expect(idealTorque).toBeCloseTo((121 * 51) / 21, 2);
    expect(lossyTorque / idealTorque).toBeCloseTo(0.99, 5);
  });

  it('the loss does not change the ratio: the propeller shaft still turns at 2388.24 rpm for a crank at 5800 rpm (VC-FPR-16)', () => {
    const { doc } = gearTrain(0.99);
    const data = simulate(doc, { duration: 0.1, timestep: 0.0002 }) as RunData & { joints: Record<string, { finalRpm: number }> };
    const expected = expectedCase('VC-FPR-16').value as number;
    expect(Math.abs((data.joints['prop_j']?.finalRpm ?? 0) - expected) / expected).toBeLessThan(1e-3);
  });
});

describe('motored inertia torque (VC-FPR-28)', () => {
  it("a 0.40 kg piston at 5800 rpm needs the governor torque m w² x' x'' at 30..150 deg, within 1 %", () => {
    const { doc, r, l } = sliderCrank({
      rMm: 30.5,
      lMm: 130,
      crankRpm: 5800,
      pistonKg: 0.4,
      rodKg: 0.001,
      startDeg: 0,
      crankInertia: 0.05,
    });
    const weightless = execute(doc, 'set_gravity', { gravity: [0, 0, 0] }).document;
    // the soft loop constraint adds about 1 % of inertia at the default time constant: 16 steps puts it well under the gate
    const stiff = execute(weightless, 'set_dynamics_solver', { loopTimeConstantSteps: 16 }).document;
    const motor = step(stiff, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: 5800, maxTorque: 1e6 });
    const data = simulate(motor.doc, { duration: 0.0125, sampleRate: 34800, detail: 'series' });
    const theta = data.series?.jointPosition['crank_j'] ?? [];
    const torque = data.series?.motorTorque[motor.id] ?? [];
    const omega = (5800 * 2 * Math.PI) / 60;
    const expected = expectedCase('VC-FPR-28').value as number[];
    [30, 60, 90, 120, 150].forEach((deg, k) => {
      const target = (deg * Math.PI) / 180;
      const i = theta.findIndex((value) => value >= target);
      const [a, b] = [theta[i - 1] ?? 0, theta[i] ?? 0];
      const fraction = (target - a) / (b - a);
      const measured = (torque[i - 1] ?? 0) * (1 - fraction) + (torque[i] ?? 0) * fraction;
      const h = 1e-5;
      const second = (travelRate(r, l, target + h) - travelRate(r, l, target - h)) / (2 * h);
      const analytic = 0.4 * omega * omega * travelRate(r, l, target) * second;
      expect(Math.abs(analytic - (expected[k] ?? 0)) / Math.abs(expected[k] ?? 1)).toBeLessThan(1e-6);
      expect(Math.abs(measured - (expected[k] ?? 0)) / Math.abs(expected[k] ?? 1)).toBeLessThan(0.01);
    });
  });
});

describe('calibrated brake torque and friction on the run (VC-FPR-15, TR-FPR-15)', () => {
  const { doc } = calibratedEngine();
  const governed = (rpm: number): CadDocument => step(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm, maxTorque: 1e6 }).doc;
  let data: RunData;
  let realism: RealismData | undefined;
  beforeAll(() => {
    data = simulate(governed(RATED_RPM), { duration: 0.07, reactions: 'peaks' });
    realism = data.engineReport?.realism;
  });

  it('the simulated mean brake torque meets the calibration target within 0.5 %, tagged calibrated (VC-FPR-15)', () => {
    const brakePerCylinder = realism?.losses?.brakeTorqueNm ?? 0;
    const engine = brakePerCylinder * 4;
    const expected = expectedCase('VC-FPR-15b').value as number;
    expect(Math.abs(engine - expected) / expected).toBeLessThan(0.005);
    expect(expected).toBeCloseTo(RATED_BRAKE_TORQUE_NM, 6);
    expect(realism?.accuracy['brakeTorqueNm']).toMatchObject({ origin: 'calibrated', validationLevel: 1 });
    expect(realism?.losses?.bmepBar).toBeCloseTo(expectedCase('VC-FPR-15a').value as number, 1);
  });

  it('IMEP = BMEP + FMEP, and the friction torque cycle average is FMEP · V_d / (4 pi) (TR-FPR-15)', () => {
    const losses = realism?.losses;
    if (losses === undefined || losses === null) throw new Error('no losses block');
    expect(losses.imepBar).toBeCloseTo(losses.bmepBar + losses.fmepBar, 9);
    expect(losses.frictionTorqueNm).toBeCloseTo((losses.fmepBar * 1e5 * losses.displacementCm3 * 1e-6) / (4 * Math.PI), 9);
    expect(losses.brakeTorqueNm).toBeCloseTo(losses.indicatedTorqueNm - losses.frictionTorqueNm, 9);
    expect(losses.mechanicalEfficiency).toBeCloseTo(losses.bmepBar / losses.imepBar, 9);
    expect(losses.peakPressureBar).toBeGreaterThan(30);
    expect(losses.outsideValidatedRange).toBe(false);
  });

  it('the governor torque averaged over the last cycle equals minus the brake torque (independent cross-check of the friction torque)', () => {
    const cross = realism?.losses?.governorCrossCheck;
    expect(cross).not.toBeNull();
    expect(cross?.relativeDifference ?? 1).toBeLessThan(0.01);
    expect(cross?.governorMeanTorqueNm ?? 0).toBeLessThan(0);
  });

  it('states an accuracy for every scalar of the report (VC-FPR-34): origin set, a missing band is null, calibrated values are labelled', () => {
    const entries = realism?.accuracy ?? {};
    for (const key of [
      'meanTorqueNm',
      'indicatedPowerKW',
      'imepBar',
      'fmepBar',
      'frictionTorqueNm',
      'brakeTorqueNm',
      'brakePowerKW',
      'bmepBar',
      'mechanicalEfficiency',
      'speedRipple',
      'energyClosure',
      'peakReactionForces',
    ]) {
      const entry = entries[key];
      expect(entry, key).toBeDefined();
      expect(['input', 'calibrated', 'predicted', 'verification']).toContain(entry?.origin);
      expect(entry?.basis.length).toBeGreaterThan(10);
    }
    expect(entries['speedRipple']?.band).toBeNull();
    expect(entries['peakReactionForces']?.band).toBeNull();
    expect(entries['fmepBar']?.band).toEqual({ rel: 0.13 });
    expect(entries['energyClosure']?.origin).toBe('verification');
    // the brake band combines the 0.1 % calibration with the 13 % friction band on the friction share only
    const brake = entries['brakeTorqueNm']?.band;
    const losses = realism?.losses;
    if (brake === null || brake === undefined || !('rel' in brake) || losses === undefined || losses === null)
      throw new Error('no brake band');
    const expected = Math.hypot(0.001 * losses.indicatedTorqueNm, 0.13 * losses.frictionTorqueNm) / losses.brakeTorqueNm;
    expect(brake.rel).toBeCloseTo(expected, 9);
  });

  it('reports the reciprocating mass and the inertia against the gas load per cylinder (FR-FPR-73)', () => {
    const [cylinder] = realism?.reciprocating ?? [];
    expect(cylinder?.reciprocatingMassKg).toBeCloseTo(0.4 + 0.4 / 3, 9);
    const omega = (RATED_RPM * 2 * Math.PI) / 60;
    expect(cylinder?.primaryForceN).toBeCloseTo((0.4 + 0.4 / 3) * 0.0305 * omega * omega, 6);
    expect(cylinder?.secondaryForceN).toBeCloseTo(((cylinder?.primaryForceN ?? 0) * 0.0305) / 0.13, 6);
    expect(cylinder?.inertiaToGasRatio ?? 0).toBeGreaterThan(0.05);
    expect(cylinder?.inertiaToGasRatio ?? 0).toBeLessThan(0.5);
    expect(cylinder?.massDefaulted).toBe(false);
  });

  it('the summary and warnings carry the brake figures; with losses the energy closure is still evaluated and passes; no gear warning without gears', () => {
    const result = execute(governed(RATED_RPM), 'simulate_motion', { duration: 0.07 });
    expect(result.summary).toMatch(
      /Brake: 30\.\d+ N·m .*BMEP 11\.24\d bar = IMEP 12\.\d+ - FMEP 1\.0\d+\), mechanical efficiency 91\.\d %/,
    );
    expect(data.engineReport?.energyClosure?.status).toBe('pass');
    expect(data.warnings.filter((warning) => /gear/.test(warning))).toEqual([]);
  });

  it('a hold-out speed is a prediction with no gas-side band (FR-FPR-78)', () => {
    const away = simulate(governed(4000), { duration: 0.1, reactions: 'peaks' });
    const accuracy = away.engineReport?.realism?.accuracy['brakeTorqueNm'];
    expect(accuracy).toMatchObject({ origin: 'predicted', band: null, validationLevel: 0 });
  });
});

describe('plausibility findings on a run (FR-FPR-76)', () => {
  it('warns FPR_UNREALISTIC for a reciprocating mass on the default density, with the band basis named', () => {
    const { doc } = calibratedEngine();
    const bodies = { ...doc.dynamics?.bodies };
    const piston = bodies['piston'];
    if (piston === undefined || doc.dynamics === undefined) throw new Error('no piston');
    const unsourced = Object.fromEntries(Object.entries(piston).filter(([key]) => key !== 'massKg')) as typeof piston;
    const defaulted: CadDocument = { ...doc, dynamics: { ...doc.dynamics, bodies: { ...bodies, piston: unsourced } } };
    const run = simulate(step(defaulted, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: RATED_RPM, maxTorque: 1e6 }).doc, {
      duration: 0.07,
    });
    const finding = run.engineReport?.realism?.plausibility.find((item) => item.quantity === 'reciprocatingMass');
    expect(finding).toMatchObject({ code: 'FPR_UNREALISTIC', status: 'warn', unit: 'kg' });
    expect(finding?.basis).toMatch(/named default/);
    expect(run.warnings.some((warning) => /FPR_UNREALISTIC: reciprocating mass/.test(warning))).toBe(true);
    expect(run.engineReport?.realism?.reciprocating[0]?.massDefaulted).toBe(true);
  });

  it('warns for a mechanical efficiency outside the named band and a Rotax-class propeller inertia outside 0.15-0.60 kg·m²', () => {
    const heavy = {
      ...{ kind: 'fmep_table' },
      points: [
        [1000, 8e5],
        [8000, 8e5],
      ],
      source: 'test: deliberately huge friction',
    };
    const { doc } = sliderCrank({ rMm: 30.5, lMm: 130, crankRpm: RATED_RPM, crankInertia: 0.2, pistonKg: 0.4, rodKg: 0.4, startDeg: 25 });
    let d = execute(doc, 'set_gravity', { gravity: [0, 0, 0] }).document;
    d = step(d, 'set_engine_losses', { crank: 'crank_j', model: heavy }).doc;
    d = step(d, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: 84,
      compressionRatio: 10.8,
      model: {
        kind: 'wiebe',
        startDeg: -15,
        durationDeg: 50,
        a: 5,
        m: 2,
        compressionIndex: 1.32,
        expansionIndex: 1.28,
        intakePressurePa: 95_000,
        heat: { kind: 'target_imep_Pa', value: 12e5 },
        source: 'test input',
      },
    }).doc;
    const disc = step(d, 'add_cylinder', { radius: 100, height: 10, axis: [0, 0, 1], position: [0, 300, 0] });
    d = step(disc.doc, 'add_rigid_body', { entityIds: [disc.id], massKg: 1, id: 'prop' }).doc;
    d = step(d, 'add_body_joint', { kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1], id: 'prop_j' }).doc;
    d = step(d, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], efficiency: 0.99 }).doc;
    d = step(d, 'add_propeller', { joint: 'prop_j', diameter: 1.7, thrustCoefficient: 0.1, powerCoefficient: 0.001, inertiaKgM2: 1.2 }).doc;
    d = step(d, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: RATED_RPM, maxTorque: 1e6 }).doc;
    const run = simulate(d, { duration: 0.07 });
    const found = run.engineReport?.realism?.plausibility ?? [];
    expect(found.find((item) => item.quantity === 'mechanicalEfficiency')).toMatchObject({ status: 'warn', band: [0.75, 0.95] });
    expect(found.find((item) => item.quantity === 'propellerInertia')).toMatchObject({ value: 1.2, band: [0.15, 0.6], unit: 'kg·m²' });
    expect(found.find((item) => item.quantity === 'propellerInertia')?.basis).toMatch(/E-R4/);
    expect(found.find((item) => item.quantity === 'propellerTorque')).toBeUndefined();
  });
});

describe('timestep halving of an engine run (FR-FPR-79, VC-FPR-33)', () => {
  const { doc } = calibratedEngine();

  it('the mean brake torque and the peak wrist-pin force change by at most 1 % between dt and dt/2', () => {
    const result = execute(doc, 'check_timestep_convergence', { cycles: 1 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as {
      status: string;
      rpm: number;
      timestepS: number;
      halfTimestepS: number;
      torqueKind: string;
      meanTorqueNm: { change: number };
      peakWristPinN: { change: number } | null;
      items: { code: string; status: string }[];
      accuracy: { meanTorqueChange: { origin: string } };
    };
    const gate = expectedCase('VC-FPR-33').value as number;
    expect(gate).toBe(0.01);
    expect(data.rpm).toBe(RATED_RPM);
    expect(data.halfTimestepS).toBeCloseTo(data.timestepS / 2, 12);
    expect(data.torqueKind).toBe('brake');
    expect(data.meanTorqueNm.change).toBeLessThanOrEqual(gate);
    expect(data.peakWristPinN?.change ?? 1).toBeLessThanOrEqual(gate);
    expect(data.status).toBe('pass');
    expect(data.items[0]).toMatchObject({ code: 'FPR_TIMESTEP_SENSITIVE', status: 'pass' });
    expect(data.accuracy.meanTorqueChange.origin).toBe('verification');
    expect(result.summary).toMatch(/check_timestep_convergence: pass/);
  });

  it('a gate tighter than the change warns FPR_TIMESTEP_SENSITIVE; the rpm may be given', () => {
    const result = execute(doc, 'check_timestep_convergence', { rpm: 5000, cycles: 1, gate: 1e-12 });
    const data = result.data as { status: string; items: { code: string; status: string; unverified?: boolean }[]; rpm: number };
    expect(data.rpm).toBe(5000);
    expect(data.status).toBe('warn');
    expect(data.items[0]).toMatchObject({ code: 'FPR_TIMESTEP_SENSITIVE', status: 'warn', unverified: true });
  });

  it('no-ops without a cylinder, without a speed, and reports not_run when the timestep cannot be halved', () => {
    const plain = sliderCrank().doc;
    expect(execute(plain, 'check_timestep_convergence', {}).summary).toMatch(/no cylinder pressure/);
    const noSpeed = calibratedEngine();
    const stripped: CadDocument = {
      ...noSpeed.doc,
      dynamics: {
        ...(noSpeed.doc.dynamics ?? { gravity: [0, 0, 0], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} }),
        cylinders: Object.fromEntries(
          Object.entries(noSpeed.doc.dynamics?.cylinders ?? {}).map(([id, cylinder]) => [
            id,
            cylinder.model.kind === 'single_zone' ? { ...cylinder, model: { ...cylinder.model, calibratedRpm: [] } } : cylinder,
          ]),
        ),
        joints: Object.fromEntries(
          Object.entries(noSpeed.doc.dynamics?.joints ?? {}).map(([id, joint]) => [id, { ...joint, initialVelocity: 0 }]),
        ),
      },
    };
    expect(execute(stripped, 'check_timestep_convergence', {}).summary).toMatch(/give `rpm`/);
  });

  it('a stored solver timestep is the dt that is halved; an open loop makes the base run fail and the item not_run, never a pass', () => {
    const stored = execute(execute(doc, 'set_dynamics_solver', { timestepS: 2e-5 }).document, 'check_timestep_convergence', { cycles: 1 });
    const data = stored.data as { timestepS: number; halfTimestepS: number };
    expect(data.timestepS).toBe(2e-5);
    expect(data.halfTimestepS).toBe(1e-5);
    const open = sliderCrank({ rMm: 30.5, lMm: 130, crankRpm: 3000, wristGapMm: 1 }).doc;
    const table = step(open, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: 84,
      compressionRatio: 10.8,
      model: {
        kind: 'table',
        points: [
          [0, 2e6],
          [720, 2e6],
        ],
        source: 'test',
      },
    }).doc;
    const refused = execute(table, 'check_timestep_convergence', {});
    const items = (refused.data as { status: string; items: { status: string; unverified?: boolean }[] }).items;
    expect(items[0]).toMatchObject({ status: 'not_run', unverified: true });
    expect((refused.data as { status: string }).status).toBe('not_run');
  });
});

describe('compare_to_reference on the Rotax ULS set (VC-FPR-31, 34)', () => {
  const { doc } = calibratedEngine();
  const withRef = execute(doc, 'add_reference_data', { preset: 'rotax_912uls_full_throttle' }).document;
  type Point = {
    rpm: number;
    simulated: number;
    reference: number;
    error: number;
    errorRel: number;
    origin: string;
    status: string;
    code: string | null;
    holdOut: boolean;
    uncertainty: { numerical: number | null; input: number | null; reference: number | null; validation: number | null; missing: string[] };
    accuracy: {
      origin: string;
      validationLevel: number;
      band: { abs: number } | null;
      comparison: { referenceId: string; s: number; d: number; e: number; uVal: number | null };
    };
  };
  type Compared = {
    status: string;
    points: Point[];
    comparison: { calibrationPoints: number; holdOutPoints: number; holdOutPassed: number; validationLevel: number; statement: string };
    numerical: { rpm: number; brakeTorqueChange: number } | null;
    items: { code: string; status: string }[];
    reviewRequired: boolean;
  };
  let result: ReturnType<typeof execute>;
  let data: Compared;
  beforeAll(() => {
    result = execute(withRef, 'compare_to_reference', { reference: 'rotax_912uls_full_throttle', engineCylinders: 4 });
    data = result.data as Compared;
  }, 120_000);

  it('compares all nine points: S, D, E, E/D, U_val, origin and status per point; the calibration point is information', () => {
    expect(result.document).toBe(withRef);
    expect(result.affected).toEqual([]);
    expect(data.points.map((point) => point.rpm)).toEqual([2500, 3000, 3500, 4000, 4500, 5000, 5100, 5500, 5800]);
    for (const point of data.points) {
      expect(point.error).toBeCloseTo(point.simulated - point.reference, 9);
      expect(point.errorRel).toBeCloseTo(point.error / point.reference, 9);
      expect(point.accuracy.comparison).toMatchObject({
        referenceId: 'rotax_912uls_full_throttle',
        s: point.simulated,
        d: point.reference,
      });
      expect(point.uncertainty.reference).toBe(1);
      expect(point.uncertainty.numerical).not.toBeNull();
      // away from the calibration point the model states no band: U_input is listed as missing, never taken as 0
      if (point.rpm === 5800) expect(point.uncertainty.input).not.toBeNull();
      else {
        expect(point.uncertainty.input).toBeNull();
        expect(point.uncertainty.missing.some((term) => term.startsWith('U_input'))).toBe(true);
      }
      expect(point.uncertainty.validation).not.toBeNull();
    }
    const rated = data.points.find((point) => point.rpm === 5800);
    expect(rated).toMatchObject({ status: 'info', origin: 'calibrated', holdOut: false, code: null });
    expect(rated?.accuracy).toMatchObject({ origin: 'calibrated', validationLevel: 1 });
    expect(Math.abs(rated?.errorRel ?? 1)).toBeLessThan(0.005);
    expect(data.reviewRequired).toBe(true);
  });

  it('hold-out points are predictions: inside ±5 % passes, outside fails FPR_REFERENCE_MISMATCH (a recorded KPI, not a model defect away from the calibration point)', () => {
    const holdOut = data.points.filter((point) => point.holdOut);
    expect(holdOut).toHaveLength(8);
    for (const point of holdOut) {
      expect(point.origin).toBe('predicted');
      const inside = Math.abs(point.errorRel) <= 0.05;
      expect(point.status).toBe(inside ? 'pass' : 'fail');
      expect(point.code).toBe(inside ? null : 'FPR_REFERENCE_MISMATCH');
    }
    expect(data.comparison.holdOutPoints).toBe(8);
    expect(data.comparison.calibrationPoints).toBe(1);
    expect(data.comparison.holdOutPassed).toBe(holdOut.filter((point) => point.status === 'pass').length);
    expect(data.comparison.validationLevel).toBeLessThanOrEqual(1);
    expect(data.status).toBe(holdOut.some((point) => point.status === 'fail') ? 'fail' : 'pass');
    expect(
      data.items.filter((item) => item.code === 'FPR_REFERENCE_MATCH').length +
        data.items.filter((item) => item.code === 'FPR_REFERENCE_MISMATCH').length,
    ).toBe(9);
  });

  it('the timestep-halving change of the brake torque at the calibration point is the U_num of every point (FR-FPR-79)', () => {
    expect(data.numerical?.rpm).toBe(5800);
    expect(data.numerical?.brakeTorqueChange ?? 1).toBeLessThan(0.01);
    const rated = data.points.find((point) => point.rpm === 5800);
    expect(rated?.uncertainty.numerical).toBeCloseTo((data.numerical?.brakeTorqueChange ?? 0) * (rated?.simulated ?? 0), 9);
    expect(result.summary).toMatch(/timestep halving at 5800 rpm changes the brake torque by/);
    expect(result.summary).toMatch(/Computed by llull, not approved/);
  });

  it("a reference built from the model's own hold-out prediction passes (round trip), and timestepHalving false lists U_num as missing", () => {
    const at4000 = data.points.find((point) => point.rpm === 4000);
    const round = execute(withRef, 'add_reference_data', {
      quantity: 'brake_torque_Nm',
      points: [{ rpm: 4000, value: at4000?.simulated ?? 0, uncertainty: 0.5 }],
      source: 'round trip of this model',
      grade: 'A',
      id: 'round',
    }).document;
    const again = execute(round, 'compare_to_reference', { reference: 'round', engineCylinders: 4, timestepHalving: false });
    const point = (again.data as { points: Point[] }).points[0];
    expect(point?.status).toBe('pass');
    expect(Math.abs(point?.errorRel ?? 1)).toBeLessThan(1e-6);
    expect(point?.uncertainty.missing.some((term) => term.startsWith('U_num'))).toBe(true);
    expect(point?.uncertainty.numerical).toBeNull();
    expect((again.data as { numerical: unknown }).numerical).toBeNull();
  });

  it('BMEP references need no cylinder scaling and the points filter narrows the run', () => {
    const bmep = execute(withRef, 'add_reference_data', {
      quantity: 'bmep_bar',
      points: [
        { rpm: 3000, value: 9.9453 },
        { rpm: 5800, value: 11.2465 },
      ],
      source: 'VC-FPR-31 values',
      grade: 'B',
      calibrationRpm: [5800],
      id: 'bmep',
    }).document;
    const narrowed = execute(bmep, 'compare_to_reference', { reference: 'bmep', points: [5800], timestepHalving: false });
    const points = (narrowed.data as { points: Point[] }).points;
    expect(points).toHaveLength(1);
    expect(points[0]?.rpm).toBe(5800);
    expect(points[0]?.reference).toBeCloseTo(11.2465, 4);
    expect(Math.abs(points[0]?.errorRel ?? 1)).toBeLessThan(0.005);
  });

  it('refuses brake references without engine losses (FPR_NO_LOSSES), unknown ids, an empty store, too many points and no cylinder', () => {
    const noLoss: CadDocument = {
      ...withRef,
      dynamics: {
        ...(withRef.dynamics ?? { gravity: [0, 0, 0], bodies: {}, joints: {}, gears: {}, motors: {}, propellers: {} }),
        losses: {},
      },
    };
    const refused = execute(noLoss, 'compare_to_reference', { reference: 'rotax_912uls_full_throttle' });
    expect(refused.affected).toEqual([]);
    expect(refused.error?.code).toBe('FPR_NO_LOSSES');
    expect(execute(withRef, 'compare_to_reference', { reference: 'ghost' }).summary).toMatch(/reference 'ghost' not found/);
    expect(execute(doc, 'compare_to_reference', { reference: 'all' }).summary).toMatch(/no reference data/);
    expect(execute(withRef, 'compare_to_reference', { reference: 'all', points: [123456] }).summary).toMatch(/no reference point matches/);
    const many = execute(withRef, 'add_reference_data', { preset: 'rotax_912is_power_table' }).document;
    const over = execute(many, 'compare_to_reference', { reference: 'all' });
    expect(over.error?.code).toBe('FPR_BUDGET_EXCEEDED');
    const plain = execute(sliderCrank().doc, 'add_reference_data', { preset: 'rotax_912uls_full_throttle' }).document;
    expect(execute(plain, 'compare_to_reference', { reference: 'all' }).summary).toMatch(/no cylinder pressure/);
  });

  it('a quantity the model cannot produce (bsfc) is a not_run item, never a pass; a reference without rpm is refused per point', () => {
    const bsfc = execute(withRef, 'add_reference_data', {
      quantity: 'bsfc_g_per_kWh',
      points: [{ rpm: 5500, value: 285 }],
      source: 'OM-912 fuel table',
      id: 'bsfc',
    }).document;
    const run = execute(bsfc, 'compare_to_reference', { reference: 'bsfc', timestepHalving: false });
    const items = (run.data as { items: { status: string; unverified?: boolean; code: string }[]; status: string }).items;
    expect(items[0]).toMatchObject({ status: 'not_run', unverified: true });
    expect((run.data as { status: string }).status).toBe('not_run');
    const noRpm = execute(withRef, 'add_reference_data', {
      quantity: 'brake_power_kW',
      points: [{ value: 70 }],
      source: 's',
      id: 'norpm',
    }).document;
    const bad = execute(noRpm, 'compare_to_reference', { reference: 'norpm', timestepHalving: false });
    expect((bad.data as { items: { status: string }[] }).items[0]?.status).toBe('not_run');
  });

  it('is read-only and deterministic: the same input gives the same data', () => {
    const [first, second] = [
      execute(withRef, 'compare_to_reference', {
        reference: 'rotax_912uls_full_throttle',
        engineCylinders: 4,
        points: [3500],
        timestepHalving: false,
      }),
      execute(withRef, 'compare_to_reference', {
        reference: 'rotax_912uls_full_throttle',
        engineCylinders: 4,
        points: [3500],
        timestepHalving: false,
      }),
    ];
    expect(first.data).toEqual(second.data);
    expect(first.document).toBe(withRef);
  });
});

describe('free equilibrium against a propeller (static_rpm, propeller_rpm; VC-FPR-32 machinery)', () => {
  /** Light-flywheel single cylinder with a propeller sized so the engine settles near 5300 rpm; optionally behind the 21/51 reduction. */
  function installed(geared: boolean): CadDocument {
    const { doc } = sliderCrank({ rMm: 30.5, lMm: 130, crankRpm: 5450, crankInertia: 0.02, pistonKg: 0.4, rodKg: 0.4, startDeg: 25 });
    let d = execute(doc, 'set_gravity', { gravity: [0, 0, 0] }).document;
    d = step(d, 'set_engine_losses', {
      crank: 'crank_j',
      model: { kind: 'chen_flynn', aPa: 40_000, bRatio: 0.005, cPaPerRpm: 5, dPaPerRpm2: 1.5e-6, source: 'test input' },
    }).doc;
    d = step(d, 'add_cylinder_pressure', {
      piston: 'slide_j',
      crank: 'crank_j',
      boreMm: 84,
      compressionRatio: 10.8,
      model: {
        kind: 'single_zone',
        burn: { ca50Deg: 9, durationDeg: 50, a: 5, m: 2 },
        intakePressurePa: 95_000,
        intakeTempK: 330,
        heat: { kind: 'calibrate_brake', brake: [{ rpm: 5800, brakeTorqueNm: 30.25 }], cylinderCount: 1 },
        source: 'test input',
      },
    }).doc;
    if (!geared) return step(d, 'add_propeller', { joint: 'crank_j', diameter: 0.808, thrustCoefficient: 0.1, powerCoefficient: 0.06 }).doc;
    const disc = step(d, 'add_cylinder', { radius: 100, height: 10, axis: [0, 0, 1], position: [0, 300, 0] });
    d = step(disc.doc, 'add_rigid_body', { entityIds: [disc.id], massKg: 0.5, id: 'prop' }).doc;
    d = step(d, 'add_body_joint', { kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1], id: 'prop_j' }).doc;
    d = step(d, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], efficiency: 0.99 }).doc;
    return step(d, 'add_propeller', { joint: 'prop_j', diameter: 1.36, thrustCoefficient: 0.1, powerCoefficient: 0.06 }).doc;
  }

  it('the settled static rpm is read against the 5100-5800 rpm window; a window it misses fails with the distance (E)', () => {
    const doc = execute(installed(false), 'add_reference_data', { preset: 'rotax_912_static_rpm_window' }).document;
    const run = execute(doc, 'compare_to_reference', { reference: 'rotax_912_static_rpm_window', durationS: 1 });
    const data = run.data as {
      points: { simulated: number; status: string; error: number; span: { min: number; max: number } }[];
      items: { code: string; status: string }[];
    };
    const point = data.points[0];
    expect(point?.simulated ?? 0).toBeGreaterThan(5000);
    expect(point?.simulated ?? 0).toBeLessThan(5900);
    expect(point?.span).toEqual({ min: 5100, max: 5800 });
    expect(point?.status).toBe(point?.error === 0 ? 'pass' : 'fail');
    const narrow = execute(doc, 'add_reference_data', {
      quantity: 'static_rpm',
      points: [{ value: 7000, min: 6900, max: 7100 }],
      source: 'synthetic window',
      grade: 'A',
      id: 'narrow',
    }).document;
    const missed = execute(narrow, 'compare_to_reference', { reference: 'narrow', durationS: 1 });
    const miss = (missed.data as { points: { status: string; error: number; code: string }[] }).points[0];
    expect(miss).toMatchObject({ status: 'fail', code: 'FPR_REFERENCE_MISMATCH' });
    expect(miss?.error ?? 0).toBeLessThan(-1000);
  });

  it('propeller_rpm is the crank equilibrium through the reduction; a missing propeller or an uncoupled one is a not_run item', () => {
    const geared = execute(installed(true), 'add_reference_data', {
      quantity: 'propeller_rpm',
      points: [{ value: 2300 }],
      source: 'synthetic',
      id: 'prop',
    }).document;
    const run = execute(geared, 'compare_to_reference', { reference: 'prop', durationS: 0.8 });
    const point = (run.data as { points: { simulated: number }[] }).points[0];
    expect(point?.simulated ?? 0).toBeGreaterThan(1800);
    expect(point?.simulated ?? 0).toBeLessThan(2600);
    const noProp = execute(calibratedEngine().doc, 'add_reference_data', { preset: 'rotax_912_static_rpm_window' }).document;
    const none = execute(noProp, 'compare_to_reference', { reference: 'all' });
    expect((none.data as { items: { status: string }[] }).items[0]?.status).toBe('not_run');
    const loose = execute(installed(false), 'add_reference_data', {
      quantity: 'propeller_rpm',
      points: [{ value: 2300 }],
      source: 'synthetic',
      id: 'loose',
    }).document;
    const direct = execute(loose, 'compare_to_reference', { reference: 'loose', durationS: 0.5 });
    expect((direct.data as { points: { simulated: number }[] }).points[0]?.simulated ?? 0).toBeGreaterThan(4000);
  });
});
